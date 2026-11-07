# Drawing a Mise screen on a design canvas

For exploring how a screen should look on a Claude Design canvas (directions to choose between, before
`app.css` changes). The boards draw the screen as the app builds it, so the chosen direction's CSS is
most of the diff.

1. **Install the Mise design system** on the canvas: the design quickstart lists it by name, "Mise design
   system". Its `tokens.json` drives the canvas's colour pickers and text styles; it is re-synced from
   `tokens.css` (ADR 0033), so a token the app has and it lacks means it is due a re-sync.
2. **Copy the app's stylesheets in as support files**, verbatim: `apps/web/src/styles/tokens.css` and
   `apps/web/src/styles/app.css` at `project/tokens.css` and `project/app.css`, sent in the canvas's first
   publish. Neither imports anything. Each board links them after its `support.js` line, then Google
   Fonts' Fraunces (500, 600, italic 500) and Inter (400 to 800), which the token font stacks fall back to
   where the app self-hosts the variable faces.
3. **Draw with the app's markup.** Copy the elements and class names from the component (`Week.tsx` for
   the Week), and every word from `messages.ts`, so a board reads as the screen does. Board-specific
   data stays in the board's script.
4. **Two tweaks on every board**: a theme enum (Daylight, Kitchen mode) that puts `data-theme="kitchen"`
   on the board's root, which is all `tokens.css` needs, and an enum for the case that changes most (for
   a Week card, what kind of Slot it is: Recipe, pencilled, Leftovers, Nothing planned). Every direction is
   judged in both themes and every case.
5. **One board per direction, plus "Now, as built"**: each direction's board is the baseline's markup with
   its own rules in the board's `<style>`. Those rules, named by the app's selectors, are what goes into
   `app.css` once a direction is chosen, and a new colour they need is a new token in `tokens.css`.

Done when every direction is a board, each differing from "Now" only by its own `<style>` rules and any
markup change it names, and each reads in both themes.
