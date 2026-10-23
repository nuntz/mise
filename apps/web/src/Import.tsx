import type { ImportError, ImportFlag, ImportRun } from "@mise/domain";
import { createSignal, For, Show } from "solid-js";
import type { MiseClient } from "./client";
import { errorText } from "./errors";
import { keepFresh } from "./fresh";
import { t } from "./messages";

/** Import a Paprika export, and see past imports and the Recipes they flagged. */
export function ImportPage(props: { client: MiseClient }) {
  const [runs, setRuns] = createSignal<ImportRun[]>();
  const [flags, setFlags] = createSignal<ImportFlag[]>([]);
  const [latest, setLatest] = createSignal<ImportRun>();
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string>();

  // A run changes Recipes, and is announced as such.
  keepFresh(
    props.client,
    ["recipes"],
    () => Promise.all([props.client.call("list_import_runs", {}), props.client.call("list_import_flags", {})]),
    ([listedRuns, listedFlags]) => {
      if (listedRuns.ok) setRuns(listedRuns.value);
      if (listedFlags.ok) setFlags(listedFlags.value);
      if (!listedRuns.ok || !listedFlags.ok) setError(t("app.error"));
    },
    () => setError(t("app.error")),
  );

  const importFile = async (file: File) => {
    setBusy(true);
    setError(undefined);
    setLatest(undefined);
    try {
      const upload = await props.client.uploadExport(file);
      if (upload === null) {
        setError(t("import.uploadFailed"));
        return;
      }
      const result = await props.client.call("run_paprika_import", { upload });
      if (result.ok) setLatest(result.value);
      else setError(errorText(result.error, "recipe"));
    } catch {
      setError(t("app.error"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section>
      <h2>{t("import.title")}</h2>
      <p>{t("import.intro")}</p>
      <label>
        {t("import.file")}
        <input
          type="file"
          accept=".paprikarecipes"
          disabled={busy()}
          onChange={(e) => {
            const file = e.currentTarget.files?.[0];
            e.currentTarget.value = "";
            if (file) void importFile(file);
          }}
        />
      </label>
      <Show when={busy()}>
        <p>{t("import.importing")}</p>
      </Show>
      <Show when={error()}>
        <p role="alert">{error()}</p>
      </Show>
      <Show when={latest()}>
        {(run) => (
          <>
            <p role="status">{t("import.done", { counts: countsText(run()) })}</p>
            <Show when={run().errors.length > 0}>
              <h3 id="import-errors">{t("import.errors")}</h3>
              <ul aria-labelledby="import-errors">
                <For each={run().errors}>{(problem) => <li>{errorLine(problem)}</li>}</For>
              </ul>
            </Show>
          </>
        )}
      </Show>

      <Show when={flags().length > 0}>
        <h3 id="import-flags">{t("import.flags")}</h3>
        <ul aria-labelledby="import-flags">
          <For each={flags()}>{(flag) => <li>{flagText(flag)}</li>}</For>
        </ul>
      </Show>

      <h3 id="import-runs">{t("import.runs")}</h3>
      <Show when={runs()}>
        {(listed) => (
          <Show when={listed().length > 0} fallback={<p>{t("import.noRuns")}</p>}>
            <ul aria-labelledby="import-runs">
              <For each={listed()}>
                {(run) => (
                  <li>
                    {t("import.run", { when: whenText(run.startedAt), counts: countsText(run) })}
                    <Show when={run.errors.length > 0}>
                      {" · "}
                      {t("import.runErrors", { count: String(run.errors.length) })}
                    </Show>
                  </li>
                )}
              </For>
            </ul>
          </Show>
        )}
      </Show>
    </section>
  );
}

function countsText(run: ImportRun): string {
  return t("import.counts", {
    created: String(run.created),
    updated: String(run.updated),
    skipped: String(run.skipped),
    flagged: String(run.flagged),
  });
}

function errorLine(problem: ImportError): string {
  return `${problem.entry ?? t("import.wholeFile")}: ${problem.message}`;
}

function flagText(flag: ImportFlag): string {
  return flag.kind === "merge" || flag.duplicateOf === null
    ? t("import.merge", { title: flag.recipe.title })
    : t("import.duplicate", { title: flag.recipe.title, other: flag.duplicateOf.title });
}

function whenText(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}
