export * from "./backup";
export * from "./calendar";
export * from "./caller";
export * from "./chat";
export * from "./conflicts";
export * from "./drive";
export * from "./grocery";
export * from "./household";
export * from "./imports";
export * from "./ingredients";
export * from "./items";
export * from "./llm";
export * from "./members";
export * from "./pages";
export * from "./paprika";
export * from "./proposals";
export * from "./proposer";
export * from "./recipes";
export * from "./staples";
export * from "./suggestions";
export * from "./tickQueue";
export * from "./time";
export * from "./tools";
export * from "./units";
export * from "./videos";
export * from "./weeks";

/** The one household Durable Object a deployment serves. */
export const HOUSEHOLD_AGENT = { agent: "Household", name: "household" } as const;

/** Where the Worker serves the household Durable Object over HTTP and WebSocket. */
export const HOUSEHOLD_PATH = `/agents/${HOUSEHOLD_AGENT.agent.toLowerCase()}/${HOUSEHOLD_AGENT.name}`;

/** Where a Recipe's photo is served (GET), uploaded (PUT) and removed (DELETE). */
export function recipePhotoPath(id: number): string {
  return `${HOUSEHOLD_PATH}/recipes/${id}/photo`;
}

/** Where a Paprika export is uploaded (PUT) before `run_paprika_import` imports it. */
export const PAPRIKA_UPLOAD_PATH = `${HOUSEHOLD_PATH}/imports/paprika`;

/** Where a screenshot is uploaded (PUT), one per request, before `import_screenshots` reads it. */
export const SCREENSHOT_UPLOAD_PATH = `${HOUSEHOLD_PATH}/imports/screenshots`;
