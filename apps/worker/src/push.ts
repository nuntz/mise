import type { PushMessage, PushSubscriptionJson } from "@mise/domain";
import { SignJWT } from "jose";

type Fetch = typeof fetch;

/** Notifications to devices, through each one's push service (Web Push: RFC 8030, 8291, 8292). */
export type Push = {
  /** The VAPID public key devices subscribe with, base64url. Throws `PushError` for a key that is none. */
  publicKey(): Promise<string>;
  /**
   * Sends `message` to the device: "gone" when its push service no longer knows it, as after it
   * unsubscribed in the browser. Throws `PushError` when the push service refuses or can't be reached.
   */
  send(subscription: PushSubscriptionJson, message: PushMessage): Promise<"sent" | "gone">;
};

/** A push service refused a message, or the key is unusable: the message says which, as a sentence. */
export class PushError extends Error {}

/** The VAPID key (a P-256 private key, PKCS#8 as PEM or bare base64) and the contact it names. */
export type Vapid = { privateKey: string; subject: string };

/** What opening push needs from the Worker's environment (Worker secrets, ADR 0005). */
type PushEnv = { VAPID_PRIVATE_KEY?: string; VAPID_SUBJECT?: string };

let replacement: ((env: PushEnv) => Push | null) | undefined;

/**
 * Makes households push through another service from their next push, or the real ones again with
 * `undefined`. Tests serve a pretend push service this way, so no test reaches a real one.
 */
export function usePush(open: ((env: PushEnv) => Push | null) | undefined): void {
  replacement = open;
}

/** The deployment's push; null when it has no VAPID key or subject. */
export function openPush(env: PushEnv): Push | null {
  if (replacement) return replacement(env);
  const privateKey = env.VAPID_PRIVATE_KEY?.trim();
  const subject = env.VAPID_SUBJECT?.trim();
  if (!privateKey || !subject) return null;
  return webPush({ privateKey, subject }, fetch);
}

/** How long a push service keeps a message for a device that is off: a day, after which it is stale. */
const TTL_SECONDS = 24 * 60 * 60;
/** How long a VAPID token is good for: RFC 8292 allows a day, but each message signs its own. */
const TOKEN_SECONDS = 60 * 60;
const TIMEOUT_MS = 15_000;
/** One record holds the whole message: notifications are far smaller. */
const RECORD_SIZE = 4096;

/** Web Push with the VAPID key `vapid`, encrypting each message for its device (RFC 8291, `aes128gcm`). */
export function webPush(vapid: Vapid, fetcher: Fetch): Push {
  let keys: Promise<{ signing: CryptoKey; publicKey: string }> | undefined;
  const vapidKeys = () => {
    keys ??= importVapidKey(vapid.privateKey);
    return keys;
  };

  return {
    publicKey: async () => (await vapidKeys()).publicKey,

    async send(subscription, message) {
      const { signing, publicKey } = await vapidKeys();
      const token = await new SignJWT({})
        .setProtectedHeader({ typ: "JWT", alg: "ES256" })
        .setAudience(new URL(subscription.endpoint).origin)
        .setSubject(vapid.subject)
        .setExpirationTime(Math.floor(Date.now() / 1000) + TOKEN_SECONDS)
        .sign(signing);
      const body = await encrypt(subscription.keys, new TextEncoder().encode(JSON.stringify(message)));
      let response: Response;
      try {
        response = await fetcher(subscription.endpoint, {
          method: "POST",
          headers: {
            Authorization: `vapid t=${token}, k=${publicKey}`,
            "Content-Encoding": "aes128gcm",
            "Content-Type": "application/octet-stream",
            TTL: String(TTL_SECONDS),
            Urgency: "normal",
            // A message of the same kind still waiting for the device replaces it.
            Topic: message.kind,
          },
          body,
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch {
        throw new PushError("The push service could not be reached");
      }
      if (response.status === 404 || response.status === 410) return "gone";
      if (!response.ok) throw new PushError(`The push service answered HTTP ${response.status}`);
      return "sent";
    },
  };
}

async function importVapidKey(text: string): Promise<{ signing: CryptoKey; publicKey: string }> {
  try {
    const der = fromBase64(text.replace(/-----(BEGIN|END) PRIVATE KEY-----/g, "").replace(/\s+/g, ""));
    const signing = await crypto.subtle.importKey("pkcs8", der, { name: "ECDSA", namedCurve: "P-256" }, true, ["sign"]);
    const { x, y } = (await crypto.subtle.exportKey("jwk", signing)) as JsonWebKey;
    if (!x || !y) throw new Error("No public key");
    const publicKey = concat(new Uint8Array([4]), fromBase64(x), fromBase64(y));
    return { signing, publicKey: base64Url(publicKey) };
  } catch {
    throw new PushError("The VAPID key is not a P-256 private key in PKCS#8");
  }
}

/**
 * The message encrypted for the device whose keys are given, as one `aes128gcm` record (RFC 8188),
 * with a fresh key pair and salt each time (RFC 8291 §3.4).
 */
async function encrypt(keys: PushSubscriptionJson["keys"], plaintext: Uint8Array): Promise<Uint8Array> {
  const devicePublic = fromBase64(keys.p256dh);
  const auth = fromBase64(keys.auth);
  const ephemeral = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
    "deriveBits",
  ])) as CryptoKeyPair;
  const serverPublic = new Uint8Array((await crypto.subtle.exportKey("raw", ephemeral.publicKey)) as ArrayBuffer);
  let device: CryptoKey;
  try {
    device = await crypto.subtle.importKey("raw", devicePublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  } catch {
    throw new PushError("The device's key is not a P-256 public key");
  }
  const shared = new Uint8Array(await crypto.subtle.deriveBits(ecdh(device), ephemeral.privateKey, 256));
  const text = new TextEncoder();
  const ikm = await hkdf(auth, shared, concat(text.encode("WebPush: info\0"), devicePublic, serverPublic), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, text.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, text.encode("Content-Encoding: nonce\0"), 12);
  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  // The one record is the last, so its delimiter is 0x02.
  const record = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, concat(plaintext, new Uint8Array([2]))),
  );
  const header = new Uint8Array(21);
  header.set(salt);
  new DataView(header.buffer).setUint32(16, RECORD_SIZE);
  header[20] = serverPublic.byteLength;
  return concat(header, serverPublic, record);
}

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, bytes: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, bytes * 8));
}

function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.byteLength;
  }
  return out;
}

/** Base64 or base64url, padded or not. */
function fromBase64(text: string): Uint8Array<ArrayBuffer> {
  const binary = atob(text.replaceAll("-", "+").replaceAll("_", "/").replace(/=+$/, ""));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

function base64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

/** ECDH with the other side's public key; workerd's types call the field `$public`, the runtime `public`. */
function ecdh(publicKey: CryptoKey): SubtleCryptoDeriveKeyAlgorithm {
  return { name: "ECDH", public: publicKey } as unknown as SubtleCryptoDeriveKeyAlgorithm;
}
