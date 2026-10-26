import { Icon } from "./icons";

/** A finished state, such as every Ingredient resolved: a leaf check and one sentence. Not an empty state. */
export function Done(props: { children: string }) {
  return (
    <div class="done">
      <span class="done-mark">
        <Icon name="check" />
      </span>
      <p>{props.children}</p>
    </div>
  );
}
