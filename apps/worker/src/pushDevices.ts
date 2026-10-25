import { type PushDevice, PushKind, PushSubscriptionJson, type ToolResult } from "@mise/domain";
import { z } from "zod";
import type { Handlers } from "./tools";

type PushTools = "subscribe_push" | "get_push_device" | "unsubscribe_push";

type SubscriptionRow = { endpoint: string; p256dh: string; auth: string; kinds: string; subscribed_at: string };

/** A device that gets notifications: where to send them, its keys, and which kinds it chose. */
export const PushSubscriptionRecord = PushSubscriptionJson.extend({
  kinds: z.array(PushKind),
  subscribedAt: z.iso.datetime(),
});
export type PushSubscriptionRecord = z.infer<typeof PushSubscriptionRecord>;

/** The device notification tools, against the household's SQLite. */
export const pushHandlers: Pick<Handlers, PushTools> = {
  subscribe_push: (sql, input) => {
    sql.exec(
      `INSERT INTO push_subscription (endpoint, p256dh, auth, kinds, subscribed_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth, kinds = excluded.kinds`,
      input.endpoint,
      input.keys.p256dh,
      input.keys.auth,
      JSON.stringify(input.kinds),
      new Date().toISOString(),
    );
    return { ok: true, value: { endpoint: input.endpoint, kinds: input.kinds } };
  },

  get_push_device: (sql, input) => {
    const [subscription] = readPushSubscriptions(sql, input.endpoint);
    return { ok: true, value: subscription ? deviceOf(subscription) : null };
  },

  unsubscribe_push: (sql, input): ToolResult<PushDevice> => {
    const [subscription] = readPushSubscriptions(sql, input.endpoint);
    if (!subscription) {
      return { ok: false, error: { code: "not_found", message: "This device does not get notifications" } };
    }
    removePushSubscription(sql, input.endpoint);
    return { ok: true, value: deviceOf(subscription) };
  },
};

/** Every device subscribed, oldest first, or the one at `endpoint`; parsed, so a bad row throws. */
export function readPushSubscriptions(sql: SqlStorage, endpoint?: string): PushSubscriptionRecord[] {
  return sql
    .exec<SubscriptionRow>(
      "SELECT * FROM push_subscription WHERE ? IS NULL OR endpoint = ? ORDER BY rowid",
      endpoint ?? null,
      endpoint ?? null,
    )
    .toArray()
    .map((row) =>
      PushSubscriptionRecord.parse({
        endpoint: row.endpoint,
        keys: { p256dh: row.p256dh, auth: row.auth },
        kinds: JSON.parse(row.kinds),
        subscribedAt: row.subscribed_at,
      }),
    );
}

/** The devices that chose notifications of `kind`. */
export function subscriptionsFor(sql: SqlStorage, kind: PushKind): PushSubscriptionRecord[] {
  return readPushSubscriptions(sql).filter((subscription) => subscription.kinds.includes(kind));
}

/** Forgets a device: it unsubscribed, or its push service no longer knows it. */
export function removePushSubscription(sql: SqlStorage, endpoint: string): void {
  sql.exec("DELETE FROM push_subscription WHERE endpoint = ?", endpoint);
}

function deviceOf({ endpoint, kinds }: PushSubscriptionRecord): PushDevice {
  return { endpoint, kinds };
}
