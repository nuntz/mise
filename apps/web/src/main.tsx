import { render } from "solid-js/web";
import { App } from "./App";
import { createMiseClient } from "./client";
import { t } from "./messages";

document.title = t("app.name");

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root");
render(() => <App client={createMiseClient()} />, root);
