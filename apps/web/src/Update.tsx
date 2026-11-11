import { type Accessor, createSignal, onCleanup, Show } from "solid-js";
import { Icon } from "./icons";
import { t } from "./messages";

/** Where a newer build of Mise shows up, and how the page reloads into it. */
export type Updates = { container: ServiceWorkerContainer | undefined; reload: () => void };

export const browserUpdates = (): Updates => ({
  container: "serviceWorker" in navigator ? navigator.serviceWorker : undefined,
  reload: () => window.location.reload(),
});

/**
 * Whether a newer build of Mise has taken over this open page, which reloads into it only when the
 * person asks, so nothing they're doing is lost. A page that comes back into view asks for a newer
 * build at once, rather than waiting for the browser to check. A page's first worker claiming it is
 * the first install, not a newer build. One watch serves every place that offers the reload.
 */
export function watchForNewBuild(container: ServiceWorkerContainer | undefined): Accessor<boolean> {
  const [ready, setReady] = createSignal(false);
  if (container) {
    let controlled = container.controller !== null;
    const onClaimed = () => {
      if (controlled) setReady(true);
      controlled = true;
    };
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      // With no worker registered yet, or offline, there's nothing to find.
      container
        .getRegistration()
        .then((registration) => registration?.update())
        .catch(() => {});
    };
    container.addEventListener("controllerchange", onClaimed);
    document.addEventListener("visibilitychange", onVisible);
    onCleanup(() => {
      container.removeEventListener("controllerchange", onClaimed);
      document.removeEventListener("visibilitychange", onVisible);
    });
  }
  return ready;
}

/** Offers the reload into a newer build, once one is `ready`. */
export function UpdateBanner(props: { ready: boolean; reload: () => void }) {
  return (
    <Show when={props.ready}>
      <div class="banner banner-plum banner-top" role="status">
        <Icon name="refresh" />
        <p>{t("update.ready")}</p>
        <button type="button" onClick={() => props.reload()}>
          {t("update.reload")}
        </button>
      </div>
    </Show>
  );
}
