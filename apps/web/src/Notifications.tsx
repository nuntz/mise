import { PUSH_KINDS, type PushKind, type PushSubscriptionJson } from "@mise/domain";
import { createSignal, For, Match, onMount, Show, Switch } from "solid-js";
import type { MiseClient } from "./client";
import { t } from "./messages";
import { browserPush, type DevicePush } from "./push";

/** What the screen can offer this device. */
type Offer =
  | { kind: "loading" }
  | { kind: "unsupported" }
  | { kind: "notConfigured" }
  | { kind: "off"; publicKey: string }
  | { kind: "on"; publicKey: string; subscription: PushSubscriptionJson; kinds: PushKind[] };

/**
 * Settings: whether this device gets notifications, and of which kinds. Each device chooses for
 * itself; nothing here is the Household's, so another device's choice never shows.
 */
export function NotificationSettings(props: { client: MiseClient; push?: DevicePush }) {
  const push = props.push ?? browserPush();
  const [offer, setOffer] = createSignal<Offer>({ kind: "loading" });
  const [denied, setDenied] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [failed, setFailed] = createSignal(false);

  /** Runs `change`, showing that something went wrong if it throws or a tool refuses. */
  const attempt = async (change: () => Promise<void>) => {
    setBusy(true);
    setFailed(false);
    try {
      await change();
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };

  onMount(() =>
    attempt(async () => {
      if (push.state() === "unsupported") return void setOffer({ kind: "unsupported" });
      const key = await props.client.call("get_push_key", {});
      if (!key.ok) {
        if (key.error.code === "not_configured") return void setOffer({ kind: "notConfigured" });
        throw new Error(key.error.message);
      }
      const { publicKey } = key.value;
      setDenied(push.state() === "denied");
      const subscription = await push.subscription();
      const device = subscription && (await props.client.call("get_push_device", { endpoint: subscription.endpoint }));
      if (device && !device.ok) throw new Error(device.error.message);
      setOffer(
        subscription && device?.value
          ? { kind: "on", publicKey, subscription, kinds: device.value.kinds }
          : { kind: "off", publicKey },
      );
    }),
  );

  /** Tells the household which kinds this device gets. */
  const save = async (publicKey: string, subscription: PushSubscriptionJson, kinds: PushKind[]) => {
    const saved = await props.client.call("subscribe_push", { ...subscription, kinds });
    if (!saved.ok) throw new Error(saved.error.message);
    setOffer({ kind: "on", publicKey, subscription, kinds: saved.value.kinds });
  };

  const turnOn = (publicKey: string) =>
    attempt(async () => {
      const subscription = await push.subscribe(publicKey);
      setDenied(!subscription);
      if (subscription) await save(publicKey, subscription, [...PUSH_KINDS]);
    });

  const turnOff = (endpoint: string, publicKey: string) =>
    attempt(async () => {
      // Forgotten by the household first: the browser's subscription is what finds it.
      const removed = await props.client.call("unsubscribe_push", { endpoint });
      if (!removed.ok && removed.error.code !== "not_found") throw new Error(removed.error.message);
      await push.unsubscribe();
      setOffer({ kind: "off", publicKey });
    });

  const off = () => {
    const current = offer();
    return current.kind === "off" ? current : undefined;
  };
  const on = () => {
    const current = offer();
    return current.kind === "on" ? current : undefined;
  };

  const toggle = (on: Extract<Offer, { kind: "on" }>, kind: PushKind, checked: boolean) =>
    attempt(() =>
      save(on.publicKey, on.subscription, checked ? [...on.kinds, kind] : on.kinds.filter((chosen) => chosen !== kind)),
    );

  return (
    <section>
      <h2>{t("notifications.title")}</h2>
      <p>{t("notifications.intro")}</p>
      <Show when={failed()}>
        <p class="banner banner-warn" role="alert">
          {t("app.error")}
        </p>
      </Show>
      <Show when={denied()}>
        <p class="banner banner-amber" role="status">
          {t("notifications.denied")}
        </p>
      </Show>
      <Switch>
        <Match when={offer().kind === "unsupported"}>
          <p>{t("notifications.unsupported")}</p>
        </Match>
        <Match when={offer().kind === "notConfigured"}>
          <p>{t("notifications.notConfigured")}</p>
        </Match>
        <Match when={off()}>
          {(off) => (
            <button type="button" disabled={busy()} onClick={() => turnOn(off().publicKey)}>
              {busy() ? t("notifications.turningOn") : t("notifications.turnOn")}
            </button>
          )}
        </Match>
        <Match when={on()}>
          {(on) => (
            <>
              <fieldset>
                <legend>{t("notifications.kinds")}</legend>
                <For each={PUSH_KINDS}>
                  {(kind) => (
                    <label>
                      <input
                        type="checkbox"
                        checked={on().kinds.includes(kind)}
                        disabled={busy()}
                        onChange={(event) => toggle(on(), kind, event.currentTarget.checked)}
                      />
                      {t(`notifications.kind.${kind}`)}
                      <small>{t(`notifications.kind.${kind}.hint`)}</small>
                    </label>
                  )}
                </For>
              </fieldset>
              <button
                type="button"
                disabled={busy()}
                onClick={() => turnOff(on().subscription.endpoint, on().publicKey)}
              >
                {t("notifications.turnOff")}
              </button>
            </>
          )}
        </Match>
      </Switch>
    </section>
  );
}
