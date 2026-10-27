import { createHash } from "node:crypto";

/** 256 random bits, URL-safe: a Calendar Feed's or a Kitchen Display's token. */
export function newToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

/** The SHA-256 of a token, in hex: all that is kept of a Kitchen Display's. */
export function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
