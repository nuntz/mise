import { cleanup } from "@solidjs/testing-library";
import { afterEach } from "vitest";

// Testing Library only cleans up by itself when Vitest's globals are on.
afterEach(cleanup);
// What one test leaves for offline use mustn't show up in the next.
afterEach(() => localStorage.clear());
// jsdom has no scrolling; without this, every scroll prints "Not implemented".
window.scrollTo = () => {};
