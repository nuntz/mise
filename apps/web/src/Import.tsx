import {
  type ImportError,
  type ImportFlag,
  type ImportRun,
  MAX_SCREENSHOTS,
  SCREENSHOT_TYPES,
  type ToolError,
  type ToolOutput,
} from "@mise/domain";
import { createEffect, createSignal, For, type JSX, Match, Show, Switch } from "solid-js";
import type { MiseClient } from "./client";
import { whenText } from "./dates";
import { errorText } from "./errors";
import { FilePicker } from "./FilePicker";
import { keepFresh } from "./fresh";
import { Icon } from "./icons";
import { t } from "./messages";

/** Each way to import, a page of its own opened from the Import index, in the index's order. */
export const IMPORT_METHODS = ["link", "paste", "screenshots", "paprika", "drive"] as const;
export type ImportMethod = (typeof IMPORT_METHODS)[number];

const METHOD_TITLE = {
  link: "link.title",
  paste: "paste.title",
  screenshots: "shots.title",
  paprika: "import.title",
  drive: "drive.title",
} as const satisfies Record<ImportMethod, string>;

/**
 * Import: an index of the ways to import, and below it the past imports and the Recipes they
 * flagged. `method` is the way open, if any, shown alone: `onMethod` opens one (pushed over the
 * index by the Household page, so back returns here). `onReview` opens the Review screen, where
 * what the model read waits as a Draft.
 */
export function ImportPage(props: {
  client: MiseClient;
  method?: ImportMethod;
  onMethod: (method: ImportMethod) => void;
  onReview: () => void;
}) {
  const [runs, setRuns] = createSignal<ImportRun[]>();
  const [flags, setFlags] = createSignal<ImportFlag[]>([]);
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

  return (
    <section>
      {/* Each way's page waits on these too: the Drive folder's for its run. */}
      <Show when={error()}>
        <p class="banner banner-warn" role="alert">
          {error()}
        </p>
      </Show>
      <Switch>
        <Match when={props.method === "link"}>
          <PasteLink client={props.client} onReview={props.onReview} />
        </Match>
        <Match when={props.method === "paste"}>
          <PasteRecipe client={props.client} onReview={props.onReview} />
        </Match>
        <Match when={props.method === "screenshots"}>
          <ImportScreenshots client={props.client} onReview={props.onReview} />
        </Match>
        <Match when={props.method === "paprika"}>
          <PaprikaImport client={props.client} flags={flags()} />
        </Match>
        <Match when={props.method === "drive"}>
          <DriveSync client={props.client} runs={runs()} />
        </Match>
        <Match when={props.method === undefined}>
          <h3 id="import-methods">{t("import.methods")}</h3>
          <ul class="rows" aria-labelledby="import-methods">
            <For each={IMPORT_METHODS}>
              {(method) => (
                <li>
                  <button type="button" class="row row-open" onClick={() => props.onMethod(method)}>
                    <span class="row-body">
                      <span class="row-title">{t(METHOD_TITLE[method])}</span>
                    </span>
                    <span class="row-end">
                      <Icon name="chevronRight" />
                    </span>
                  </button>
                </li>
              )}
            </For>
          </ul>
          {/* Every source's runs, pasted text's too. */}
          <h2 id="import-runs">{t("import.runs")}</h2>
          <Show when={runs()}>
            {(listed) => (
              <Show when={listed().length > 0} fallback={<p>{t("import.noRuns")}</p>}>
                <ul class="rows" aria-labelledby="import-runs">
                  <For each={listed()}>{(run) => <RunRow run={run} />}</For>
                </ul>
              </Show>
            )}
          </Show>
          <Show when={flags().length > 0}>
            <FlagRows id="import-flags" flags={flags()} />
          </Show>
        </Match>
      </Switch>
    </section>
  );
}

/** A past import: when it ran as the title, where from as meta, what it did as chips, and what it could not read behind a disclosure. */
function RunRow(props: { run: ImportRun }) {
  const counts = () => (["created", "updated", "skipped", "flagged"] as const).filter((count) => props.run[count] > 0);
  return (
    <li>
      <span class="row-body">
        <span class="row-title">{whenText(props.run.startedAt)}</span>
        <span class="row-meta">{t(`import.source.${props.run.source}`)}</span>
        <Show when={counts().length > 0}>
          <span class="chips">
            <For each={counts()}>
              {(count) => (
                <span class={count === "flagged" ? "chip chip-amber" : "chip"}>
                  {t(`import.${count}`, { count: String(props.run[count]) })}
                </span>
              )}
            </For>
          </span>
        </Show>
      </span>
      <Show when={props.run.errors.length > 0}>
        <details>
          <summary>{t("import.runErrors", { count: String(props.run.errors.length) })}</summary>
          <ul class="row-meta">
            <For each={props.run.errors}>{(problem) => <li>{errorLine(problem)}</li>}</For>
          </ul>
        </details>
      </Show>
    </li>
  );
}

/** Recipes an import flagged, headed "Flagged Recipes". */
function FlagRows(props: { id: string; flags: ImportFlag[] }) {
  return (
    <>
      <h3 id={props.id}>{t("import.flags")}</h3>
      <ul class="rows" aria-labelledby={props.id}>
        <For each={props.flags}>
          {(flag) => (
            <li>
              <span class="row-body">{flagText(flag)}</span>
            </li>
          )}
        </For>
      </ul>
    </>
  );
}

/** A Paprika export, uploaded and imported, and what the import did and flagged (`flags`, every run's, kept fresh). */
function PaprikaImport(props: { client: MiseClient; flags: ImportFlag[] }) {
  const [latest, setLatest] = createSignal<ImportRun>();
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string>();
  const flagged = () => props.flags.filter((flag) => flag.runId === latest()?.id);

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
      <FilePicker
        label={t("import.file")}
        accept=".paprikarecipes"
        disabled={busy()}
        onPick={([file]) => {
          if (file) void importFile(file);
        }}
      />
      <Show when={busy()}>
        <p>{t("import.importing")}</p>
      </Show>
      <Show when={error()}>
        <p class="banner banner-warn" role="alert">
          {error()}
        </p>
      </Show>
      <Show when={latest()}>
        {(run) => (
          <>
            <p role="status">{t("import.done", { counts: countsText(run()) })}</p>
            <Show when={run().errors.length > 0}>
              <h3 id="import-errors">{t("import.errors")}</h3>
              <ul class="rows" aria-labelledby="import-errors">
                <For each={run().errors}>
                  {(problem) => (
                    <li>
                      <span class="row-body">{errorLine(problem)}</span>
                    </li>
                  )}
                </For>
              </ul>
            </Show>
            <Show when={flagged().length > 0}>
              <FlagRows id="import-latest-flags" flags={flagged()} />
            </Show>
          </>
        )}
      </Show>
    </section>
  );
}

/**
 * Reads the Drive folder now rather than tonight, and shows what the sync did. The sync answers once
 * started and takes minutes, so this waits for its run among the Household's runs (`runs`, kept fresh).
 */
function DriveSync(props: { client: MiseClient; runs: ImportRun[] | undefined }) {
  // The runs logged before the sync was asked for, while waiting for its own.
  const [before, setBefore] = createSignal<ReadonlySet<number>>();
  const [error, setError] = createSignal<string>();
  const [run, setRun] = createSignal<ImportRun>();
  const busy = () => before() !== undefined;

  createEffect(() => {
    const known = before();
    const logged = known && props.runs?.find((past) => past.source === "gdrive" && !known.has(past.id));
    if (!logged) return;
    setRun(logged);
    setBefore(undefined);
  });

  const sync = async () => {
    setBefore(new Set((props.runs ?? []).map((past) => past.id)));
    setError(undefined);
    setRun(undefined);
    try {
      const result = await props.client.call("sync_drive_folder", {});
      if (result.ok) return;
      setError(result.error.code === "not_configured" ? t("drive.notConfigured") : errorText(result.error, "recipe"));
    } catch {
      setError(t("app.error"));
    }
    setBefore(undefined);
  };

  return (
    <section>
      <h2>{t("drive.title")}</h2>
      <p>{t("drive.intro")}</p>
      <button type="button" class="button-primary" disabled={busy()} onClick={() => void sync()}>
        {busy() ? t("drive.syncing") : t("drive.sync")}
      </button>
      <Show when={error()}>
        <p class="banner banner-warn" role="alert">
          {error()}
        </p>
      </Show>
      <Show when={run()}>
        {(run) => (
          <>
            <p role="status">{t("drive.done", { counts: countsText(run()) })}</p>
            <Show when={run().errors.length > 0}>
              <h3 id="drive-errors">{t("drive.errors")}</h3>
              <ul class="rows" aria-labelledby="drive-errors">
                <For each={run().errors}>
                  {(problem) => (
                    <li>
                      <span class="row-body">{errorLine(problem)}</span>
                    </li>
                  )}
                </For>
              </ul>
            </Show>
          </>
        )}
      </Show>
    </section>
  );
}

/** A link to a recipe page, imported as a Recipe, a Draft, or a link-only Draft to fill with its text. */
function PasteLink(props: { client: MiseClient; onReview: () => void }) {
  const [url, setUrl] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string>();
  const [imported, setImported] = createSignal<{ link: string; output: ToolOutput<"import_url"> }>();

  const importLink = async (event: SubmitEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    setImported(undefined);
    try {
      const link = url().trim();
      const result = await props.client.call("import_url", { url: link });
      if (!result.ok) setError(linkErrorText(result.error));
      else {
        setImported({ link, output: result.value });
        setUrl("");
      }
    } catch {
      setError(t("app.error"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={importLink}>
      <h2>{t("link.title")}</h2>
      <p>{t("link.intro")}</p>
      <label>
        {t("link.url")}
        <input type="url" required maxLength={2000} value={url()} onInput={(e) => setUrl(e.currentTarget.value)} />
      </label>
      <button type="submit" class="button-primary" disabled={busy()}>
        {busy() ? t("link.importing") : t("link.import")}
      </button>
      <Show when={error()}>
        <p class="banner banner-warn" role="alert">
          {error()}
        </p>
      </Show>
      <Show when={imported()}>
        {(imported) => {
          const output = () => imported().output;
          return (
            <Show
              when={!output().recipe.linkOnly}
              fallback={
                <>
                  <p role="status">{linkOnlyText(output(), imported().link)}</p>
                  <FillDraft client={props.client} draft={output().recipe} onReview={props.onReview} />
                </>
              }
            >
              <p role="status">{linkText(output(), imported().link)}</p>
              <Show when={output().recipe.draft && output().run.created + output().run.updated > 0}>
                <button type="button" class="button-secondary" onClick={() => props.onReview()}>
                  {t("paste.review")}
                </button>
              </Show>
            </Show>
          );
        }}
      </Show>
    </form>
  );
}

/** Why a link was refused. Exported for the share page, as is `importedText`. */
export function linkErrorText(error: ToolError): string {
  return error.code === "invalid_input" ? t("link.invalid") : errorText(error, "recipe");
}

/** What importing a link did. */
export function importedText(output: ToolOutput<"import_url">, link: string): string {
  return output.recipe.linkOnly ? linkOnlyText(output, link) : linkText(output, link);
}

/** What importing a link did, for a link that is not link-only. */
function linkText(output: ToolOutput<"import_url">, link: string): string {
  const { run, recipe } = output;
  const title = { title: recipe.title };
  if (run.created + run.updated === 0) {
    if (run.flagged > 0) return t("link.leftAlone", title);
    const reason = linkError(output, link);
    return reason ? t("link.keptBecause", { ...title, reason }) : t("link.unchanged", title);
  }
  return recipe.draft ? t("paste.done", title) : t("link.recipe", title);
}

function linkOnlyText(output: ToolOutput<"import_url">, link: string): string {
  const { recipe } = output;
  const reason = linkError(output, link);
  return reason
    ? t("link.linkOnlyBecause", { title: recipe.title, reason })
    : t("link.linkOnly", { title: recipe.title });
}

/** Why the link could not be read, when the run says: its error about the link itself, not about the photo. */
function linkError({ run }: ToolOutput<"import_url">, link: string): string | undefined {
  return run.errors.find((error) => error.entry === link)?.message;
}

/**
 * The text of the recipe at a link-only Draft's link, pasted for the model to read into that Draft,
 * or screenshots of it. Exported for the Review screen, which offers it on each link-only Draft.
 */
export function FillDraft(props: { client: MiseClient; draft: { id: number; title: string }; onReview?: () => void }) {
  const [text, setText] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string>();
  const [made, setMade] = createSignal<string>();

  const fill = async (read: () => Promise<{ title: string } | { error: string }>) => {
    setBusy(true);
    setError(undefined);
    try {
      const outcome = await read();
      if ("error" in outcome) setError(outcome.error);
      else setMade(outcome.title);
    } catch {
      setError(t("app.error"));
    } finally {
      setBusy(false);
    }
  };
  const readText = async () => {
    const result = await props.client.call("import_text", { text: text(), draft: props.draft.id });
    if (!result.ok)
      return { error: result.error.code === "model_failed" ? t("paste.failed") : errorText(result.error, "recipe") };
    return result.value.recipe ? { title: result.value.recipe.title } : { error: t("paste.noRecipe") };
  };

  return (
    <Show
      when={made()}
      fallback={
        // Not a form of its own: it may sit inside the link's form.
        <div class="stack">
          <ScreenshotPicker
            label={t("fill.screenshots", { title: props.draft.title })}
            disabled={busy()}
            onPick={(files) => void fill(() => readScreenshots(props.client, files, props.draft.id))}
          />
          <label>
            {t("fill.text", { title: props.draft.title })}
            <textarea rows={6} maxLength={20_000} value={text()} onInput={(e) => setText(e.currentTarget.value)} />
          </label>
          <button type="button" disabled={busy() || text().trim() === ""} onClick={() => void fill(readText)}>
            {busy() ? t("paste.reading") : t("fill.read")}
          </button>
          <Show when={error()}>
            <p class="banner banner-warn" role="alert">
              {error()}
            </p>
          </Show>
        </div>
      }
    >
      {(title) => (
        <>
          <p role="status">{t("paste.done", { title: title() })}</p>
          <Show when={props.onReview}>
            {(onReview) => (
              <button type="button" class="button-secondary" onClick={() => onReview()()}>
                {t("paste.review")}
              </button>
            )}
          </Show>
        </>
      )}
    </Show>
  );
}

/** Screenshots of one recipe, read together by the model into a Draft (ADR 0023). */
function ImportScreenshots(props: { client: MiseClient; onReview: () => void }) {
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string>();
  const [made, setMade] = createSignal<string>();

  const read = async (files: File[]) => {
    setBusy(true);
    setError(undefined);
    setMade(undefined);
    try {
      const outcome = await readScreenshots(props.client, files);
      if ("error" in outcome) setError(outcome.error);
      else setMade(outcome.title);
    } catch {
      setError(t("app.error"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section>
      <h2>{t("shots.title")}</h2>
      <p>{t("shots.intro")}</p>
      <ScreenshotPicker label={t("shots.files")} disabled={busy()} onPick={(files) => void read(files)} />
      <Show when={busy()}>
        <p>{t("shots.reading")}</p>
      </Show>
      <Show when={error()}>
        <p class="banner banner-warn" role="alert">
          {error()}
        </p>
      </Show>
      <Show when={made()}>
        {(title) => (
          <>
            <p role="status">{t("paste.done", { title: title() })}</p>
            <button type="button" class="button-secondary" onClick={() => props.onReview()}>
              {t("paste.review")}
            </button>
          </>
        )}
      </Show>
    </section>
  );
}

/** A file picker for screenshots, several at once. */
function ScreenshotPicker(props: { label: string; disabled: boolean; onPick: (files: File[]) => void }) {
  return (
    <FilePicker
      label={props.label}
      accept={SCREENSHOT_TYPES.join(",")}
      multiple
      disabled={props.disabled}
      onPick={props.onPick}
    />
  );
}

/**
 * Uploads screenshots, in the order picked, and has the model read them together into a Draft, or
 * into the link-only Draft `draft`: the Draft's title, or why not.
 */
async function readScreenshots(
  client: MiseClient,
  files: File[],
  draft?: number,
): Promise<{ title: string } | { error: string }> {
  if (files.length > MAX_SCREENSHOTS) return { error: t("shots.tooMany", { count: String(MAX_SCREENSHOTS) }) };
  const uploads: string[] = [];
  for (const file of files) {
    const upload = await client.uploadScreenshot(file);
    if (upload === null) return { error: t("shots.uploadFailed") };
    uploads.push(upload);
  }
  const result = await client.call("import_screenshots", draft === undefined ? { uploads } : { uploads, draft });
  if (!result.ok)
    return { error: result.error.code === "model_failed" ? t("shots.failed") : errorText(result.error, "recipe") };
  return result.value.recipe ? { title: result.value.recipe.title } : { error: t("shots.noRecipe") };
}

/** A recipe's text, pasted for the model to read into a Draft (ADR 0023). */
function PasteRecipe(props: { client: MiseClient; onReview: () => void }) {
  const [text, setText] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string>();
  const [made, setMade] = createSignal<string>();

  const read = async (event: SubmitEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    setMade(undefined);
    try {
      const result = await props.client.call("import_text", { text: text() });
      if (!result.ok)
        setError(result.error.code === "model_failed" ? t("paste.failed") : errorText(result.error, "recipe"));
      else if (!result.value.recipe) setError(t("paste.noRecipe"));
      else {
        setMade(result.value.recipe.title);
        setText("");
      }
    } catch {
      setError(t("app.error"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={read}>
      <h2>{t("paste.title")}</h2>
      <p>{t("paste.intro")}</p>
      <label>
        {t("paste.text")}
        <textarea rows={8} required maxLength={20_000} value={text()} onInput={(e) => setText(e.currentTarget.value)} />
      </label>
      <button type="submit" class="button-primary" disabled={busy()}>
        {busy() ? t("paste.reading") : t("paste.read")}
      </button>
      <Show when={error()}>
        <p class="banner banner-warn" role="alert">
          {error()}
        </p>
      </Show>
      <Show when={made()}>
        {(title) => (
          <>
            <p role="status">{t("paste.done", { title: title() })}</p>
            <button type="button" class="button-secondary" onClick={() => props.onReview()}>
              {t("paste.review")}
            </button>
          </>
        )}
      </Show>
    </form>
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

/** What an import could not read, and where: a link when that is a page, such as a Drive Doc. */
function errorLine(problem: ImportError): JSX.Element {
  const entry = problem.entry;
  if (entry === null || !/^https?:\/\//.test(entry)) {
    return `${entry ?? t("import.wholeFile")}: ${problem.message}`;
  }
  return (
    <>
      <a href={entry} target="_blank" rel="noopener noreferrer">
        {entry}
      </a>
      {`: ${problem.message}`}
    </>
  );
}

export function flagText(flag: ImportFlag): string {
  return flag.kind === "merge" || flag.duplicateOf === null
    ? t("import.merge", { title: flag.recipe.title })
    : t("import.duplicate", { title: flag.recipe.title, other: flag.duplicateOf.title });
}
