import {
  captionTitle,
  type ImportError,
  type ImportedPhoto,
  type ImportedRecipe,
  type ImportSource,
  imageType,
  importedFromCaption,
  importedFromPage,
  instagramTitle,
  type Llm,
  LlmError,
  linkOnlyRecipe,
  normaliseUrl,
  pageRevision,
  readRecipePage,
  tiktokHandle,
  type VideoLink,
  videoLinkOf,
} from "@mise/domain";
import * as Sentry from "@sentry/cloudflare";
import { z } from "zod";
import { storedRevision } from "./imports";

type Fetch = typeof fetch;

let replacement: Fetch | undefined;

/**
 * Makes link imports fetch with `fetcher` from their next request, or the Worker's `fetch` again
 * with `undefined`. Tests serve a pretend web this way, so no test fetches a real page.
 */
export function useFetch(fetcher: Fetch | undefined): void {
  replacement = fetcher;
}

/** The largest page and photo read; anything bigger is not a recipe page Mise can use. */
const MAX_PAGE_BYTES = 5 * 1024 * 1024;
const MAX_PHOTO_BYTES = 10 * 1024 * 1024;
const MAX_OEMBED_BYTES = 1024 * 1024;
const TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 5;
const USER_AGENT = "Mise/1.0 (family meal planner; +https://github.com/nuntz/mise)";

/** The revision of a link-only Draft whose page could not be fetched, or that the model failed to read. */
const UNFETCHED = "unfetched";
const UNREAD = "unread";
/**
 * The revision of a link-only Draft of a TikTok whose oEmbed answer has no caption, as TikTok's have
 * none today (October 2026): asked again each time it is shared, in case one comes back.
 */
const UNCAPTIONED = "uncaptioned";
/** The revision of a link-only Draft of a link that is never read: an Instagram link, or a TikTok that is no video. */
const UNREADABLE = "unreadable";

/**
 * What importing a link makes, and from which source: its Recipe (a Draft when the model read it, or
 * link-only), the photo to fetch for it, and what could not be read.
 */
export type LinkReading = {
  source: Extract<ImportSource, "url" | "tiktok" | "instagram">;
  recipe: ImportedRecipe;
  draft: boolean;
  image: string | null;
  errors: ImportError[];
};

/**
 * What TikTok's oEmbed says of a video: its caption (`title`), author and thumbnail, as it documents
 * them. Its answers today carry none of them, only a player to embed.
 */
const TikTokOembed = z.object({
  title: z.string().nullish().catch(null),
  author_name: z.string().nullish().catch(null),
  thumbnail_url: z
    .url({ protocol: /^https?$/ })
    .nullish()
    .catch(null),
});

/**
 * Fetches `link` and reads it: a schema.org Recipe as it is; else the page's text by the model,
 * unless the page is unchanged since it was last read; else a link-only Draft. A link-only reading
 * of a link already imported keeps what was read before (it is skipped), so a page that blocks Mise
 * today never empties its Recipe. Upserts on the canonical URL, or on the URL an earlier import of
 * this link used, so that a link-only Draft is updated once its page can be read.
 */
export async function readLink(sql: SqlStorage, link: string, llm: Llm): Promise<LinkReading> {
  const video = videoLinkOf(link);
  if (video?.site === "instagram") {
    const reading = linkOnlyReading(sql, "instagram", link, video.url, instagramTitle(video.url), UNREADABLE);
    return reading(null, "Mise can't read Instagram posts: add screenshots or the caption");
  }
  if (video) return readTikTok(sql, link, video, llm);
  const given = normaliseUrl(link);
  const fetched = await fetchPage(link);
  const linkOnly = (url: string, title: string | null, revision: string, image: string | null, message: string) =>
    linkOnlyReading(sql, "url", link, url, title, revision)(image, message);
  if (!fetched.ok) return linkOnly(knownUrl(sql, [given]), null, UNFETCHED, null, fetched.error);

  const read = readRecipePage(fetched.html, fetched.url);
  const url = knownUrl(sql, [read.url, normaliseUrl(fetched.url), given]);
  const page = { ...read, url };
  if (page.recipe) {
    const recipe = { ...page.recipe, externalId: url, url };
    return { source: "url", recipe, draft: false, image: page.image, errors: [] };
  }
  const revision = pageRevision(page);
  // Unchanged since the model last read it: skipped, without asking it again.
  if (storedRevision(sql, "url", url) === revision)
    return { source: "url", recipe: linkOnlyRecipe(url, page.title, revision), draft: true, image: null, errors: [] };
  if (!page.text) return linkOnly(url, page.title, revision, page.image, "The page has no text to read");
  try {
    const reading = await llm.readRecipe({ text: page.text });
    if (!reading.isRecipe) return linkOnly(url, page.title, revision, page.image, "The page holds no recipe");
    return { source: "url", recipe: importedFromPage(page, reading), draft: true, image: page.image, errors: [] };
  } catch (error) {
    if (!(error instanceof LlmError)) throw error;
    // The import says only that the model failed; the deployer finds why in Sentry.
    Sentry.captureException(error);
    return linkOnly(url, page.title, UNREAD, page.image, error.message);
  }
}

/**
 * Reads a TikTok video from its oEmbed caption and thumbnail: the model reads the caption into a
 * Draft; a caption with no recipe, or one that can't be had or read, leaves a link-only Draft. A
 * short link is followed to its video first. The video's URL is the revision, so a video read once is
 * skipped without asking TikTok again; a link-only Draft of a video TikTok or the model failed on is
 * read again next time.
 */
async function readTikTok(
  sql: SqlStorage,
  link: string,
  video: VideoLink & { site: "tiktok" },
  llm: Llm,
): Promise<LinkReading> {
  let url = video.video;
  if (!url && video.short) {
    const followed = await follow(link, "text/html");
    if (!followed.ok) {
      return linkOnlyReading(
        sql,
        "tiktok",
        link,
        normaliseUrl(link),
        null,
        UNFETCHED,
      )(null, `The link ${followed.error}`);
    }
    await followed.response.body?.cancel();
    const followedTo = videoLinkOf(followed.url);
    url = followedTo?.site === "tiktok" ? followedTo.video : null;
  }
  if (!url) {
    const reading = linkOnlyReading(sql, "tiktok", link, normaliseUrl(link), "TikTok link", UNREADABLE);
    return reading(null, "The link is not a TikTok video");
  }
  if (storedRevision(sql, "tiktok", url) === url) {
    return { source: "tiktok", recipe: linkOnlyRecipe(url, null, url), draft: true, image: null, errors: [] };
  }
  const handle = tiktokHandle(url);
  const fetched = await get(
    `https://www.tiktok.com/oembed?url=${encodeURIComponent(url)}`,
    "application/json",
    MAX_OEMBED_BYTES,
  );
  let oembed: z.infer<typeof TikTokOembed> | null = null;
  if (fetched.ok) {
    try {
      oembed = TikTokOembed.parse(JSON.parse(new TextDecoder().decode(fetched.body)));
    } catch {}
  }
  if (!oembed) {
    const reading = linkOnlyReading(sql, "tiktok", link, url, captionTitle("", handle), UNFETCHED);
    return reading(null, fetched.ok ? "The video's caption could not be read" : `The video's caption ${fetched.error}`);
  }
  const caption = oembed.title?.trim() ?? "";
  const author = oembed.author_name ?? handle;
  const linkOnly = (revision: string, message: string) =>
    linkOnlyReading(
      sql,
      "tiktok",
      link,
      url,
      captionTitle(caption, author),
      revision,
    )(oembed.thumbnail_url ?? null, message);
  if (!caption) {
    return linkOnly(
      UNCAPTIONED,
      "TikTok doesn't share this video's caption with Mise: add screenshots or paste the caption",
    );
  }
  try {
    const reading = await llm.readRecipe({ text: caption });
    if (!reading.isRecipe) return linkOnly(url, "The caption holds no recipe");
    const recipe = importedFromCaption(url, caption, author, reading);
    return { source: "tiktok", recipe, draft: true, image: oembed.thumbnail_url ?? null, errors: [] };
  } catch (error) {
    if (!(error instanceof LlmError)) throw error;
    Sentry.captureException(error);
    return linkOnly(UNREAD, error.message);
  }
}

/**
 * A link-only reading of `url`, given as `link`: what was read before, if the link was imported
 * already (so a link that can't be read today never empties its Recipe), else a link-only Draft at
 * `revision`; with why it is link-only.
 */
function linkOnlyReading(
  sql: SqlStorage,
  source: LinkReading["source"],
  link: string,
  url: string,
  title: string | null,
  revision: string,
) {
  return (image: string | null, message: string): LinkReading => ({
    source,
    recipe: linkOnlyRecipe(url, title, storedRevision(sql, source, url) ?? revision),
    draft: true,
    image,
    errors: [{ entry: link, message }],
  });
}

/** The first of `urls` a link import already used, else the first: the page's canonical URL. */
function knownUrl(sql: SqlStorage, urls: string[]): string {
  return urls.find((url) => storedRevision(sql, "url", url) !== undefined) ?? (urls[0] as string);
}

/** A fetched body; or why not, as the end of a sentence ("was refused by its site (HTTP 403)"). */
type Fetched = { ok: true; url: string; body: Uint8Array; type: string } | { ok: false; error: string };

/** A page's HTML, decoded, and the URL it was fetched from after redirects. */
async function fetchPage(url: string): Promise<{ ok: true; url: string; html: string } | { ok: false; error: string }> {
  const fetched = await get(url, "text/html,application/xhtml+xml", MAX_PAGE_BYTES);
  if (!fetched.ok) return { ok: false, error: `The page ${fetched.error}` };
  if (fetched.type && !/html/i.test(fetched.type)) return { ok: false, error: "The link is not a web page" };
  const charset = /charset=["']?([\w-]+)/i.exec(fetched.type)?.[1] ?? "utf-8";
  let decoder: TextDecoder;
  try {
    decoder = new TextDecoder(charset);
  } catch {
    decoder = new TextDecoder();
  }
  return { ok: true, url: fetched.url, html: decoder.decode(fetched.body) };
}

/** A Recipe's photo, recognised from its bytes; or why it can't be used. */
export async function fetchPhoto(url: string): Promise<ImportedPhoto | { error: string }> {
  const fetched = await get(url, "image/*", MAX_PHOTO_BYTES);
  if (!fetched.ok) return { error: `The photo ${fetched.error}` };
  const bytes = new Uint8Array(fetched.body);
  const type = imageType(bytes);
  return type ? { bytes, type } : { error: "The photo is not a JPEG, PNG, WebP, GIF or AVIF image" };
}

/**
 * GETs `url`, following redirects itself so that each hop stays on http(s) and the final URL is
 * known; gives up after `TIMEOUT_MS`. Never throws: every failure is a reason. The response may be
 * any status but a redirect, and its body is the caller's to read or cancel.
 */
async function follow(
  url: string,
  accept: string,
): Promise<{ ok: true; url: string; response: Response } | { ok: false; error: string }> {
  const fetcher = replacement ?? fetch;
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    let response: Response;
    try {
      response = await fetcher(current, {
        headers: { Accept: accept, "User-Agent": USER_AGENT },
        redirect: "manual",
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      return { ok: false, error: "could not be reached" };
    }
    const location = response.headers.get("Location");
    if (response.status >= 300 && response.status < 400 && location) {
      await response.body?.cancel();
      const next = URL.parse(location, current);
      if (next?.protocol !== "https:" && next?.protocol !== "http:") {
        return { ok: false, error: "redirects to something that is not on the web" };
      }
      current = next.toString();
      continue;
    }
    return { ok: true, url: current, response };
  }
  return { ok: false, error: "redirects too many times" };
}

/** GETs `url` as `follow` does, and reads its body; refuses one over `maxBytes`, or a refusal. */
async function get(url: string, accept: string, maxBytes: number): Promise<Fetched> {
  const followed = await follow(url, accept);
  if (!followed.ok) return followed;
  const { response } = followed;
  if (!response.ok) {
    await response.body?.cancel();
    return { ok: false, error: `was refused by its site (HTTP ${response.status})` };
  }
  let body: Uint8Array | null;
  try {
    body = await readAtMost(response, maxBytes);
  } catch {
    // The connection dropped, or the timeout ran out, part-way through.
    return { ok: false, error: "could not be read to the end" };
  }
  if (!body) return { ok: false, error: `is larger than ${maxBytes / 1024 / 1024} MB` };
  return { ok: true, url: followed.url, body, type: response.headers.get("Content-Type") ?? "" };
}

/** The response's body, or null once it grows past `maxBytes`. */
async function readAtMost(response: Response, maxBytes: number): Promise<Uint8Array | null> {
  if (Number(response.headers.get("Content-Length")) > maxBytes) {
    await response.body?.cancel();
    return null;
  }
  if (!response.body) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = response.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}
