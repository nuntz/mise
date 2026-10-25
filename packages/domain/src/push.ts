import { z } from "zod";
import type { Locale } from "./household";
import type { RecipeId } from "./recipes";
import { addDays, type LocalDate, type Week, type WeekCalendar, weekOf } from "./weeks";

/** How many days before a Week starts Mise proposes it, if nobody has started it. */
export const PROPOSAL_DAYS_AHEAD = 2;

/**
 * The Week Mise proposes on `today`: the one starting two days later, if a Week starts then by the
 * Household's calendar as it is now, so a change of week start moves the day (ADR 0021). Null on
 * every other day.
 */
export function proposalWeekOn(today: LocalDate, calendar: WeekCalendar): LocalDate | null {
  const start = addDays(today, PROPOSAL_DAYS_AHEAD);
  return weekOf(start, calendar).startDate === start ? start : null;
}

/** The Household-local time the morning's notifications go out, the weekly proposal's among them. */
export const MORNING_PUSH_TIME = "08:00";

/**
 * What a notification is about; a device turns each on or off. A weekly proposal, a Check-in due, a
 * Prep-ahead note for tomorrow, something waiting on the review screen, an Import Flag a Drive sync raised.
 */
export const PUSH_KINDS = ["weekly_proposal", "checkin_due", "prep_ahead", "review_waiting", "drive_flagged"] as const;
export const PushKind = z.enum(PUSH_KINDS);
export type PushKind = z.infer<typeof PushKind>;

/** Where a device's push service takes its notifications: the URL the browser was given. */
export const PushEndpoint = z.url({ protocol: /^https$/ }).max(2048);

/** Base64url, as the browser gives a subscription's keys, with or without padding. */
const base64Url = (bytes: number) =>
  z
    .string()
    .regex(new RegExp(`^[A-Za-z0-9_-]{${Math.ceil((bytes * 4) / 3)}}=*$`), `Expected ${bytes} bytes, base64url`);

/** A device's push subscription, as `PushSubscription.toJSON()` gives it: its endpoint and keys. */
export const PushSubscriptionJson = z.object({
  endpoint: PushEndpoint,
  /** The device's P-256 public key (uncompressed, 65 bytes) and its 16-byte auth secret (RFC 8291). */
  keys: z.object({ p256dh: base64Url(65), auth: base64Url(16) }),
});
export type PushSubscriptionJson = z.infer<typeof PushSubscriptionJson>;

const Kinds = z
  .array(PushKind)
  .max(PUSH_KINDS.length * 2)
  .transform((kinds) => PUSH_KINDS.filter((kind) => kinds.includes(kind)));

/**
 * Turns notifications on for a device, or changes which kinds it gets: keyed by its endpoint, so a
 * device subscribing again replaces what it had.
 */
export const SubscribePushInput = z
  .object({ endpoint: PushEndpoint, keys: PushSubscriptionJson.shape.keys, kinds: Kinds })
  .strict();

export const PushDeviceInput = z.object({ endpoint: PushEndpoint }).strict();

/** A device that gets notifications, and the kinds it gets. */
export const PushDevice = z.object({ endpoint: PushEndpoint, kinds: z.array(PushKind) });
export type PushDevice = z.infer<typeof PushDevice>;

/** The deployment's VAPID public key (RFC 8292), base64url, which a device subscribes with. */
export const PushKey = z.object({ publicKey: z.string().min(1) });
export type PushKey = z.infer<typeof PushKey>;

/** What a device shows, and the page a tap on it opens; one of a kind replaces the last. */
export const PushMessage = z.object({
  kind: PushKind,
  title: z.string(),
  body: z.string(),
  /** A path in the app, such as `/?review`. */
  url: z.string().startsWith("/"),
});
export type PushMessage = z.infer<typeof PushMessage>;

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/** That Mise proposed the Week; null when it planned no dinner, having no Recipe to propose. */
export function proposedMessage(week: Week, locale: Locale): PushMessage | null {
  const planned = week.slots.filter((slot) => slot.meal === "dinner" && slot.kind === "recipe").length;
  if (planned === 0) return null;
  const from = new Date(`${week.startDate}T12:00:00Z`).toLocaleDateString(locale, {
    weekday: "long",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });
  return {
    kind: "weekly_proposal",
    title: "Next week is proposed",
    body: `${plural(planned, "dinner", "dinners")} from ${from}. Review it before you shop.`,
    url: "/?week=next",
  };
}

/** That a Check-in is due, for `due` Staples. */
export function checkInMessage(due: number): PushMessage {
  return {
    kind: "checkin_due",
    title: `Pantry check: ${plural(due, "Staple", "Staples")}`,
    body: "See what's running low before the Grocery List is built.",
    url: "/?pantry",
  };
}

/** Tomorrow's dinner's Prep-ahead note. */
export function prepAheadMessage(recipe: { id: RecipeId; title: string }, note: string): PushMessage {
  return { kind: "prep_ahead", title: `For tomorrow: ${recipe.title}`, body: note, url: `/?recipe=${recipe.id}` };
}

/** What waits on the review screen now; null when nothing does. */
export function reviewMessage({ drafts, suggestions }: { drafts: number; suggestions: number }): PushMessage | null {
  const waiting = [
    ...(drafts > 0 ? [plural(drafts, "Draft Recipe", "Draft Recipes")] : []),
    ...(suggestions > 0 ? [plural(suggestions, "Suggestion", "Suggestions")] : []),
  ];
  if (waiting.length === 0) return null;
  return { kind: "review_waiting", title: "Waiting for review", body: `${waiting.join(" and ")}.`, url: "/?review" };
}

/** That a Drive sync raised Import Flags. */
export function driveFlaggedMessage(flagged: number): PushMessage {
  return {
    kind: "drive_flagged",
    title: `Drive sync flagged ${plural(flagged, "Recipe", "Recipes")}`,
    body: "Changed in Drive after being edited in Mise, or like a Recipe already kept. Look them over.",
    url: "/?review",
  };
}
