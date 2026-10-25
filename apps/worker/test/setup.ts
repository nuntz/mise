import { FakeLlm } from "@mise/domain";
import { beforeEach } from "vitest";
import { useDrive } from "../src/drive";
import { useFetch } from "../src/links";
import { useLlm } from "../src/llm";
import { usePush } from "../src/push";

// No test calls a real model (CODING_STANDARDS.md): every household asks a fake with no answers,
// unless a test gives it its own. An import asks for Suggestions on its own, so this covers every file.
beforeEach(() => useLlm(() => new FakeLlm({})));

// Nor fetches a real page: a link import reaches only the pretend web a test serves.
beforeEach(() => useFetch(async () => new Response("No pretend web", { status: 503 })));

// Nor reaches a real Drive: a household has no Drive folder unless a test serves a pretend one.
beforeEach(() => useDrive(() => null));

// Nor a real push service: a household pushes through the deployment's (none, in tests) unless a
// test serves a pretend one.
beforeEach(() => usePush(undefined));
