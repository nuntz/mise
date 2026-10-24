import type { ToolOutput } from "@mise/domain";
import { createSignal, onCleanup, onMount, Show } from "solid-js";
import type { MiseClient } from "./client";
import { FillDraft, importedText, linkErrorText } from "./Import";
import { t } from "./messages";

/**
 * `/share?url=…`, which the iOS Shortcut opens in Safari (behind Access, like every page): imports
 * the shared link and says what it became, with a link to it. When the household can't be reached,
 * it says whether Safari needs its one-time sign-in rather than waiting on a call that won't come back.
 */
export function SharePage(props: { client: MiseClient; url: string | null }) {
  const [imported, setImported] = createSignal<ToolOutput<"import_url">>();
  const [error, setError] = createSignal<string>();
  // Why the household can't be reached, while it can't: the call waits for the connection meanwhile.
  const [unreachable, setUnreachable] = createSignal<"offline" | "signedOut">();

  const explain = async () => {
    const why = (await props.client.signedIn()) ? "offline" : "signedOut";
    if (!imported() && !error()) setUnreachable(why);
  };

  onMount(async () => {
    const url = props.url;
    if (!url) {
      setError(t("share.noLink"));
      return;
    }
    onCleanup(props.client.onConnection((online) => (online ? setUnreachable(undefined) : void explain())));
    try {
      const result = await props.client.call("import_url", { url });
      setUnreachable(undefined);
      if (result.ok) setImported(result.value);
      else setError(linkErrorText(result.error));
    } catch {
      // The connection closed for good, or the import took too long to answer.
      await explain();
    }
  });

  return (
    <main class="app">
      <div class="page">
        <h1>{t("share.title")}</h1>
        <Show when={!imported() && !error() && !unreachable()}>
          <p>{t("link.importing")}</p>
        </Show>
        <Show when={error()}>
          <p role="alert">{error()}</p>
        </Show>
        <Show when={unreachable() === "offline"}>
          <p role="alert">{t("share.unreachable")}</p>
        </Show>
        <Show when={unreachable() === "signedOut"}>
          <p role="alert">{t("share.signIn")}</p>
          {/* Opening the page again goes through Access, which signs Safari in and comes back here. */}
          <a href={window.location.href}>{t("share.signInLink")}</a>
        </Show>
        <Show when={imported()}>
          {(output) => (
            <>
              <p role="status">{importedText(output(), props.url ?? "")}</p>
              {/* A Draft waits on the Review screen; anything else is a Recipe to open. */}
              <Show
                when={output().recipe.draft}
                fallback={
                  <a href={`/?recipe=${output().recipe.id}`}>{t("share.open", { title: output().recipe.title })}</a>
                }
              >
                <a href="/?review">{t("share.review", { title: output().recipe.title })}</a>
              </Show>
              <Show when={output().recipe.linkOnly}>
                <FillDraft client={props.client} draft={output().recipe} />
              </Show>
            </>
          )}
        </Show>
      </div>
    </main>
  );
}
