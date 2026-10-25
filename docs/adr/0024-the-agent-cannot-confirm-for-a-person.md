# The agent cannot confirm for a person

Some tool calls need a person's say-so: the destructive ones (`delete_recipe`, `clear_week`), an Override of a Conflict, and anything that loosens a Hard Constraint (removing one, turning it into a dislike, or removing a Member who has one). Adding a Constraint needs no confirmation, since it only makes plans safer. `setup_household` is not offered to the agent at all. When the agent makes such a call, the household does not run it. It returns a pending confirmation, and the PWA shows it in the chat as a button that names what will happen ("Delete *Lemon chicken*", "Plan *Satay* for Friday although Sam is allergic to peanut"). Only the person's tap on that button runs the call. The model has no way to confirm, whatever the person types and however the model reads it.

A prompt that says "ask before deleting" is a request to the model, not a guarantee, and an allergy Override is the one place where Mise must not depend on the model reading a "yes" correctly. Putting the rule in the tool layer means it holds for any model, any prompt and, later, voice.

## Consequences

- The PWA calling the same tools directly already asks in its own dialogs, so the check applies to calls that come from the agent.
- In voice (Drop 3) the confirmation still needs a tap, or something equally deliberate, decided then.
- A Member's new name or sign-in email also waits for a tap (#40): they decide who the agent takes a speaker for, and so whose Constraints and Ratings a turn is about.
- The Guests' Hard Constraints count as a Member's do: removing one from a Slot waits for a tap too. Sending the Guests home doesn't: their Constraints stay for when Guests come back.
- A confirmation can be cancelled, by its own button or by the agent when told "never mind": cancelling only ever makes plans safer.
