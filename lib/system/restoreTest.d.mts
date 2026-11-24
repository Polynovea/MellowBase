export const TEMP_PORT: number;
export const DISK_FACTOR: number;
export const CORE_TABLES: ReadonlyArray<{ table: string; at: string }>;

export class RestoreTestError extends Error {
  constructor(code: string, message: string);
  code: string;
}

export interface RestoreHost {
  pgbackrest(args: string[]): Promise<{ code: number; stdout: string }>;
  pgCtl(args: string[]): Promise<{ code: number }>;
  freeSpace(dir: string): Promise<{ freeBytes: number }>;
  directorySize(dir: string): Promise<number>;
  list(dir: string): Promise<string[]>;
  exists(file: string): Promise<boolean>;
  makePrivateDir(dir: string): Promise<void>;
  remove(dir: string): Promise<void>;
  queryRestored(socketDir: string, port: number, sql: string): Promise<Array<Record<string, unknown>>>;
  queryLive(sql: string): Promise<Array<Record<string, unknown>>>;
  readTail?(file: string): Promise<string | null>;
}

export interface RestoreTestResult {
  status: "passed" | "failed" | "skipped";
  backupLabel: string | null;
  checks: Record<string, unknown>;
  errorCode: string | null;
  errorMessage: string | null;
}

export function restoreRoot(dataRoot: string): string;
export function cleanLeftovers(host: RestoreHost, root: string): Promise<number>;
export function newestBackup(host: RestoreHost): Promise<{ label: string; sizeBytes: number; stoppedAt: string | null }>;
export function runRestoreTest(options: { host: RestoreHost; id: string; dataRoot: string; liveWalDir: string; restoreCommand?: ((pg1Path: string) => string) | null }): Promise<RestoreTestResult>;
export function restoreTestDue(state: { lastPassedAt: string | null; lastAttemptAt: string | null; dueMarker: boolean; now?: number }): "first_backup" | "monthly" | null;
