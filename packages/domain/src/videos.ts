import { type ImportedRecipe, importedFromReading, MAX_PASTED_TEXT } from "./imports";
import type { RecipeReading } from "./llm";
import { normaliseUrl } from "./pages";

/**
 * A link to a video site that is not read as a page. A TikTok video is read from its oEmbed
 * caption, at its canonical URL (`video`), null for any other TikTok link: a `short` link to follow
 * first, or a profile. An Instagram link is kept link-only, since Instagram's oEmbed needs Meta's
 * app review (SPEC §4.2).
 */
export type VideoLink = { site: "tiktok"; video: string | null; short: boolean } | { site: "instagram"; url: string };

/** The video site `link` is on, or null for a link to read as a page. */
export function videoLinkOf(link: string): VideoLink | null {
  const url = new URL(link);
  const host = url.hostname.toLowerCase();
  if (host === "tiktok.com" || host.endsWith(".tiktok.com")) {
    const video = /^\/@([^/]+)\/video\/(\d+)\/?$/.exec(url.pathname);
    return {
      site: "tiktok",
      video: video ? `https://www.tiktok.com/@${video[1]}/video/${video[2]}` : null,
      short: /^v[mt]\./.test(host) || url.pathname.startsWith("/t/"),
    };
  }
  if (host === "instagram.com" || host.endsWith(".instagram.com") || host === "instagr.am") {
    const post = /^\/(p|reels?|tv)\/([\w-]+)\/?$/.exec(url.pathname);
    if (post) return { site: "instagram", url: `https://www.instagram.com/${post[1]}/${post[2]}/` };
    const page = new URL(normaliseUrl(link));
    page.hostname = "www.instagram.com";
    return { site: "instagram", url: page.toString() };
  }
  return null;
}

/** A title for a link-only Draft of an Instagram link: what it links to. */
export function instagramTitle(url: string): string {
  const kind = /^\/(p|reels?|tv)\//.exec(new URL(url).pathname)?.[1];
  if (kind === "p") return "Instagram post";
  if (kind === "tv") return "Instagram video";
  return kind ? "Instagram reel" : "Instagram link";
}

/** The account a TikTok video's URL names ("cook.example"), else null. */
export function tiktokHandle(url: string): string | null {
  return /^\/@([^/]+)\//.exec(new URL(url).pathname)?.[1] ?? null;
}

/**
 * The Draft the model read from a TikTok video's caption, upserted on the video's URL, which is
 * also its revision (SPEC §4.2): a video read once is not read again. The caption goes in its notes,
 * as pasted text does, so a person can check the reading against it.
 */
export function importedFromCaption(
  video: string,
  caption: string,
  author: string | null,
  reading: Extract<RecipeReading, { isRecipe: true }>,
): ImportedRecipe {
  const recipe = importedFromReading(reading, {
    externalId: video,
    revision: video,
    notes: caption.slice(0, MAX_PASTED_TEXT),
    url: video,
  });
  return { ...recipe, author: author?.slice(0, 200) || null };
}

/** The longest title made of a caption, before its ellipsis. */
const MAX_CAPTION_TITLE = 100;

/**
 * A title for a video, for a link-only Draft: its caption's first line, without hashtags or
 * mentions, cut at a word; else named by its author.
 */
export function captionTitle(caption: string, author: string | null): string {
  const line = (caption.split("\n").find((part) => part.trim() !== "") ?? "")
    .replace(/[#@][\p{L}\p{N}_.]+/gu, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!/[\p{L}\p{N}]/u.test(line)) return author ? `TikTok video by ${author}` : "TikTok video";
  if (line.length <= MAX_CAPTION_TITLE) return line;
  const cut = line.slice(0, MAX_CAPTION_TITLE + 1);
  const atWord = cut.lastIndexOf(" ");
  return `${(atWord > 0 ? cut.slice(0, atWord) : cut.slice(0, MAX_CAPTION_TITLE)).trimEnd()}…`;
}
