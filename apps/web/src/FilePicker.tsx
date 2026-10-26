import { createSignal, createUniqueId, Show } from "solid-js";
import { t } from "./messages";

/**
 * A Mise file picker, never the browser's "Choose File / No file chosen": a row button named
 * `label` (such as "Choose screenshots"), and a meta line naming what was chosen. The input is
 * cleared once picked, so the same files can be picked again.
 */
export function FilePicker(props: {
  label: string;
  accept: string;
  multiple?: boolean;
  disabled?: boolean;
  onPick: (files: File[]) => void;
}) {
  const id = createUniqueId();
  const [chosen, setChosen] = createSignal<File[]>([]);

  return (
    <div class="file-picker">
      <input
        id={id}
        type="file"
        accept={props.accept}
        multiple={props.multiple}
        disabled={props.disabled}
        onChange={(e) => {
          const files = [...(e.currentTarget.files ?? [])];
          e.currentTarget.value = "";
          if (files.length === 0) return;
          setChosen(files);
          props.onPick(files);
        }}
      />
      <label for={id} class="button button-row">
        {props.label}
      </label>
      <Show when={chosen().length > 0}>
        <p class="meta">
          {chosen().length === 1
            ? t("file.chosenOne", { name: chosen()[0]?.name ?? "" })
            : t("file.chosen", { count: String(chosen().length) })}
        </p>
      </Show>
    </div>
  );
}
