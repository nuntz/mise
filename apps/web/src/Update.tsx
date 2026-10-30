import { createSignal, onCleanup, Show } from "solid-js";
import { Icon } from "./icons";
import { t } from "./messages";

/**
 * Says when a newer build of Mise has taken over this open page, and reloads into it only when the
 * person asks, so nothing they're doing is lost. A page that comes back into view asks for a newer
 * build at once, rather than waiting for the browser to check. A page's first worker claiming it is
 * the first install, not a newer build.
 */
export function UpdateBanner(props: { container: ServiceWorkerContainer | undefined; reload: () => void }) {
  const [ready, setReady] = createSignal(false);
  const container = props.container;
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

  return (
    <Show when={ready()}>
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
