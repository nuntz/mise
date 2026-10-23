import { render } from "solid-js/web";
import { App } from "./App";
import { createMiseClient } from "./client";
import { t } from "./messages";

document.title = t("app.name");

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root");
render(() => <App client={createMiseClient()} />, root);

// The service worker keeps the app shell so Mise opens offline; dev serves files that change too often.
if (import.meta.env.PROD && "serviceWorker" in navigator) {
  window.addEventListener("load", () => void navigator.serviceWorker.register("/sw.js"));
}
