import { expect, test } from "bun:test";
import { lineFindings } from "./check-private";

test("a Cloudflare ray id names the data centre that answered, so a recorded one is private", () => {
  expect(lineFindings('"ray_id": "a5e3ba7d3c44cb95-YVR"', [])).toEqual(["a Cloudflare ray id"]);
  expect(lineFindings("cf-ray: 8f1c2d3e4a5b6c7d-LHR", [])).toEqual(["a Cloudflare ray id"]);
});

test("the placeholder ray id, of zeros at XXX, is fine", () => {
  expect(lineFindings('"ray_id": "0000000000000000-XXX"', [])).toEqual([]);
});

test("an email outside the placeholder domains and a config value are found as before", () => {
  expect(lineFindings("ask cook@example.com", [])).toEqual([]);
  expect(lineFindings("ask someone@family.net", [])).toEqual(["an email address"]);
  expect(lineFindings("host: Mise.Family.Example", [{ key: "mise:hostname", value: "mise.family.example" }])).toEqual([
    "the value of mise:hostname",
  ]);
});
