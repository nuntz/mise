import { FakeLlm } from "@mise/domain";
import { beforeEach } from "vitest";
import { useLlm } from "../src/llm";

// No test calls a real model (CODING_STANDARDS.md): every household asks a fake with no answers,
// unless a test gives it its own. An import asks for Suggestions on its own, so this covers every file.
beforeEach(() => useLlm(() => new FakeLlm({})));
