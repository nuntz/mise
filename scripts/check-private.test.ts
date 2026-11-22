import { expect, test } from "bun:test";
import { lineFindings } from "./check-private";

// Each sample is built from parts, so this file holds none of what check:private looks for.
const rayId = (hex: string, colo: string) => `${hex}-${colo}`;
const email = (local: string, domain: string) => `${local}@${domain}`;

test("a Cloudflare ray id names the data centre that answered, so a recorded one is private", () => {
  expect(lineFindings(`"ray_id": "${rayId("0123456789abcdef", "ABC")}"`, [])).toEqual(["a Cloudflare ray id"]);
  expect(lineFindings(`cf-ray: ${rayId("fedcba9876543210", "XYZ")}`, [])).toEqual(["a Cloudflare ray id"]);
});

test("the placeholder ray id, of zeros at XXX, is fine", () => {
  expect(lineFindings(`"ray_id": "${rayId("0000000000000000", "XXX")}"`, [])).toEqual([]);
});

test("an email outside the placeholder domains and a config value are found as before", () => {
  expect(lineFindings(`ask ${email("cook", "example.com")}`, [])).toEqual([]);
  expect(lineFindings(`ask ${email("someone", "family.test")}`, [])).toEqual(["an email address"]);
  expect(lineFindings("host: Mise.Family.Example", [{ key: "mise:hostname", value: "mise.family.example" }])).toEqual([
    "the value of mise:hostname",
  ]);
});
