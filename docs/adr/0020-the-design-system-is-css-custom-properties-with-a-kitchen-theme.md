# The Design System is CSS custom properties, with kitchen mode as a theme

The Household chose Direction B, "Bistro", and its tokens live in the Mise Design System artifact (issue #3). The web package carries them as CSS custom properties in `apps/web/src/styles/tokens.css`, named as in the Design System's `tokens.json`. A type style is one `font` shorthand per token (`--type-title`). Components are plain CSS classes in `apps/web/src/styles/app.css` that use only those properties, never a hex. There is no CSS-in-JS and no utility framework: the screens are few, Solid needs neither, and plain CSS is what the browser caches offline.

Kitchen mode is the `kitchen` theme: `[data-theme="kitchen"]` redefines the colour, type and size tokens, and nothing else, so the layout never changes. It applies to whatever element carries the attribute. The kitchen-mode screen sets it on itself. The Household page's switch sets it on the root, and the device remembers it in `localStorage`, since it is about where that screen is used, not about the Household. `prefers-reduced-motion` sets every duration to zero. The theme does not follow `prefers-color-scheme`, because kitchen mode is a choice made for the kitchen, not a dark mode.

Fraunces and Inter are self-hosted from Fontsource packages rather than loaded from Google Fonts. The build emits them, so the service worker precaches them with the app shell, and they work offline. No request goes to a third party.

The screens are checked against a pseudo-locale: `?pseudo` in the address makes every message accented, bracketed and 40% longer.

## Consequences

- Changing a token means changing `tokens.css` to match the Design System artifact. Nothing generates one from the other. The Daylight `surface` colour is also written in `index.html`'s `theme-color` and the web manifest, which are read before any CSS loads; the page sets `theme-color` from the token once it runs.
- The service worker's shell includes every font subset Fontsource ships, a few hundred kilobytes, so the fonts work offline in any language.
- Kitchen mode on one device doesn't change any other device.
