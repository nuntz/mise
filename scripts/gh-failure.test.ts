import { expect, test } from "bun:test";
import { ghFailure } from "./gh-failure";

test("ghFailure calls GitHub's HTTP 500 transient", () => {
  const stderr = "HTTP 500 (https://api.github.com/repos/nuntz/mise/actions/runs/19500000000/jobs?per_page=100)\n";
  expect(ghFailure(stderr)).toBe("transient");
});

test("ghFailure calls a gateway error with gh's status text transient", () => {
  expect(ghFailure("HTTP 502: Bad Gateway (https://api.github.com/repos/nuntz/mise/actions/runs)\n")).toBe("transient");
});

test("ghFailure calls a missing run or bad credentials final", () => {
  expect(ghFailure("HTTP 404: Not Found (https://api.github.com/repos/nuntz/mise/actions/runs/1)\n")).toBe("final");
  expect(
    ghFailure("HTTP 401: Bad credentials (https://api.github.com/graphql)\nTry authenticating with:  gh auth login\n"),
  ).toBe("final");
});

test("ghFailure calls a failure that is not an HTTP answer final", () => {
  expect(ghFailure("could not find any workflows named ci.yml\n")).toBe("final");
});
