import type { LocalDate, Locale } from "@mise/domain";

/** A date as the Household reads it, formatted with `options` (a LocalDate has no time or zone). */
export function formatDate(date: LocalDate, locale: Locale, options: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat(locale, { ...options, timeZone: "UTC" }).format(new Date(`${date}T00:00:00Z`));
}

/** The date's weekday initial, as the Effort Budgets show it. */
export function dayInitial(date: LocalDate, locale: Locale): string {
  return formatDate(date, locale, { weekday: "narrow" });
}

/** A short date, such as "Oct 26". */
export function shortDate(date: LocalDate, locale: Locale): string {
  return formatDate(date, locale, { month: "short", day: "numeric" });
}

/** An instant on this device's clock, such as "Oct 26, 2026, 8:02 a.m.". */
export function whenText(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

/** An instant's time of day on the Household's clock, such as "12:00 a.m.". */
export function householdTime(iso: string, household: { timezone: string; locale: Locale }): string {
  return new Date(iso).toLocaleTimeString(household.locale, { timeStyle: "short", timeZone: household.timezone });
}
