import { z } from "zod";
import { StoreSection } from "./items";
import { Member, NewMember } from "./members";

export const WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"] as const;

export const Weekday = z.enum(WEEKDAYS);
export type Weekday = z.infer<typeof Weekday>;

export const UNITS = ["metric", "imperial"] as const;
export const Units = z.enum(UNITS);
export type Units = z.infer<typeof Units>;

export const LOCALES = ["en-CA"] as const;
export const Locale = z.enum(LOCALES);
export type Locale = z.infer<typeof Locale>;

/** An IANA timezone name the runtime recognises, such as America/Vancouver, stored in its canonical spelling. */
export const Timezone = z.string().transform((name, ctx) => {
  const canonical = canonicalTimezone(name);
  if (canonical) return canonical;
  ctx.addIssue({ code: "custom", message: "Unknown IANA timezone" });
  return z.NEVER;
});

/** A local wall-clock time, HH:MM in 24-hour form. */
export const LocalTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Expected HH:MM");

/** The most voice time a Household may use in a day, in whole minutes: up to four hours, or none. */
export const VoiceMinutes = z.number().int().min(0).max(240);

/** How the Household runs its kitchen: everything about it except its Members. */
export const HouseholdSettings = z.object({
  name: z.string().trim().min(1).max(100),
  timezone: Timezone,
  dinnerTime: LocalTime,
  weekStartsOn: Weekday,
  units: Units,
  locale: Locale,
  /** The daily voice cap: minutes of Voice Session a Household local day may use. */
  voiceMinutesPerDay: VoiceMinutes,
});
export type HouseholdSettings = z.infer<typeof HouseholdSettings>;

/** Cooking time, in minutes, up to a day. */
export const Minutes = z
  .number()
  .int()
  .min(0)
  .max(24 * 60);

/** The most cooking time wanted for each weekday's dinner. */
export const EffortBudgets = z.record(Weekday, Minutes);
export type EffortBudgets = z.infer<typeof EffortBudgets>;

/** Until the Household changes them: quick weeknights, longer weekends. */
export const DEFAULT_EFFORT_BUDGETS: EffortBudgets = {
  monday: 45,
  tuesday: 45,
  wednesday: 45,
  thursday: 45,
  friday: 60,
  saturday: 120,
  sunday: 90,
};

/**
 * A change of the Household's week start (ADR 0021): Weeks start on the weekday of `from`, from
 * `from` on. The Week that starts on `stretches`, on the old start day, runs on until the day before.
 */
export const WeekStartChange = z.object({ from: z.iso.date(), stretches: z.iso.date() });
export type WeekStartChange = z.infer<typeof WeekStartChange>;

export const Household = HouseholdSettings.extend({
  /** Every change of week start, oldest first; `weekStartsOn` is the day Weeks start on since the last. */
  weekStartChanges: z.array(WeekStartChange),
  members: z.array(Member),
  /** Its default Effort Budgets; a Week can override them. */
  effortBudgets: EffortBudgets,
  /** Every Store Section, in the order the Household walks its store. */
  storeSections: z.array(StoreSection),
});
export type Household = z.infer<typeof Household>;

export const HOUSEHOLD_DEFAULTS = {
  timezone: "America/Vancouver",
  dinnerTime: "18:00",
  weekStartsOn: "monday",
  units: "metric",
  locale: "en-CA",
  voiceMinutesPerDay: 30,
} as const satisfies Omit<HouseholdSettings, "name">;

/** First-run setup: the settings, with defaults, and any Members known so far. */
export const SetupHouseholdInput = HouseholdSettings.extend({
  timezone: Timezone.default(HOUSEHOLD_DEFAULTS.timezone),
  dinnerTime: LocalTime.default(HOUSEHOLD_DEFAULTS.dinnerTime),
  weekStartsOn: Weekday.default(HOUSEHOLD_DEFAULTS.weekStartsOn),
  units: Units.default(HOUSEHOLD_DEFAULTS.units),
  locale: Locale.default(HOUSEHOLD_DEFAULTS.locale),
  voiceMinutesPerDay: VoiceMinutes.default(HOUSEHOLD_DEFAULTS.voiceMinutesPerDay),
  members: z.array(NewMember).max(50).default([]),
}).strict();

/** Changes the settings given; the rest stay as they are. A new week start applies from the next Week (ADR 0021). */
export const UpdateHouseholdSettingsInput = HouseholdSettings.partial().strict();

/** Changes the default Effort Budgets of the weekdays given. */
export const SetEffortBudgetsInput = z.object({ budgets: z.partialRecord(Weekday, Minutes) }).strict();

function canonicalTimezone(name: string): string | undefined {
  try {
    return new Intl.DateTimeFormat("en", { timeZone: name }).resolvedOptions().timeZone;
  } catch {
    return undefined;
  }
}
