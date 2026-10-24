import {
  type ImportError,
  type ImportedPhoto,
  type ImportedRecipe,
  imageType,
  importedFromPage,
  type Llm,
  LlmError,
  linkOnlyRecipe,
  normaliseUrl,
  pageRevision,
  readRecipePage,
} from "@mise/domain";
import * as Sentry from "@sentry/cloudflare";
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
const TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 5;
const USER_AGENT = "Mise/1.0 (family meal planner; +https://github.com/nuntz/mise)";

/** The revision of a link-only Draft whose page could not be fetched, or that the model failed to read. */
const UNFETCHED = "unfetched";
const UNREAD = "unread";

/**
 * What importing a link makes: its Recipe (a Draft when the model read it, or link-only), the photo
 * to fetch for it, and what could not be read.
 */
export type LinkReading = { recipe: ImportedRecipe; draft: boolean; image: string | null; errors: ImportError[] };

/**
 * Fetches `link` and reads it: a schema.org Recipe as it is; else the page's text by the model,
 * unless the page is unchanged since it was last read; else a link-only Draft. A link-only reading
 * of a link already imported keeps what was read before (it is skipped), so a page that blocks Mise
 * today never empties its Recipe. Upserts on the canonical URL, or on the URL an earlier import of
 * this link used, so that a link-only Draft is updated once its page can be read.
 */
export async function readLink(sql: SqlStorage, link: string, llm: Llm): Promise<LinkReading> {
  const given = normaliseUrl(link);
  const fetched = await fetchPage(link);
  const linkOnly = (url: string, title: string | null, revision: string, image: string | null, message: string) => ({
    recipe: linkOnlyRecipe(url, title, storedRevision(sql, "url", url) ?? revision),
    draft: true,
    image,
    errors: [{ entry: link, message }],
  });
  if (!fetched.ok) return linkOnly(knownUrl(sql, [given]), null, UNFETCHED, null, fetched.error);

  const read = readRecipePage(fetched.html, fetched.url);
  const url = knownUrl(sql, [read.url, normaliseUrl(fetched.url), given]);
  const page = { ...read, url };
  if (page.recipe) {
    return { recipe: { ...page.recipe, externalId: url, url }, draft: false, image: page.image, errors: [] };
  }
  const revision = pageRevision(page);
  // Unchanged since the model last read it: skipped, without asking it again.
  if (storedRevision(sql, "url", url) === revision)
    return { recipe: linkOnlyRecipe(url, page.title, revision), draft: true, image: null, errors: [] };
  if (!page.text) return linkOnly(url, page.title, revision, page.image, "The page has no text to read");
  try {
    const reading = await llm.readRecipe({ text: page.text });
    if (!reading.isRecipe) return linkOnly(url, page.title, revision, page.image, "The page holds no recipe");
    return { recipe: importedFromPage(page, reading), draft: true, image: page.image, errors: [] };
  } catch (error) {
    if (!(error instanceof LlmError)) throw error;
    // The import says only that the model failed; the deployer finds why in Sentry.
    Sentry.captureException(error);
    return linkOnly(url, page.title, UNREAD, page.image, error.message);
  }
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
 * known; refuses a body over `maxBytes`, and gives up after `TIMEOUT_MS`. Never throws: every
 * failure is a reason.
 */
async function get(url: string, accept: string, maxBytes: number): Promise<Fetched> {
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
    return { ok: true, url: current, body, type: response.headers.get("Content-Type") ?? "" };
  }
  return { ok: false, error: "redirects too many times" };
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
