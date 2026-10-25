import { PushSubscriptionJson } from "@mise/domain";

/** This device's side of notifications: the browser's permission and its push subscription. */
export type DevicePush = {
  /**
   * "unsupported" when this browser can't get notifications here (on an iPhone, until Mise is opened
   * from the Home Screen); otherwise whether they are allowed, refused or not asked yet.
   */
  state(): NotificationPermission | "unsupported";
  /** The subscription this device holds, if any. */
  subscription(): Promise<PushSubscriptionJson | null>;
  /**
   * Asks to allow notifications if not asked yet, then subscribes with the deployment's key; the
   * subscription the device already holds if it has one. Null when they are refused. Call it from a
   * tap: Safari asks only then.
   */
  subscribe(publicKey: string): Promise<PushSubscriptionJson | null>;
  /** Drops this device's subscription, if it has one. */
  unsubscribe(): Promise<void>;
};

/** The browser's push, through the service worker that shows each notification. */
export function browserPush(): DevicePush {
  const supported = () => "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
  const current = async () => (await navigator.serviceWorker.getRegistration())?.pushManager.getSubscription() ?? null;

  return {
    state: () => (supported() ? Notification.permission : "unsupported"),

    subscription: async () => {
      const subscription = await current();
      return subscription && PushSubscriptionJson.parse(subscription.toJSON());
    },

    async subscribe(publicKey) {
      // First, while the tap still counts: Safari asks only from one.
      if ((await Notification.requestPermission()) !== "granted") return null;
      const registration = await navigator.serviceWorker.ready;
      const key = fromBase64Url(publicKey);
      let subscription = await registration.pushManager.getSubscription();
      // One made with another key, before the deployment's changed, gets nothing any more.
      if (subscription && !sameBytes(subscription.options.applicationServerKey, key)) {
        await subscription.unsubscribe();
        subscription = null;
      }
      subscription ??= await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
      return PushSubscriptionJson.parse(subscription.toJSON());
    },

    async unsubscribe() {
      await (await current())?.unsubscribe();
    },
  };
}

function sameBytes(a: ArrayBuffer | null, b: Uint8Array): boolean {
  const bytes = new Uint8Array(a ?? new ArrayBuffer(0));
  return bytes.byteLength === b.byteLength && bytes.every((byte, index) => byte === b[index]);
}

function fromBase64Url(text: string): Uint8Array<ArrayBuffer> {
  const binary = atob(text.replaceAll("-", "+").replaceAll("_", "/"));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}
