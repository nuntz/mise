import { normaliseItemName, type Staple, type StapleStatus } from "@mise/domain";
import { createSignal, createUniqueId, For, onCleanup, Show } from "solid-js";
import type { MiseClient } from "./client";
import { keepFresh } from "./fresh";
import { Icon } from "./icons";
import { t } from "./messages";
import { keepFocusIn } from "./Week";

/** How long the note saying what was recorded stays up. */
const NOTE_MS = 6000;

/**
 * "Ran out", in the app header: records any Staple low or out the moment it runs out, from whatever
 * screen is open. It needs the connection: offline, only Grocery Lists can be changed.
 */
export function RanOut(props: { client: MiseClient; online: boolean }) {
  const [open, setOpen] = createSignal(false);
  const [note, setNote] = createSignal<string>();
  const hintId = createUniqueId();
  let timer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => clearTimeout(timer));

  const recorded = (staple: Staple, status: StapleStatus) => {
    setOpen(false);
    setNote(t(`ranOut.recorded.${status === "out" ? "out" : "low"}`, { name: staple.name }));
    clearTimeout(timer);
    timer = setTimeout(() => setNote(undefined), NOTE_MS);
  };

  return (
    <>
      <Show when={note()}>
        <p class="app-header-note" role="status">
          {note()}
        </p>
      </Show>
      <Show when={!props.online}>
        <span id={hintId} class="meta">
          {t("ranOut.needsConnection")}
        </span>
      </Show>
      <button
        type="button"
        class="button-small"
        disabled={!props.online}
        aria-describedby={props.online ? undefined : hintId}
        onClick={() => {
          setNote(undefined);
          setOpen(true);
        }}
      >
        <Icon name="low" />
        {t("ranOut.action")}
      </button>
      <Show when={open()}>
        <Picker client={props.client} online={props.online} onRecorded={recorded} onClose={() => setOpen(false)} />
      </Show>
    </>
  );
}

/** The Household's Staples to search, each to record low or out; a sheet over the page. */
function Picker(props: {
  client: MiseClient;
  online: boolean;
  onRecorded: (staple: Staple, status: StapleStatus) => void;
  onClose: () => void;
}) {
  const titleId = createUniqueId();
  const [staples, setStaples] = createSignal<Staple[]>();
  const [query, setQuery] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal(false);

  keepFresh(
    props.client,
    ["grocery"],
    () => props.client.call("list_staples", {}),
    (result) => {
      setError(!result.ok);
      if (result.ok) setStaples(result.value);
    },
    () => setError(true),
  );

  const shown = () => {
    const wanted = normaliseItemName(query());
    return (staples() ?? []).filter((staple) => normaliseItemName(staple.name).includes(wanted));
  };

  const record = async (staple: Staple, status: StapleStatus) => {
    setBusy(true);
    try {
      const result = await props.client.call("record_staple_status", {
        item: staple.item,
        status,
        at: new Date().toISOString(),
      });
      setError(!result.ok);
      if (result.ok) props.onRecorded(staple, status);
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  };

  const focusSearch = (sheet: HTMLElement) => queueMicrotask(() => sheet.querySelector("input")?.focus());

  return (
    <div class="sheet-backdrop">
      <div
        class="sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        ref={focusSearch}
        onKeyDown={(event) => {
          if (event.key === "Escape") props.onClose();
          if (event.key === "Tab") keepFocusIn(event.currentTarget, event);
        }}
      >
        <div class="sheet-header">
          <div class="page-heading">
            <p class="overline">{t("pantry.overline")}</p>
            <h2 id={titleId} class="dish-title">
              {t("ranOut.title")}
            </h2>
          </div>
          <button type="button" class="icon-button" aria-label={t("ranOut.close")} onClick={() => props.onClose()}>
            <Icon name="close" />
          </button>
        </div>
        <div class="sheet-body">
          <label>
            {t("ranOut.search")}
            <input type="search" value={query()} onInput={(event) => setQuery(event.currentTarget.value)} />
          </label>
          <Show when={!props.online}>
            <p class="banner banner-amber" role="status">
              {t("ranOut.needsConnection")}
            </p>
          </Show>
          <Show when={error()}>
            <p class="banner banner-warn" role="alert">
              {t("app.error")}
            </p>
          </Show>
          <Show when={staples()} fallback={<Show when={!error()}>{<p>{t("app.loading")}</p>}</Show>}>
            {(all) => (
              <Show when={all().length > 0} fallback={<p>{t("pantry.noStaples")}</p>}>
                <ul class="rows">
                  <For each={shown()} fallback={<li>{t("ranOut.noMatch", { query: query().trim() })}</li>}>
                    {(staple) => (
                      <li>
                        <fieldset class="row-group" aria-label={staple.name}>
                          <span>
                            {staple.name}
                            <span class="body-muted">
                              {" "}
                              · {t(`location.${staple.location}`)} · {t(`staple.${staple.status}`)}
                            </span>
                          </span>
                          <For each={["low", "out"] as const}>
                            {(status) => (
                              <button
                                type="button"
                                class="button-small"
                                disabled={busy() || !props.online}
                                aria-pressed={staple.status === status}
                                onClick={() => record(staple, status)}
                              >
                                {t(`staple.${status}`)}
                              </button>
                            )}
                          </For>
                        </fieldset>
                      </li>
                    )}
                  </For>
                </ul>
              </Show>
            )}
          </Show>
        </div>
      </div>
    </div>
  );
}
