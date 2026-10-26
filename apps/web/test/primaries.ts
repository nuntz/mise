/** The text of each primary on the page: a screen or sheet has at most one. */
export const primaries = () => [...document.querySelectorAll(".button-primary")].map((primary) => primary.textContent);
