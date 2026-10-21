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
  "setup.alreadySetUp": "This Household has already been set up.",
  "setup.members": "Members",
  "setup.membersIntro":
    "Who eats at your table? Add anyone with an allergy, intolerance or diet now so every plan is safe.",

  "form.invalid": "Please check: {fields}",

  "members.title": "Members",
  "members.add": "Add a Member",
  "members.none": "No Members yet.",
  "member.name": "Name",
  "member.email": "Sign-in email",
  "member.emailHint": "Leave empty for someone who never signs in, such as a young child.",
  "member.noEmail": "Doesn't sign in",
  "member.constraints": "Constraints",
  "member.noConstraints": "No Constraints",
  "member.edit": "Edit",
  "member.save": "Save",
  "member.saving": "Saving…",
  "member.cancel": "Cancel",
  "member.remove": "Remove",
  "member.removeConfirm": "Remove {name} from the Household?",
  "member.emailInUse": "Another Member already signs in with that email.",
  "member.notFound": "That Member is no longer in the Household.",
  "member.you": "(you)",

  "constraint.kind": "Kind",
  "constraint.allergen": "Allergen",
  "constraint.term": "What",
  "constraint.termPlaceholder": "e.g. lactose, mushrooms",
  "constraint.noAllergen": "No Allergen",
  "constraint.add": "Add a Constraint",
  "constraint.remove": "Remove",
  "constraint.allergy": "Allergy",
  "constraint.intolerance": "Intolerance",
  "constraint.diet": "Diet",
  "constraint.dislike": "Dislike",
  "constraint.hard": "hard",
  "constraint.soft": "soft",

  "allergen.peanut": "Peanut",
  "allergen.tree_nut": "Tree nuts",
  "allergen.milk": "Milk",
  "allergen.egg": "Egg",
  "allergen.wheat": "Wheat",
  "allergen.soy": "Soy",
  "allergen.fish": "Fish",
  "allergen.shellfish": "Shellfish",
  "allergen.sesame": "Sesame",
  "allergen.mustard": "Mustard",
  "allergen.sulphite": "Sulphites",

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
