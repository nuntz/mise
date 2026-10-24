import "@fontsource-variable/fraunces";
import "@fontsource-variable/inter";
import "./styles/tokens.css";
import "./styles/app.css";
import { render } from "solid-js/web";
import { App } from "./App";
import { createMiseClient } from "./client";
import { setPseudoLocale, t } from "./messages";

// `?pseudo` shows every message in the long pseudo-locale, for checking layouts.
setPseudoLocale(new URLSearchParams(window.location.search).has("pseudo"));

document.title = t("app.name");

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root");
// Solid evaluates JSX prop getters on every read; create the shared connection only once.
const client = createMiseClient();
render(() => <App client={client} />, root);

// The service worker keeps the app shell so Mise opens offline; dev serves files that change too often.
if (import.meta.env.PROD && "serviceWorker" in navigator) {
  window.addEventListener("load", () => void navigator.serviceWorker.register("/sw.js"));
}
