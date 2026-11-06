/**
 * The name of each primary on the page: a screen or sheet has at most one. An icon primary, such as a
 * Week card's Cook, is named by its label.
 */
export const primaries = () =>
  [...document.querySelectorAll(".button-primary, .icon-button-primary")].map(
    (primary) => primary.getAttribute("aria-label") ?? primary.textContent,
  );
