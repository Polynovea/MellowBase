import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * What one run of the UI tests shares between its projects (wizard → signin → flows → audit →
 * signout), kept as JSON in UI_STATE_DIR. That folder is outside the repository and made fresh per
 * run by scripts/ui-test/run.mjs: it holds this run's throwaway owner password and authenticator
 * key, which must never be committed.
 */

export interface OwnerState {
  email: string;
  name: string;
  password: string;
  totpKey: string;
  recoveryCodes: string[];
  /** The last 30-second TOTP step used, so no code is ever sent twice (replays are refused). */
  lastTotpStep?: number;
}

export interface RunState {
  owner?: OwnerState;
  starterModelId?: string;
  starterEntryId?: string;
  modelId?: string;
  modelApiKey?: string;
  assetId?: string;
  assetFilename?: string;
  entryId?: string;
  releaseEntryId?: string;
  releaseId?: string;
  translationEntryId?: string;
}

export function stateDir(): string {
  const dir = process.env.UI_STATE_DIR;
  if (!dir) throw new Error("Set UI_STATE_DIR (scripts/ui-test/run.mjs makes one per run).");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

const stateFile = () => path.join(stateDir(), "state.json");

/** The signed-in browser state the flows reuse (cookies and local storage). */
export const storageStatePath = () => path.join(stateDir(), "signed-in.json");

export function readState(): RunState {
  const file = stateFile();
  return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as RunState) : {};
}

export function writeState(patch: Partial<RunState>): RunState {
  const next = { ...readState(), ...patch };
  writeFileSync(stateFile(), JSON.stringify(next, null, 2), { mode: 0o600 });
  return next;
}

export function owner(): OwnerState {
  const value = readState().owner;
  if (!value) throw new Error("No owner in the run state: the wizard project has not finished.");
  return value;
}
