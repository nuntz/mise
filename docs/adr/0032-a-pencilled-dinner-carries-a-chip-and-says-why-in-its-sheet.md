# A pencilled dinner carries a chip, and says why in its sheet

ADR 0030 made a dinner pencilled exactly when it has a reason, and showed that reason as a grey line on the Week, so that the line was how anyone told a pencilled dinner from the Household's own. ADR 0031 then made the line the only sign of what Mise chose and no one has settled. In use the line was too much to read for that job: to tell the two apart, someone had to read a sentence of factors on every card, and the sentence took more room than the dinner's name.

A pencilled dinner is now marked by a **Pencilled chip** beside its day on the Week, and its name is set in italic, as if in pencil. The day rail puts a dot under each day whose dinner is pencilled, and the line under Re-roll leads with the same chip ("Pencilled: Re-roll changes only these dinners. Yours stay."), so the chip is the key to what a Re-roll changes. The Household's own dinners carry none of these.

The reason itself moves into the dinner's Recipe sheet, which the card's title opens, with Keep under it. A pencilled dinner with no Recipe to open, such as one no Recipe fit, still says why on its card, since that is the only place it can. Keep stays on the card too, beside Cook, so settling a dinner is still one tap.

The rule of ADR 0030 is unchanged: a dinner is pencilled exactly when it has a reason. Only how the Week shows that changes. Since the chip is the key to what a Re-roll changes, it marks only a pencilled dinner a Re-roll could change (`isRerollable`): a dinner nobody is eating, left unplanned with a reason, carries none, and neither does its day on the rail.

## Considered Options

- **Keep the grey line and add the chip.** The chip alone tells the two apart; the line would only make every card taller again.
- **A tinted card for each pencilled dinner.** It marks the whole card, but a tint needs a new colour token, and a Week of mostly pencilled dinners would be mostly tinted.
- **A dashed outline, as if in pencil.** Dashed already means nothing planned (the thumb of an unplanned dinner) and disabled (a button), so it would mean a third thing.

## Consequences

- Chips in plum are Mise's own marks (`app.css`), so the Pencilled chip takes `chip-plum`, and needs no new token.
- The agent still explains a dinner from its reason; nothing about `ProposalReason` changes.
- This amends ADR 0030 ("That reason is the grey line on the Week, so the line is how anyone tells the two apart") and ADR 0031 ("A pencilled dinner's grey line is the only sign of what Mise chose and no one has settled"): the chip is that sign now, and the reason is in the sheet.

## Amendment: no day rail

The Week has no day rail any more, so nothing puts a dot under a day: the Pencilled chip on each card, and the same chip leading the line under Re-roll, are the whole of the mark. The rail's other jobs were said twice already: today's card has its plum ring and "Tonight", and its jump is replaced by the Week opening at Tonight, on opening and on coming back from Next Week. It stays at its top on the Week's first day, where Tonight is the first card anyway, and while nothing is planned, when Propose dinners is the point. A refetch leaves the scroll where it is.

## Amendment: the sheet's actions at its foot

The reason stays under the Recipe sheet's title, but Keep no longer sits under it: it is at the sheet's foot, held at the bottom edge while a long Recipe scrolls, beside Mark cooked and Edit dinner and above Cook. Once the dinner is cooked, the foot holds the rating, Not cooked after all and Edit dinner instead. Keep still shows exactly when the dinner can be kept, and settling a dinner is still one tap, now within a thumb's reach.
