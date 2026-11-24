import type pg from "pg";

type Env = Record<string, string | undefined>;

export const STANZA: string;
export const PG_BIN: string;
export const LOCAL_DB_SCRIPT: string;
export const DATA_ROOT: string;
export function dataRoot(): string;
export function pgBackRestEnv(): Record<string, string>;
export function inServerImage(env?: Env): boolean;
export function installDatabase(env?: Env): { local: boolean; connection: (role: "owner" | "app") => pg.ClientConfig; config: unknown } | null;
export function runProgram(file: string, args: string[], options?: { env?: Record<string, string>; timeoutMs?: number }): Promise<{ code: number; stdout: string; stderr: string }>;
export function scrub(text: unknown, lines?: number): string;
export function pgbackrest(args: string[], timeoutMs?: number): Promise<{ code: number; stdout: string; stderr: string }>;
export function directorySize(dir: string): Promise<number>;
export function freeSpace(dir: string): Promise<{ freeBytes: number }>;
export function withClient<T>(connection: pg.ClientConfig, fn: (client: pg.Client) => Promise<T>): Promise<T>;
