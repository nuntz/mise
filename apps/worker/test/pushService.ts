import type { PushMessage, PushSubscriptionJson } from "@mise/domain";
import { decodeProtectedHeader, importJWK, jwtVerify } from "jose";
import { expect } from "vitest";

/** Base64url without padding, as Web Push writes keys. */
export function base64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

export function fromBase64Url(text: string): Uint8Array<ArrayBuffer> {
  const binary = atob(text.replaceAll("-", "+").replaceAll("_", "/"));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

/** A deployment's VAPID key: a P-256 key pair, as the Worker secret holds it (PKCS#8, base64) and as a device sees it. */
export async function vapidKey(): Promise<{ secret: string; pem: string; publicKey: string }> {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const der = new Uint8Array((await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer);
  const secret = btoa(String.fromCharCode(...der));
  const pem = `-----BEGIN PRIVATE KEY-----\n${secret.match(/.{1,64}/g)?.join("\n")}\n-----END PRIVATE KEY-----\n`;
  const raw = new Uint8Array((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer);
  return { secret, pem, publicKey: base64Url(raw) };
}

/** A device's side of RFC 8291: its key pair and auth secret, which only it can decrypt with. */
export type Device = { endpoint: string; privateKey: CryptoKey; publicKey: Uint8Array; auth: Uint8Array };

export async function newDevice(endpoint: string): Promise<Device> {
  const pair = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
    "deriveBits",
  ])) as CryptoKeyPair;
  const publicKey = new Uint8Array((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer);
  return { endpoint, privateKey: pair.privateKey, publicKey, auth: crypto.getRandomValues(new Uint8Array(16)) };
}

/** What the device gives Mise when it subscribes. */
export function subscriptionOf(device: Device): PushSubscriptionJson {
  return { endpoint: device.endpoint, keys: { p256dh: base64Url(device.publicKey), auth: base64Url(device.auth) } };
}

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, bytes: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, bytes * 8));
}

const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.byteLength;
  }
  return out;
};

/** Decrypts an `aes128gcm` push message body as the device does (RFC 8291 §3.4, RFC 8188 §2). */
export async function decrypt(device: Device, body: Uint8Array): Promise<string> {
  const salt = body.slice(0, 16);
  const idLength = body[20] as number;
  const serverKey = body.slice(21, 21 + idLength);
  const ciphertext = body.slice(21 + idLength);
  const server = await crypto.subtle.importKey("raw", serverKey, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits(ecdh(server), device.privateKey, 256));
  const text = new TextEncoder();
  const ikm = await hkdf(device.auth, shared, concat(text.encode("WebPush: info\0"), device.publicKey, serverKey), 32);
  const cek = await hkdf(salt, ikm, text.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, text.encode("Content-Encoding: nonce\0"), 12);
  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["decrypt"]);
  const padded = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, key, ciphertext));
  // The last record ends in 0x02, then any padding of zeros.
  const end = padded.lastIndexOf(2);
  expect(padded.slice(end + 1).every((byte) => byte === 0)).toBe(true);
  return new TextDecoder().decode(padded.slice(0, end));
}

/** A device's private key from RFC 8291's example (raw `d`, with its public key). */
export async function deviceFromRfc(d: string, publicKey: string, auth: string): Promise<Device> {
  const raw = fromBase64Url(publicKey);
  const jwk = {
    kty: "EC",
    crv: "P-256",
    d,
    x: base64Url(raw.slice(1, 33)),
    y: base64Url(raw.slice(33, 65)),
  };
  const privateKey = await crypto.subtle.importKey("jwk", jwk, { name: "ECDH", namedCurve: "P-256" }, false, [
    "deriveBits",
  ]);
  return { endpoint: "https://push.example.com/rfc", privateKey, publicKey: raw, auth: fromBase64Url(auth) };
}

/**
 * A push service, as browsers' are, for the devices given: it takes a message only with a VAPID
 * token (RFC 8292) for its own origin signed by the key the token names, which must be `publicKey`,
 * and it hands each device what it decrypts. A device it has forgotten answers 410 Gone, and one it
 * is told to refuse 500.
 */
export function pretendPushService(publicKey: string, subject: string) {
  const devices = new Map<string, Device>();
  const received = new Map<string, PushMessage[]>();
  const requests: Request[] = [];
  const refusing = new Set<string>();
  const service = {
    add(device: Device) {
      devices.set(device.endpoint, device);
      received.set(device.endpoint, []);
    },
    /** The device unsubscribed in the browser, or its subscription expired. */
    forget(endpoint: string) {
      devices.delete(endpoint);
    },
    /** The push service is in trouble for this device: it answers 500 until told otherwise. */
    refuse(endpoint: string) {
      refusing.add(endpoint);
    },
    /** What each device was shown, by endpoint. */
    received(endpoint: string): PushMessage[] {
      return received.get(endpoint) ?? [];
    },
    requests,
    fetch: async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const request = new Request(input, init);
      requests.push(request.clone());
      if (refusing.has(request.url)) return new Response(null, { status: 500 });
      const device = devices.get(request.url);
      if (!device) return new Response(null, { status: 410 });
      expect(request.method).toBe("POST");
      expect(request.headers.get("Content-Encoding")).toBe("aes128gcm");
      expect(Number(request.headers.get("TTL"))).toBeGreaterThan(0);
      const match = /^vapid t=([^,]+), k=(.+)$/.exec(request.headers.get("Authorization") ?? "");
      if (!match || match[2] !== publicKey) return new Response(null, { status: 403 });
      const token = match[1] as string;
      expect(decodeProtectedHeader(token).alg).toBe("ES256");
      const raw = fromBase64Url(publicKey);
      const key = await importJWK(
        { kty: "EC", crv: "P-256", x: base64Url(raw.slice(1, 33)), y: base64Url(raw.slice(33)) },
        "ES256",
      );
      const { payload } = await jwtVerify(token, key, { audience: new URL(request.url).origin, subject });
      // RFC 8292: no more than 24 hours ahead.
      expect((payload.exp as number) - Date.now() / 1000).toBeLessThanOrEqual(24 * 60 * 60);
      const text = await decrypt(device, new Uint8Array(await request.arrayBuffer()));
      received.get(device.endpoint)?.push(JSON.parse(text));
      return new Response(null, { status: 201 });
    },
  };
  return service;
}

/** ECDH with the other side's public key; workerd's types call the field `$public`, the runtime `public`. */
function ecdh(publicKey: CryptoKey): SubtleCryptoDeriveKeyAlgorithm {
  return { name: "ECDH", public: publicKey } as unknown as SubtleCryptoDeriveKeyAlgorithm;
}
