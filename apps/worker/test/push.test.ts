import type { PushMessage } from "@mise/domain";
import { describe, expect, test } from "vitest";
import { openPush, PushError, webPush } from "../src/push";
import {
  decrypt,
  deviceFromRfc,
  fromBase64Url,
  newDevice,
  pretendPushService,
  subscriptionOf,
  vapidKey,
} from "./pushService";

const SUBJECT = "https://mise.example.com";
const message: PushMessage = {
  kind: "weekly_proposal",
  title: "Next week is proposed",
  body: "Review it before you shop.",
  url: "/?week=next",
};

describe("the pretend device", () => {
  test("decrypts RFC 8291's worked example", async () => {
    // RFC 8291, Appendix A.
    const device = await deviceFromRfc(
      "q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94",
      "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
      "BTBZMqHH6r4Tts7J_aSIgg",
    );
    const body = fromBase64Url(
      "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
    );

    expect(await decrypt(device, body)).toBe("When I grow up, I want to be a watermelon");
  });
});

describe("web push", () => {
  test("a device is sent the message, encrypted for it alone, with Mise's VAPID token", async () => {
    const key = await vapidKey();
    const service = pretendPushService(key.publicKey, SUBJECT);
    const device = await newDevice("https://push.example.com/send/device-1");
    service.add(device);
    const push = webPush({ privateKey: key.secret, subject: SUBJECT }, service.fetch);

    expect(await push.send(subscriptionOf(device), message)).toBe("sent");

    expect(service.received(device.endpoint)).toEqual([message]);
  });

  test("its public key is the one devices subscribe with, from a PEM or a bare key", async () => {
    const key = await vapidKey();

    expect(await webPush({ privateKey: key.secret, subject: SUBJECT }, fetch).publicKey()).toBe(key.publicKey);
    expect(await webPush({ privateKey: key.pem, subject: SUBJECT }, fetch).publicKey()).toBe(key.publicKey);
  });

  test("a message of a kind replaces one of that kind still waiting at the push service", async () => {
    const key = await vapidKey();
    const service = pretendPushService(key.publicKey, SUBJECT);
    const device = await newDevice("https://push.example.com/send/device-1");
    service.add(device);

    await webPush({ privateKey: key.secret, subject: SUBJECT }, service.fetch).send(subscriptionOf(device), message);

    expect(service.requests[0]?.headers.get("Topic")).toBe("weekly_proposal");
  });

  test("a device the push service no longer knows is gone", async () => {
    const key = await vapidKey();
    const service = pretendPushService(key.publicKey, SUBJECT);
    const device = await newDevice("https://push.example.com/send/device-1");

    const push = webPush({ privateKey: key.secret, subject: SUBJECT }, service.fetch);

    expect(await push.send(subscriptionOf(device), message)).toBe("gone");
  });

  test("a push service that refuses for any other reason is an error", async () => {
    const key = await vapidKey();
    const other = await vapidKey();
    // Signed with another deployment's key.
    const service = pretendPushService(other.publicKey, SUBJECT);
    const device = await newDevice("https://push.example.com/send/device-1");
    service.add(device);

    const push = webPush({ privateKey: key.secret, subject: SUBJECT }, service.fetch);

    await expect(push.send(subscriptionOf(device), message)).rejects.toThrow(PushError);
  });

  test("a key that is no P-256 private key is an error", async () => {
    await expect(webPush({ privateKey: "bm90IGEga2V5", subject: SUBJECT }, fetch).publicKey()).rejects.toThrow(
      PushError,
    );
  });

  test("a deployment without a key or subject has no push", () => {
    expect(openPush({})).toBeNull();
    expect(openPush({ VAPID_PRIVATE_KEY: "bm90IGEga2V5" })).toBeNull();
    expect(openPush({ VAPID_PRIVATE_KEY: "bm90IGEga2V5", VAPID_SUBJECT: SUBJECT })).not.toBeNull();
  });
});
