import { cleanup } from "@solidjs/testing-library";
import { afterEach } from "vitest";

// Testing Library only cleans up by itself when Vitest's globals are on.
afterEach(cleanup);
