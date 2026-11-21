# Agent briefs: wording for the screens and the agent

A brief or ticket that decides what a screen says (a message, a reason, a hint) or what the agent
does is an acceptance criterion the implementer must meet word for word, so the wording has to hold
up against the screens and the tools.

- **Controls by their label.** Name a control as its message in `apps/web/src/messages.ts` reads
  (`slot.edit.dinner` is "Edit dinner"), and say where it shows: on the card, in the dinner's sheet or
  in the Slot form.
- **Every kind of Slot the wording reaches** (`SLOT_KINDS`). Each kind shows different controls: a
  Recipe dinner's card shows Cook and its sheet shows "Edit dinner" at its foot; Leftovers, Eating out
  and No meal show "Change" on the card; Nothing planned shows "Choose". A pencilled Recipe or Leftovers
  dinner also shows Keep on the card, and in its sheet its reason under the title and Keep at the foot
  (ADR 0032). Wording that tells someone
  what to tap covers each kind it can reach, or says which kinds it is for.
- **What a dinner card's end shows.** Cook and Keep are icons, named by their labels. "Change" and
  "Choose" (`slot.changeShort`, `slot.chooseShort`) are named "Change dinner" and "Choose a dinner", the
  full labels (`slot.change.dinner`, `slot.choose.dinner`). Copy that tells someone to tap one on the
  card says the word the card shows.
- **Plan it, on a Recipe's page.** Its "Which day?" sheet lists the days from today with what each
  Slot holds: Nothing planned and a pencilled dinner are planned in one tap; the Household's own (a
  Recipe, Leftovers, Eating out, No meal) asks "{title} is yours. Replace it with {recipe}?" with
  "Replace {title}"; a cooked one can't be picked. A day the Recipe isn't safe for carries the Week's
  Conflict chip ("Robin · Peanut") before it's tapped, and can still be tapped. The chip is the
  Conflict `wouldFlag` (`conflicts.ts`) returns: a Slot's Override hides it only while the Slot keeps
  its Recipe, or for Leftovers the one they were cooked from (ADR 0012). Once planned, the
  page's "On the plan" line has "Show the Week". Wording that tells someone to plan from a Recipe names these.
- **The agent, planning a Slot.** Plan it's "Replace {title}" is a step on the screen, not a held call.
  A `set_slot` from the agent waits for a tap only when it carries an Override (ADR 0024). Over the
  Household's own dinner it asks in words, replace or swap; over Nothing planned or a pencilled
  dinner it plans at once, as Plan it's one tap does (#160). A brief that says how the agent plans
  quotes these, or says which one it changes.
- **Choose a Recipe, from the Slot form's Recipe field.** A Recipe that would bring the Slot a
  Conflict, with the Diners and Guests as the form has them (saved or not), carries the Week's
  Conflict chip ("Robin · Peanut") on its row, and can still be picked. It is `wouldFlag`'s Conflict,
  as in Plan it.
- **English only.** The pseudo-locale is generated from the English messages (`pseudoText` in
  `messages.ts`), so a change to a message changes it there too.
