import { homedir } from "node:os";
import { join } from "node:path";

/** Where the deployment wizard keeps its values, outside the repo (ADR 0005), as it finds the place. */
export const CONFIG = join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "mise");
export const DEPLOY_ENV = process.env.MISE_DEPLOY_ENV ?? join(CONFIG, "deploy.env");

/** `key` from the environment, else from the wizard's env file, else undefined. */
export async function deploymentValue(key: string): Promise<string | undefined> {
  if (process.env[key]) return process.env[key];
  const file = Bun.file(DEPLOY_ENV);
  if (!(await file.exists())) return undefined;
  const line = (await file.text())
    .split("\n")
    .filter((l) => l.startsWith(`${key}=`))
    .at(-1);
  const value = line?.slice(key.length + 1);
  // The wizard writes KEY='value', with each ' inside as '\''.
  if (value?.startsWith("'") && value.endsWith("'")) return value.slice(1, -1).replaceAll("'\\''", "'") || undefined;
  return value?.replace(/^"|"$/g, "") || undefined;
}
