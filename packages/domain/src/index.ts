export * from "./backup";
export * from "./caller";
export * from "./household";
export * from "./ingredients";
export * from "./items";
export * from "./members";
export * from "./recipes";
export * from "./time";
export * from "./tools";
export * from "./units";

/** The one household Durable Object a deployment serves. */
export const HOUSEHOLD_AGENT = { agent: "Household", name: "household" } as const;

/** Where the Worker serves the household Durable Object over HTTP and WebSocket. */
export const HOUSEHOLD_PATH = `/agents/${HOUSEHOLD_AGENT.agent.toLowerCase()}/${HOUSEHOLD_AGENT.name}`;

/** Where a Recipe's photo is served (GET), uploaded (PUT) and removed (DELETE). */
export function recipePhotoPath(id: number): string {
  return `${HOUSEHOLD_PATH}/recipes/${id}/photo`;
}
