# Notifications are pushed by the household to devices, not Members

Mise sends Web Push itself, from the household Durable Object. A device that turns on notifications gives the household its push subscription: its push service's endpoint and its keys. The household encrypts each message for that device (RFC 8291, `aes128gcm`) and signs a VAPID token (RFC 8292) with the deployment's key, all with WebCrypto in `apps/worker/src/push.ts`. No Web Push library is used: the common one needs Node's crypto, and what Mise needs is about a hundred lines of RFCs with test vectors. The worker tests send through the real code to a pretend push service, which checks the token and decrypts each message. Its decryption is checked against RFC 8291's worked example.

A subscription belongs to a device, not to a Member or a Caller. Every device subscribed gets every kind it chose, whoever signed in on it, so there is no routing by person (SPEC §4.9). The table is Household data like any other: it is in the nightly export and comes back with a restore (ADR 0006).

The VAPID key is a deployment secret (`VAPID_PRIVATE_KEY`, from `mise:vapidPrivateKey`, ADR 0005). The wizard makes it once with `openssl` and keeps it. Every subscription is tied to the key's public half, so a new key turns notifications off on every device until each turns them on again. The subject, which push services may contact, is the deployment's own `https://` address.

The morning's notifications are one daily run at 08:00 Household time, not an alarm set for the next Week's proposal. Each morning it asks whether a Week starts two days later by the Household's calendar as it is then (`proposalWeekOn`). A change of week start (ADR 0021) needs no rescheduling, and a Week that runs on is proposed once, before the Week after it.

## Consequences

- A push service that answers 404 or 410 has forgotten the device, which is then removed. Any other refusal is reported to Sentry and the device is kept.
- A restore into a deployment with another VAPID key keeps devices that can no longer be reached. Their pushes are refused and reported until each device turns notifications on again.
- The device tools (`subscribe_push`, `get_push_device`, `unsubscribe_push`) announce no change: no other screen shows a device's choice. They are not offered to the agent, since only the device can turn its notifications on.
- Messages are in English, like the Calendar Feed. They say little: a title, a line, and the page a tap opens.
