/** Every string the UI shows. English only for now; other locales add a catalogue with the same keys. */
const en = {
  "app.name": "Mise",
  "app.loading": "Loading…",
  "app.error": "Something went wrong talking to Mise. It will retry when the connection comes back.",

  "setup.title": "Set up your Household",
  "setup.intro": "Tell Mise about your Household. You can change these later.",
  "setup.name": "Household name",
  "setup.timezone": "Timezone",
  "setup.dinnerTime": "Dinner time",
  "setup.weekStartsOn": "Week starts on",
  "setup.units": "Units",
  "setup.locale": "Language",
  "setup.submit": "Set up Household",
  "setup.submitting": "Setting up…",
  "setup.invalid": "Please check: {fields}",
  "setup.alreadySetUp": "This Household has already been set up.",

  "household.title": "{name}",
  "household.summary": "Week starts on {weekday}. Dinner at {dinnerTime}, {timezone}.",
  "household.units": "Units: {units}. Language: {locale}.",

  "weekday.monday": "Monday",
  "weekday.tuesday": "Tuesday",
  "weekday.wednesday": "Wednesday",
  "weekday.thursday": "Thursday",
  "weekday.friday": "Friday",
  "weekday.saturday": "Saturday",
  "weekday.sunday": "Sunday",

  "units.metric": "Metric",
  "units.imperial": "Imperial",

  "locale.en-CA": "English (Canada)",
} as const;

export type MessageKey = keyof typeof en;

/** Looks up a message and fills `{placeholders}` from `params`. */
export function t(key: MessageKey, params: Record<string, string> = {}): string {
  return en[key].replace(/\{(\w+)\}/g, (match, name: string) => params[name] ?? match);
}
