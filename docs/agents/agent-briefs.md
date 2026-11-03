# Agent briefs: wording for the screens

A brief or ticket that decides what a screen says (a message, a reason, a hint) is an acceptance
criterion the implementer must meet word for word, so the wording has to hold up against the screens.

- **Controls by their label.** Name a control as its message in `apps/web/src/messages.ts` reads
  (`slot.edit.dinner` is "Edit dinner"), and say where it shows: on the card, in the dinner's sheet or
  in the Slot form.
- **Every kind of Slot the wording reaches** (`SLOT_KINDS`). Each kind shows different controls: a
  Recipe dinner's card shows Cook and its sheet shows "Edit dinner"; Leftovers, Eating out and No meal
  show "Change dinner" on the card; Nothing planned shows "Choose a dinner". Wording that tells someone
  what to tap covers each kind it can reach, or says which kinds it is for.
- **English only.** The pseudo-locale is generated from the English messages (`pseudoText` in
  `messages.ts`), so a change to a message changes it there too.
