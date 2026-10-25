# Screen review: every Mise screen against Bistro

October 2026. A review of the 22 screens in `mise-screens.zip` (daylight, kitchen and pseudo-locale, iPhone 15 width) against the Mise design system (Direction B, "Bistro"), the core-screen mockups, and the code on `master` (`apps/web/src/styles/tokens.css`, `app.css` and the screen components).

- Redesigns (Claude Design canvas, daylight and kitchen side by side): https://claude.ai/artifact/FqQVfNXJTZK2byY51bGHRu — Resolve Ingredients (list, creating an Item, all resolved), a Household index, Members, and a sheet of shared patterns. The link is private until it is shared from the canvas's Share menu.
- Design system: https://claude.ai/artifact/BeXm9VSQdmEH1hwhdTyA1F
- Core-screen mockups: https://claude.ai/artifact/EtAuQB4U9KF5hvyhXjyWA2

Frame names are `NN-screen-F` as in the zip. Severity: **broken** (wrong, unreadable or unsafe as shipped), **inconsistent** (breaks a Bistro rule or a pattern used elsewhere), **polish**.

## The short version

1. Most of the drift has a few root causes in `app.css`, not one cause per screen. Fixing the seven patterns in section 1 closes about two thirds of the findings in section 2.
2. **Lists render as browser bullets** wherever a component uses a bare `<ul>` (Resolve Ingredients, Members, Items, Past imports, Review flags). The cause is the `ul:not([class])` rule, which puts markers back on any unclassed list.
3. **A disabled button looks the same as an enabled one.** A bare `button` is filled with `surface-raised`, and so is `button:disabled`; only the text colour differs. Offline Week, Review and Chat all show it. Many screens also have no primary: Setup, Settings, Members, Calendar, Import and Resolve submit with grey buttons.
4. **The Household page puts nine chips, the Household summary and the kitchen-mode checkbox above every section**, so each section starts on the second screenful. Household needs an index of rows and pushed sub-pages, not tabs.
5. **The Grocery List shows quantities like `1.5 apple`, `0.75 cucumber` and `2.25 clove garlic`**, while the Recipe sheet shows `1½ lemons`. The list people shop from needs the Household's own words.
6. **Safety states look like ordinary text in places.** "Allergens unknown: 3 Ingredients are Unresolved" on the Recipe list, and "— Unresolved" on a Recipe, have the same muted weight as "No Allergens". The wording is right; it needs the amber treatment it already gets on the Recipe page. No AI-drafted or not-complete wording should change.

## 1. Patterns across screens

Each pattern names its rule, where it breaks, and the fix. The fixes are plain CSS on the existing tokens, plus a few tokens proposed in section 3.

### P1. A list of things is a list of rows, never bullets

**Rule.** Hairlines separate; rows are how Mise shows collections (grocery lines, ingredients, steps, recipe rows, the pantry summary).

**Breaks.** `19-household-resolve-2`, `13-household-members-2`, `20-household-items-2…6`, `18-household-import-3` (Past imports), Review flags and suggestions. All are bare `<ul>`, which pick up `ul:not([class]) { padding-inline-start: 1.25em }` and the browser's disc markers.

**Fix.** Delete the `ul:not([class])` rule, or scope it to a `.prose` container. Give every collection one row anatomy:

```
.row            grid: [lead] [body] [trailing]; min-height touch-min; padding space-3 0; border-bottom hairline line
.row-lead       thumb (--thumb), avatar (--avatar), icon (--icon) or nothing
.row-title      --type-title-sm in Fraunces for a name (Recipe, Item, Staple, Member, Unresolved text); --type-body 600 for a setting
.row-meta       --type-meta, ink-muted, inside the body column (never under the lead)
.row-chips      status chips, inside the body column
.row-trailing   one control (.button-row) or a chevron; a destructive action lives in the edit view, not on the row
```

`.rows`, `.recipe-row`, `.summary-list` and `.tick-row` already do most of this; fold them into the one anatomy.

### P2. Five button roles, and disabled is none of them

**Rule.** One plum primary per screen or sheet, in the bottom half. Buttons are `control` tall; nothing tappable is under `touch-min`.

**What is shipped.** Six looks with overlapping meanings:

| Look | Class | Used for |
|---|---|---|
| Plum fill | `.button-primary` | Propose, Cook, Save (Pantry), Start the pantry check |
| 2px ink outline | `.button-secondary` | Grocery List, Add (Use it up), New Recipe, Edit/Discard (Review), Ingredients (kitchen) |
| `surface-raised` fill | bare `button` | Set up Household, Save settings, Add a Member, Suggest for all, Map/Create, Send, Import the link, Sync Drive now, Fill in the Draft |
| Hairline outline | `.button-small` | Ran out, Ask Mise, Mark cooked, Edit Dinner, Who's eating today, Edit/Remove, Low/Out, Household chips |
| `surface-raised` fill, muted text | `:disabled` | Propose offline, Send empty, Fill in the Draft, Previous step |
| Muted text | `.button-quiet` | Clear this Week |

**Breaks.** The bare-button fill equals the disabled fill (`04-week-offline-1`, `06-chat-1`, `17-household-review-2`, `10-kitchen-1`). Forms that should end in a primary end in grey (`00-setup-2`, `14-household-settings-2`, `13-household-members-2`, `15-household-calendar-2`, `18-household-import-2`, `19-household-resolve-2`). Destructive actions look like their neighbours: Delete Recipe next to Edit Recipe (`08-recipe-2`), Remove on every Member and Staple row, Discard next to Edit (`17-household-review-2`), Clear this Week.

**Fix.**

- `.button-primary`: as now.
- `.button-secondary`: as now (2px ink outline).
- `.button-row`: the hairline pill, renamed from `.button-small`, with its border on a new `--line-control` (section 3). This should also be the style of a bare `button`, so an unclassed button never reads as disabled.
- `.button-quiet`: as now.
- `.button-danger`: hairline `warn` border, `warn` text. Only in an edit view or a confirm sheet, never repeated per row.
- `:disabled`: no fill, a 2px dashed `--line-control` border, `ink-muted` text, with the reason as a meta line under it ("Needs a connection.").

The Patterns artboard on the canvas shows all six in both themes.

### P3. Headings and vertical rhythm

**Rule.** Fraunces for names, Inter for function. Hierarchy comes from the type tokens.

**Breaks.**

- `h2`, `h3` and `h4` all use `--type-title-sm`, so "Waiting on you / Drafts / Grandmas dumplings" stack as three identical serif lines (`17-household-review-2`).
- The section's first paragraph sits flush under its heading in Household sections (`15-household-calendar-2`, `16-household-notifications-2`, `19-household-resolve-2`), but has a gap in Import's "Paste a recipe".
- A button runs straight into the next section's heading ("Import the link" into "Paste a recipe", `18-household-import-2`).
- Section heads differ between screens: a Fraunces card title ("Use it up"), Inter `details` summaries ("Effort Budgets", `01-week-6`), `.section-head` with a count chip (Grocery), and plain `h2` (Household).

**Fix.**

- `h2`: the section head, `--type-title-sm` in a `.section-head` row (count chip optional), `min-height: 48px`, `space-6` above.
- `h3`: an overline, `--type-label`, uppercase, plum or ink-muted.
- `h4`: `--type-body` at 600.
- `space-2` from a heading to its body, `space-4` between blocks in a section, `space-6` between sections.

Never two serif headings in a row.

### P4. A state is a chip, not a sentence

**Rule.** Signals have one meaning each: `leaf` done/Stocked, `amber` caution (offline, stale, Low, unknown), `warn` a safety conflict or Out, `plum` Mise's own marks (Locked, AI-drafted).

**Breaks.**

- Stocked and Low as words in a meta string: `05-ran-out-1`, `12-pantry-1`.
- "— Unresolved" as muted text: `09-recipe-resolving-2`.
- "Allergens unknown…" as muted meta: `07-recipes-3`.
- "Allergy (hard): Peanut" as body text: `13-household-members-2`.
- "No Allergens" and "Ships with Mise" as body lines: `20-household-items-2`.

The status marks and chip classes already exist (`.chip-amber`, `.status-low` and others) but are used only in the pantry check-in.

**Fix.** Use status chips in row meta. Keep every allergen and AI sentence word for word, and show it in the chip's colour where it is a state. See the Patterns artboard, "Status chips".

### P5. Empty, done, loading and error

**Rule.** Empty: a dashed outline where content will go, one sentence, one primary. Loading: still skeletons. Errors name what failed.

**Breaks.**

- "Done" states are bare paragraphs: "Every Ingredient is resolved.", "Every Recipe has a cuisine and a main protein." (`21-household-tag-2`) and "Nothing is waiting on you."
- The Next Week empty state nests the whole Use it up card, with its own field and outline button, inside the dashed card (`03-week-next-1`, `03-week-next-2`).
- "Clear this Week" shows on a Week with nothing in it (`03-week-next-5`).
- Errors: 32 `<p role="alert">` across 13 components are unstyled body text. Only 15 alerts use a banner class.

**Fix.**

- A `.done` pattern: a leaf check mark and one sentence, distinct from the dashed empty state. See the Resolve, all resolved artboard.
- Every `role="alert"` uses `.banner.banner-warn`.
- Use it up moves out of the empty card.
- Actions with nothing to act on are hidden.

### P6. No native control left as the browser draws it

**Breaks.**

- `input type=file` shows "Choose File / No file chosen" in English on every locale, and as a grey system button in kitchen mode: `08-recipe-3`, `17-household-review-2`, `18-household-import-3` (three pickers on one page).
- Kitchen mode on the Household page is `<input type=checkbox role=switch>`, so it looks like a checkbox, and its hint is a separate `<small>` 16px below.
- Checkboxes in kitchen render as grey squares (`12-pantry-2`).
- Selects and the datalist are mostly fine, but the Unit select shows "(count)".

**Fix.**

- A `.file-pick` pattern: a visually hidden input, a `.button-row` label ("Choose screenshots"), and a meta line with what was chosen, in the Household's language.
- A `.switch` for settings that apply at once.
- A custom 24px checkbox drawn from tokens.

See the Patterns artboard, "Fields".

### P7. Household is an index, not nine tabs

**Breaks.** `13`–`21` frame 1. Every section repeats: the app header, the Pantry-check banner, the overline and Household name, two lines of summary (which repeat the Settings section), the kitchen-mode checkbox and hint, and nine chips that wrap to three rows (four in pseudo). The section's own heading starts at about 870pt. The bottom nav shows no current item, and the only way in is the people button on the Week header.

**Fix** (Household and Members artboards):

- A Household index: name and a one-line summary, a kitchen-mode switch row, then rows grouped as People (Members), Planning (Settings, Calendar, Notifications) and Recipes and Items (Review, Import, Resolve Ingredients, Items, Tag Recipes).
- Each row has a status chip where something waits: "1 Draft", "3 Unresolved", "All tagged".
- Each section is its own page with a "‹ Household" back link and the overline "Household · …".
- The Pantry-check banner shows only on Week and Pantry, where it can be acted on. On every other page it is noise, and people learn to ignore it.

### Smaller cross-cutting rules

- **P8. Names.** Item, Staple and Unresolved texts come from the data in lowercase ("cumin", "furikake", "apple") and sit beside capitalised UI. Members are Inter bold, Staples are Inter body, and Unresolved texts are Fraunces. Rule: anything that is a name is Fraunces, and display names are sentence-cased when shown (or stored that way in the catalogue). Recipe tags show raw: "mediterranean · chicken" (`08-recipe-1`).
- **P9. Translations.** Strings built from pieces will not translate. Pseudo shows the nesting:
  - "Edit [Ðîññéŕ]" from `slot.edit: "Edit {meal}"`.
  - "Cook for 6, with [[Ţĥûŕšđáý]'š] Leftovers" from `slot.cookFor` plus `slot.leftoversDay: "{day}'s"`.
  - "Allergy ([ĥàŕđ]): Peanut" on Members.
  - "Dislike (soft)" likewise.

  Use whole sentences with placeholders, or ICU `select`, per case.
- **P10. Quantities.** One formatter for quantities everywhere: fractions where the Recipe uses them, rounding counted things up to what the shop sells, and plural units.
- **P11. Chrome.**
  - Overlines vary: "MISE · THIS WEEK", "MISE · RECIPES", "RECIPE", "CHAT", "KITCHEN MODE", and "MISE · PANTRY" on a sheet. Use "Mise · …" on pages and the object's type on sheets.
  - The sheet close button sits after the title on Ran out and Chat (`05-ran-out-1`, `06-chat-1`) but at the right edge on the Recipe sheet (`02-week-dinner-1`). Make the title `flex: 1` in `.sheet-header`.

## 2. Findings by screen

### 00 Setup
- **00-setup-2 · inconsistent.** "Set up Household", the one submit, is a grey bare button, the same weight as "Add a Member". Breaks one primary per screen (P2).
- **00-setup-1 · polish.** No page header pattern: no overline, and the title is `title-sm` where every other page uses `display`.
- **00-setup-2 (kitchen) · inconsistent.** Grey buttons are `#1E1B18` on `#0F0D0B`, so their shape almost disappears (P2).

### 01 Week
- **01-week-1 · inconsistent.** The Pantry-check banner, header, segmented control, day rail, two actions, helper text and the Use it up card fill the first screenful; the first photo arrives on frame 2. Breaks photo-forward. Fix: the banner only on Week and Pantry, compact; Use it up behind the Propose action or in a collapsed strip.
- **01-week-1 (kitchen) · polish.** The banner's "Check now" wraps under the text because the type is bigger. Allowed, but make the banner layout stack in both themes, so kitchen mode stays the same layout.
- **01-week-2…6 · inconsistent.** Every day repeats three rows of controls: Cook, Mark cooked and Edit Dinner; the Breakfast and lunch strip; and a "Who's eating today" pill. That is 21 controls for the week, and in pseudo and kitchen Edit Dinner wraps to its own line. Bistro's card is photo, title, one strip. Fix: Cook as the card's one action, Mark cooked and Edit in an overflow or the Recipe sheet, and "Who's eating" folded into the strip ("3 eating · Breakfast and lunch not planned").
- **01-week-4 · broken.** The Leftovers band on the thumb is `font-size: 9px` (`.thumb-band`), below every type token and the same size in kitchen. In pseudo it wraps to two lines. Fix: `--type-label` on the band, or a "Leftovers" chip under the title.
- **01-week-4 · broken (i18n).** "Cook for 6, with Thursday's Leftovers." builds the possessive by concatenation (P9). Also shown as a chip holding a whole sentence; chips are short labels, so make it a meta line.
- **01-week-5 · inconsistent.** Eating out: the note "Grandma's" sits under the thumb at the left edge, outside the text column. The thumb is dashed, which means "content will go here", for a decided Slot. Fix: the note as `row-meta`, a solid `chip` thumb with the fork-and-knife.
- **01-week-6 · inconsistent.** "Effort Budgets" is an Inter `details` summary where comparable sections are Fraunces (P3). "Clear this Week" is quiet text; it is destructive, so `.button-danger` behind a confirmation (P2).

### 02 Week · dinner sheet
- **02-week-dinner-1 · inconsistent.** Quantities here are fractions ("1½ lemons"); the Grocery List shows decimals for the same scaling (see 11, P10).
- **02-week-dinner-1 · polish.** The sheet header is right: close at the far edge. Use it as the reference for 05 and 06.

### 03 Week · next, unplanned
- **03-week-next-1/2 · inconsistent.** The empty state nests the Use it up card (field, outline Add) inside the dashed card, and its primary comes after a secondary (P5).
- **03-week-next-2…5 · inconsistent.** Seven "Nothing planned" Slots each carry Edit Dinner, the Breakfast and lunch strip, and Who's eating. "Nothing planned" is set in the name face though it is not a name. Fix: compact rows ("Mon 26 · Nothing planned") with one row action, "Choose a dinner", instead of "Edit Dinner".
- **03-week-next-5 · polish.** "Clear this Week" on an empty Week (P5).

### 04 Week · offline
- **04-week-offline-1 · broken.** Disabled Propose dinners, Ran out and Ask Mise use the same grey as enabled grey buttons on other screens (P2).
- **04-week-offline-1 · inconsistent.** "Recording a Staple needs a connection." floats right-aligned above the header pills (`.app-header-note`), detached from the control it explains. Put the reason under the disabled control, or in the offline banner's "what still works" sentence.
- **04-week-offline-1 · polish.** "Fills the dinners that aren't Locked…" stays under a disabled Propose. Replace it with the offline reason.
- **04-week-offline-1 · question.** "Check now" on the Pantry banner stays enabled offline. If the check needs a connection, disable it with a reason; if it queues, fine.

### 05 Ran out (sheet)
- **05-ran-out-1 · inconsistent.** The close button follows the title instead of sitting at the right edge (P11).
- **05-ran-out-1 · inconsistent.** Rows read "cumin · Pantry · Stocked": the Staple name in Inter, the state as a word. In pseudo the meta wraps to two lines beside the buttons. Fix: P1 row, Fraunces name, Stocked/Low as a chip, Low and Out as `.button-row` (P4, P8).

### 06 Ask Mise (sheet)
- **06-chat-1 · inconsistent.** Close placement as in 05 (P11).
- **06-chat-1 · inconsistent.** The empty-message Send looks like an enabled grey button (P2). The composer reads as a form: a "Message" label, a textarea, and a full-width button.
- **06-chat-1 · polish.** Suggestions for the composer: a 48px send icon button beside the field, and the example ("What's for dinner Thursday?") as a tappable chip. The AI disclosure under the composer stays as it is.

### 07 Recipes
- **07-recipes-1…3 · broken.** Row meta ("25 minutes", "Contains: Wheat, Soy.") renders outside the row, under the thumbnail at the left edge, with paragraph gaps. Each row is three loose lines, and only the thumb and title are tappable. Cause: `.recipe-row-meta` is a sibling of the `.recipe-row` button (`Recipes.tsx:160`). Fix: meta inside the row's text column, the whole row one tap target (P1).
- **07-recipes-3 · broken (safety display).** "Allergens unknown: 3 Ingredients are Unresolved. Contains at least: Egg." has the same muted weight as "No Allergens." Keep the wording; show "Allergens unknown" as an amber chip on the row (P4).

### 08 Recipe
- **08-recipe-3 · broken.** The native file input "Choose File / No file chosen" stays in English under pseudo, and is a grey system control in kitchen mode (P6).
- **08-recipe-2 · inconsistent.** "Delete Recipe" is styled the same as "Edit Recipe" beside it (P2).
- **08-recipe-2 · polish.** The ingredient-to-Item mapping, "— chicken thigh", right-aligned with an em dash, reads like a typo. Show it as meta under the line ("Item: chicken thigh"), or not at all once resolved.
- **08-recipe-1 · polish.** Tags show raw and lowercase ("mediterranean · chicken") (P8). The hero is `calc(var(--photo) * 1.25)`, not a token (section 3).

### 09 Recipe · Unresolved Ingredients
- **09-recipe-resolving-2 · inconsistent.** "— Unresolved" is muted text, the same as resolved mappings. Make it an amber "Unresolved" chip that opens Resolve Ingredients at that line.
- **09-recipe-resolving-1 · inconsistent.** The amber banner says Allergens are unknown but offers no way to fix it. Add a `.button-row` "Resolve them" (Review already has this string, `review.resolve`).

### 10 Kitchen mode
- **10-kitchen-1 · inconsistent.** On step 1, "Previous step" is a grey fill that could be enabled or disabled (P2). Hide it on step 1, or use the disabled style.
- **10-kitchen-1 · polish.** "Step 1 of 2" is text only. The pantry check-in's `.dots` progress would give the same orientation at arm's length. `.kitchen-ingredients` hard-codes 20px (section 3).

### 11 Grocery List
- **11-grocery-1…5 · broken.** Quantities read "1.5 apple", "0.75 cucumber", "0.75 lime", "2.25 clove garlic", "1.5 can black beans", "177 ml corn", "22 ml ginger". These are unrounded scaled decimals, singular units, and millilitres for ginger. This is the screen people shop from (P10).
- **11-grocery-2/5 · inconsistent.** Each section is its own grid (`.tick-list`, `minmax(56px, max-content)`), so the quantity column changes width from section to section, names don't line up down the list, and "2.25 clove" crowds the tick. Fix: one quantity column width for the whole list (a `--qty` size token, or the widest in the list).
- **11-grocery-1 · polish.** In store mode, the Pantry banner, header, segmented control and two actions come before the first line (P7).

### 12 Pantry
- **12-pantry-1 · inconsistent.** Staple rows are one meta string ("cumin · Pantry · every 14 days · Stocked") with an Edit and a Remove on every row. In pseudo, Remove drops to its own line (P1, P2, P4).
- **12-pantry-2 · inconsistent.** The add-a-Staple form is an untitled bordered card that starts at "Item". Its checkboxes render natively (grey squares in kitchen mode), and the Unit select defaults to "(count)". Fix: a section head "Add a Staple", custom checkboxes or a switch, a "Count" default.
- **12-pantry-1 · polish.** "4 to check" is followed by "4 Staples are due for a check.", which says the number twice.

### 13 Household · Members
- **13-household-members-2 · broken.** Bulleted list. The name in Inter bold runs into the email ("Robin (you) cook@example.com"). "Allergy (hard): Peanut" is body text with raw parentheses, so the safety fact has the same weight as an email. A grey Edit and Remove on every Member (P1, P4, P9). See the Members artboard: avatar rows, the diet as a chip, Remove inside the edit view.
- **13-household-members-2 · inconsistent.** "Add a Member" is grey (P2).

### 14 Household · Settings
- **14-household-settings-2 · inconsistent.** "Save settings" is grey (P2). The Household summary above repeats these values on every section (P7).

### 15 Household · Calendar
- **15-household-calendar-2 · inconsistent.** The heading, paragraph and button sit with no spacing; the one action is grey (P2, P3).

### 16 Household · Notifications
- **16-household-notifications-2 · inconsistent.** "This Mise hasn't been set up to send notifications: it needs a push key (README → Notifications)." This is developer-facing wording in plain body text, for a state that blocks the feature. Fix: an amber banner in the Household's words. Two paragraphs with no space between them (P3).

### 17 Household · Review
- **17-household-review-2 · broken.** "Waiting on you", "Drafts" and "Grandmas dumplings" are three identical serif headings in a row (P3).
- **17-household-review-2 · broken.** The Edit and Discard outline buttons touch, with no gap. Disabled "Fill in the Draft" looks like a grey enabled button. Discard is not marked destructive. Native file input (P2, P6).
- **17-household-review-2 · polish.** The full URL wraps over two lines. Show the domain as the link text.

### 18 Household · Import
- **18-household-import-2/3 · broken.** Five import methods run together. A button runs into the next heading with no space, some paragraphs are spaced and some not, there are two native file pickers, and every action is grey (P2, P3, P6). Fix: one card per method (title, one line, one action), or an index of methods that opens each.
- **18-household-import-3 · inconsistent.** Past imports is a bulleted log line ("25 Oct 2026, 15:49, a link: 1 created, 0 updated, 0 skipped, 0 flagged"). Fix: rows with the date as the title and the counts as chips, with "1 not imported" as the row's disclosure.

### 19 Household · Resolve Ingredients (the known one)
- **19-household-resolve-2 · broken.** Bullets and nested bullets. Each Unresolved text is a bulleted serif heading, then "1 line, in Shiso Rice Bowls", then a sub-bullet with the original line. "Map to an Item" and "Create an Item" are grey and stack in pseudo. There is no primary, and "Suggest for all" is a grey pill. The intro has no space under the heading, and nothing says why resolving matters (Allergens unknown).
- **19-household-resolve (code) · broken.** The Suggestion panel, the map form and the create form are unstyled: a bare `section` with an `h4`, loose buttons, and eleven native checkboxes in a fieldset. The AI-drafted disclosure is present and must stay.
- **19-household-resolve (code) · inconsistent.** "Every Ingredient is resolved." is a bare paragraph (P5). Errors are bare `role="alert"` paragraphs.
- **Redesign** (Resolve artboards):
  - A back link and page header with the count.
  - An amber banner tying the work to safety: "Allergens for Shiso Rice Bowls are unknown until these are resolved."
  - The AI ask as one bordered block with a secondary "Suggest for all" and its status line.
  - A section head "Unresolved" with a count chip.
  - Each Unresolved text as a row: Fraunces name, "1 line, in Shiso Rice Bowls · “2 tbsp furikake”" as meta, Map and Create as `.button-row`.
  - The Suggestion in a raised panel with the disclosure word for word, an AI-drafted chip, the Item summary, its Allergens as chips, and Accept (plum), Edit (row) and Dismiss (quiet).
  - Creating an Item opens inline: name with the alias hint, Store Section select, Measured by as a segmented control, Allergens as 44px toggle chips plus "Contains none of these", then Create Item (primary) and Cancel (quiet).
  - All resolved is the leaf done state.

### 20 Household · Items
- **20-household-items-2…6 · broken.** A bulleted list of hundreds of Items, each four or five lines (name, Ships with Mise, "Produce · No Allergens", Also called, a round Edit), so about four fit on a screen, with no grouping. Fix: P1 rows (Fraunces name; "Produce · No Allergens · also garlic clove" as meta; a chevron to edit), grouped under sticky Store Section heads, with search on top.
- **20-household-items-2 · inconsistent.** The disclaimer "Those that ship with Mise were drafted by an AI and their Allergens reviewed by a person, but no list is complete: check labels." is plain intro text. Keep it word for word, as the AI note pattern (Patterns artboard).

### 21 Household · Tag Recipes
- **21-household-tag-2 · inconsistent.** When everything is tagged, the section is a heading and one sentence. Use the done pattern (P5).

### Every screen
- **All frames · inconsistent.** The Pantry-check banner on Recipes, Recipe, Grocery List and every Household section (P7).
- **13–21 frame 1 · inconsistent.** The Household header and nine-chip nav before every section; the selected chip is ink-filled where Bistro's "current" is plum; the bottom nav has no current item (P7).
- **13–21 frame 1 · inconsistent.** Kitchen mode is a native checkbox with `role=switch`, and its hint is detached (P6).
- **All · polish.** Overline formats differ (P11).

## 3. Changes to the design system itself

Separate from the screen fixes: these change `tokens.css`, the design system's README, or the component layer in `app.css`.

**Tokens.**

1. **`--line-control`.** `--line` is `#E8E2D9` on `#FFFDF9`, about 1.3:1. It draws the 2px field borders and the hairline buttons, and an empty text field is identified only by its border. WCAG 1.4.11 asks for 3:1. Proposed: `--line-control: #948B81` in daylight (3.3:1 on `surface`) and `#6B645C` in kitchen (3.3:1 on `#0F0D0B`). Use it for field borders, `.button-row` borders and unchecked boxes; keep `--line` for separating hairlines. The redesign canvas uses it.
2. **`--field`.** Fields are a hard-coded `min-height: 48px` in both themes while controls grow to 56px in kitchen. Proposed: `--field: 48px`, with 52px in kitchen.
3. **`--type-item`.** `.item-name` (17/19px), `.answer` (17/19px) and `.kitchen-ingredients` (20px) set font sizes in pixels, with a `[data-theme="kitchen"]` override beside each, which goes around the kitchen-twin mechanism. Proposed: `--type-item: 600 17px / 21px` (kitchen `700 19px / 24px`). `.check-card-title` (32/34px) should use `--type-display`.
4. **Leftovers band.** `.thumb-band` at 9px uses no token. Use `--type-label` (12/13px) and let the band grow.
5. **Radius.** Off-scale corners: the sheet at 20px, banners at 14px, the segmented thumb at 10px, skeleton bars at 6px. Proposed: the sheet uses `--radius-lg`, banners `--radius-md`, the segmented thumb `calc(var(--radius-md) - var(--space-1))`. Add `--radius-sm: 6px` for skeleton bars and checkboxes.
6. **`--photo-hero`.** Replaces `calc(var(--photo) * 1.25)` on the Recipe page.
7. **Stray pixel values** in `app.css` to fold onto the scale or into named sizes: `14px` (banner padding, page-header and sheet-body gaps), `10px` and `6px` gaps, `22px` icons and `28px` sheet icons (use `--icon` / `--icon-button`), `32px` (pill, tick and status-mark sizes), `72px` (done mark), `48px` (`.icon-button` and `.section-head`). ADR 0020's "tokens only" holds for colour (no hex in `app.css`) but not yet for size.

**Components (the vocabulary in section 1).**

8. **Buttons.** Five roles plus a disabled spec (P2). The base `button` gets the `.button-row` look, so an unclassed button never reads as disabled.
9. **Lists.** Remove `ul:not([class])` and add the `.row` anatomy (P1).
10. **Headings.** `h2`, `h3` and `h4` get distinct roles (P3).
11. **New patterns.** `.done`, `.note-ai` (raised panel, AI-drafted chip, the disclosure), `.switch`, `.file-pick`, and a custom checkbox (P5, P6).

**The design system's README.**

12. Fraunces "for anything that is a name" should list Item, Member and Unresolved text beside dish, Staple, store section and date (P8).
13. Add a States line for **done**, distinct from **empty**, and a rule that every `role="alert"` is a warn banner.
14. Add the button roles table and the "one primary per screen or sheet" rule, which the README implies but doesn't state.
15. Add to the six constraints that a page shows nudges only where they can be acted on (P7).

## 4. Not reviewed

- Suggestions on Resolve Ingredients and Review, the Week's Proposal results, the allergen refusal sheet, conflict pills, and Ask Mise mid-conversation are not in the screenshots. The Suggestion panel was reviewed from `ResolveIngredients.tsx` and redesigned. Conflict and Proposal states are mocked in the core-screens artifact and weren't compared against code.
- Loading states were not captured. The skeleton classes exist; whether every new screen uses them was not checked.
- Items shows only its first six screenfuls, so findings there come from the start of the catalogue.

## Next steps

- Decide which findings to act on with `grill-with-docs`, and record the lasting rules (button roles, row anatomy, done vs empty, nudges only where they can be acted on) in an ADR next to 0020, or in the design system README.
- The pattern fixes (P1–P6) are one or two tickets in `app.css` and touch every screen at once. Do them before the per-screen fixes.
- Retake the screens with `bun run screenshot --screens` after each batch, and check daylight, kitchen and pseudo.
