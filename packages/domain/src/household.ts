import { z } from "zod";

export const WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"] as const;

export const Weekday = z.enum(WEEKDAYS);
export type Weekday = z.infer<typeof Weekday>;

export const Units = z.enum(["metric", "imperial"]);
export type Units = z.infer<typeof Units>;

export const LOCALES = ["en-CA"] as const;
export const Locale = z.enum(LOCALES);
export type Locale = z.infer<typeof Locale>;

/** An IANA timezone name the runtime recognises, such as America/Vancouver. */
export const Timezone = z.string().refine(isKnownTimezone, { message: "Unknown IANA timezone" });

/** A local wall-clock time, HH:MM in 24-hour form. */
export const LocalTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Expected HH:MM");

export const Household = z.object({
  name: z.string().trim().min(1).max(100),
  timezone: Timezone,
  dinnerTime: LocalTime,
  weekStartsOn: Weekday,
  units: Units,
  locale: Locale,
});
export type Household = z.infer<typeof Household>;

export const HOUSEHOLD_DEFAULTS = {
  timezone: "America/Vancouver",
  dinnerTime: "18:00",
  weekStartsOn: "monday",
  units: "metric",
  locale: "en-CA",
} as const satisfies Omit<Household, "name">;

export const SetupHouseholdInput = Household.extend({
  timezone: Timezone.default(HOUSEHOLD_DEFAULTS.timezone),
  dinnerTime: LocalTime.default(HOUSEHOLD_DEFAULTS.dinnerTime),
  weekStartsOn: Weekday.default(HOUSEHOLD_DEFAULTS.weekStartsOn),
  units: Units.default(HOUSEHOLD_DEFAULTS.units),
  locale: Locale.default(HOUSEHOLD_DEFAULTS.locale),
}).strict();

function isKnownTimezone(name: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: name });
    return true;
  } catch {
    return false;
  }
}
