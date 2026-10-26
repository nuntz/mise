import { Show } from "solid-js";
import { t } from "./messages";

/**
 * "Needs a connection.", under a control that can't work offline, while offline. The control names
 * it as its description: `aria-describedby={online ? undefined : id}`.
 */
export function NeedsConnection(props: { id: string; online: boolean }) {
  return (
    <Show when={!props.online}>
      <p id={props.id} class="control-reason">
        {t("app.needsConnection")}
      </p>
    </Show>
  );
}
