import { expect, test } from "bun:test";
import { resourceSummaries } from "./pulumi-resources";

const line = (step: string, text: string) => `deploy\t${step}\t2026-11-11T17:03:03.8057839Z ${text}`;

test("resourceSummaries reads each pulumi up's Resources block from a job log", () => {
  const log = [
    line("pulumi up", "    workerSecrets       : [secret]"),
    line("pulumi up", ""),
    line("pulumi up", "Resources:"),
    line("pulumi up", "    13 unchanged"),
    line("pulumi up", ""),
    line("pulumi up", "Duration: 2s"),
    line("wrangler deploy", "Uploaded mise"),
    line("Bind the hostname on a first deploy", "Resources:"),
    line("Bind the hostname on a first deploy", "    + 1 created"),
    line("Bind the hostname on a first deploy", "    ~ 1 updated"),
    line("Bind the hostname on a first deploy", "    2 changes. 11 unchanged"),
    line("Bind the hostname on a first deploy", ""),
  ].join("\n");
  expect(resourceSummaries(log)).toEqual([
    "pulumi up: 13 unchanged",
    "Bind the hostname on a first deploy: + 1 created, ~ 1 updated, 2 changes. 11 unchanged",
  ]);
});

test("resourceSummaries is empty for a log with no Resources block", () => {
  expect(resourceSummaries(line("pulumi up", "error: update failed"))).toEqual([]);
});
