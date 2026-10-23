import {
  addDays,
  currentWeekStart,
  type GroceryAmount,
  type GroceryLine,
  type GroceryList,
  type Household,
  type LocalDate,
  type StoreSection,
} from "@mise/domain";
import { createSignal, For, onCleanup, Show } from "solid-js";
import type { MiseClient } from "./client";
import { t } from "./messages";

type GroceryHousehold = Pick<Household, "timezone" | "weekStartsOn" | "locale" | "storeSections">;

/**
 * The Week's Grocery List, by Store Section in walking order, with Have Ticks, the Staples due to be
 * bought and lines added by hand.
 */
export function GroceryPage(props: { client: MiseClient; household: GroceryHousehold }) {
  const [next, setNext] = createSignal(false);
  // Undefined until loaded; null while the Week has no Grocery List.
  const [list, setList] = createSignal<GroceryList | null>();
  const [error, setError] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  // Only the latest fetch may show its list, whatever order the answers arrive in.
  let latest = 0;

  const weekShown = (): LocalDate => {
    const start = currentWeekStart(new Date(), props.household.timezone, props.household.weekStartsOn);
    return next() ? addDays(start, 7) : start;
  };

  const refetch = async () => {
    const fetch = ++latest;
    try {
      const result = await props.client.call("get_grocery_list", { date: weekShown() });
      if (fetch !== latest) return;
      setError(!result.ok);
      if (result.ok) setList(result.value);
    } catch {
      if (fetch === latest) setError(true);
    }
  };
  // The list says whether the plan, its Recipes or the Household's Store Sections changed under it.
  for (const topic of ["grocery", "plan", "recipes", "household"] as const) {
    onCleanup(props.client.subscribe(topic, refetch));
  }

  const show = (showNext: boolean) => {
    setNext(showNext);
    setList(undefined);
    void refetch();
  };

  /** Runs a tool call; on success the change notice refetches the list. */
  const run = async (call: () => Promise<{ ok: boolean }>) => {
    setBusy(true);
    try {
      setError(!(await call()).ok);
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  };
  const build = () => run(() => props.client.call("build_grocery_list", { date: weekShown() }));

  return (
    <section>
      <h2>{t("grocery.title")}</h2>
      <nav>
        <button type="button" aria-pressed={!next()} onClick={() => show(false)}>
          {t("week.this")}
        </button>
        <button type="button" aria-pressed={next()} onClick={() => show(true)}>
          {t("week.next")}
        </button>
      </nav>
      <Show when={error()}>
        <p role="alert">{t("app.error")}</p>
      </Show>
      <Show when={list() === null}>
        <p>{t("grocery.none")}</p>
        <button type="button" disabled={busy()} onClick={build}>
          {t("grocery.build")}
        </button>
      </Show>
      <Show when={list()}>
        {(shown) => (
          <>
            <Show when={shown().planChanged}>
              <p role="alert">{t("grocery.planChanged")}</p>
            </Show>
            <Show when={shown().staplesChanged}>
              <p role="alert">{t("grocery.staplesChanged")}</p>
            </Show>
            <button type="button" disabled={busy()} onClick={build}>
              {t("grocery.rebuild")}
            </button>
            <For each={shown().sections}>
              {(group) => (
                <section aria-label={sectionName(group.section)}>
                  <h3>{sectionName(group.section)}</h3>
                  <ul>
                    <For each={group.lines}>
                      {(line) => (
                        <li>
                          <LineView client={props.client} line={line} locale={props.household.locale} />
                        </li>
                      )}
                    </For>
                  </ul>
                </section>
              )}
            </For>
            <AddLine client={props.client} startDate={shown().startDate} />
          </>
        )}
      </Show>
      <WalkingOrder client={props.client} sections={props.household.storeSections} />
    </section>
  );
}

function LineView(props: { client: MiseClient; line: GroceryLine; locale: string }) {
  return (
    <>
      <label>
        <input
          type="checkbox"
          checked={props.line.have}
          onChange={(event) =>
            // Set to what the box now shows, as of now, so a tick synced late never undoes a later one.
            void props.client.call("set_have_tick", {
              line: props.line.id,
              have: event.currentTarget.checked,
              at: new Date().toISOString(),
            })
          }
        />
        {lineText(props.line, props.locale)}
      </label>
      <Show when={props.line.origin === "staple"}>
        <small>{t("grocery.staple")}</small>
      </Show>
      <Show when={props.line.origin === "recipe" && props.line.item === null}>
        <small>{t("grocery.asWritten")}</small>
      </Show>
      <Show when={props.line.recipes.length > 0}>
        <small>{t("grocery.for", { recipes: props.line.recipes.map((recipe) => recipe.title).join(", ") })}</small>
      </Show>
    </>
  );
}

/** "salt: 2–3 ml, and some to taste"; a line with nothing measured is just its name. */
function lineText(line: GroceryLine, locale: string): string {
  const amounts = line.amounts.map((amount) => amountText(amount, locale)).join(" + ");
  if (!amounts) return line.unmeasured ? t("grocery.someOf", { name: line.name }) : line.name;
  return `${line.name}: ${line.unmeasured ? t("grocery.andSome", { amounts }) : amounts}`;
}

export function amountText({ amount, unit }: GroceryAmount, locale: string): string {
  const number = new Intl.NumberFormat(locale, { maximumFractionDigits: 2 });
  const value =
    amount.min === amount.max ? number.format(amount.min) : `${number.format(amount.min)}–${number.format(amount.max)}`;
  return unit === null ? value : `${value} ${unit.replace("_", " ")}`;
}

function sectionName(section: StoreSection | "other"): string {
  return section === "other" ? t("grocery.other") : t(`section.${section}`);
}

function AddLine(props: { client: MiseClient; startDate: LocalDate }) {
  const [text, setText] = createSignal("");
  const [failed, setFailed] = createSignal(false);

  const add = async (event: SubmitEvent) => {
    event.preventDefault();
    if (!text().trim()) return;
    try {
      const result = await props.client.call("add_grocery_line", { date: props.startDate, text: text() });
      setFailed(!result.ok);
      if (result.ok) setText("");
    } catch {
      setFailed(true);
    }
  };

  return (
    <form onSubmit={add}>
      <label>
        {t("grocery.addLine")}
        <input value={text()} onInput={(event) => setText(event.currentTarget.value)} maxLength={200} />
      </label>
      <button type="submit">{t("grocery.add")}</button>
      <Show when={failed()}>
        <p role="alert">{t("app.error")}</p>
      </Show>
    </form>
  );
}

/** The Household's Store Sections in the order it walks its store, each movable up or down. */
function WalkingOrder(props: { client: MiseClient; sections: StoreSection[] }) {
  const move = (index: number, by: -1 | 1) => {
    const sections = [...props.sections];
    const [section] = sections.splice(index, 1) as [StoreSection];
    sections.splice(index + by, 0, section);
    void props.client.call("set_store_section_order", { sections });
  };

  return (
    <details>
      <summary>{t("grocery.walkingOrder")}</summary>
      <ol>
        <For each={props.sections}>
          {(section, index) => (
            <li>
              {sectionName(section)}
              <button
                type="button"
                disabled={index() === 0}
                aria-label={t("grocery.moveUp", { section: sectionName(section) })}
                onClick={() => move(index(), -1)}
              >
                ↑
              </button>
              <button
                type="button"
                disabled={index() === props.sections.length - 1}
                aria-label={t("grocery.moveDown", { section: sectionName(section) })}
                onClick={() => move(index(), 1)}
              >
                ↓
              </button>
            </li>
          )}
        </For>
      </ol>
    </details>
  );
}
