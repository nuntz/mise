import { cleanup, configure, prettyDOM } from "@solidjs/testing-library";
import { afterEach } from "vitest";

// Testing Library only cleans up by itself when Vitest's globals are on.
afterEach(cleanup);
// What one test leaves for offline use mustn't show up in the next.
afterEach(() => localStorage.clear());
// jsdom has no scrolling; without this, every scroll prints "Not implemented".
window.scrollTo = () => {};
// A failed query says what it looked for, then the start of the page (DEBUG_PRINT_LIMIT, in the Vitest
// config); getByRole's list of every role on the page is cut as short.
configure({
  getElementError: (message, container) => {
    const said = message && message.length > 1500 ? `${message.slice(0, 1500)}\n...` : message;
    const error = new Error([said, prettyDOM(container)].filter(Boolean).join("\n\n"));
    error.name = "TestingLibraryElementError";
    return error;
  },
});
