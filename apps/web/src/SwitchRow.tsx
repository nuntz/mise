import { createUniqueId } from "solid-js";

/** A setting that applies at once, such as kitchen mode: its label, a switch beside it and its hint under the label. */
export function SwitchRow(props: { label: string; hint: string; checked: boolean; onChange: (on: boolean) => void }) {
  const labelId = createUniqueId();
  const hintId = createUniqueId();
  return (
    <label class="switch-row">
      <span class="row-body">
        <span id={labelId} class="row-title">
          {props.label}
        </span>
        <small id={hintId} class="row-meta">
          {props.hint}
        </small>
      </span>
      <input
        type="checkbox"
        role="switch"
        aria-checked={props.checked}
        aria-labelledby={labelId}
        aria-describedby={hintId}
        checked={props.checked}
        onChange={(event) => props.onChange(event.currentTarget.checked)}
      />
    </label>
  );
}
