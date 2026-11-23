type Env = Record<string, string | undefined>;

export type DatabaseMode = "local" | "managed" | "created";

export interface InstallConfig {
  v: 1;
  databaseMode: DatabaseMode;
  database: {
    /** The endpoint name, never a resolved IP. */
    host: string;
    port: number;
    name: string;
    /** The shipped CA bundle the wizard verified the server with (null: the bundled server on loopback, no TLS). */
    caBundleId: string | null;
  };
  roles: {
    owner: { user: string; password: string };
    app: { user: string; password: string };
  };
  /** Signs session cookies; replaces POLYNOVEA_AUTH_SECRET in .env. */
  authSecret: string;
  /** pgBackRest repository encryption password ("On this server" only). */
  backupRepoPassword: string | null;
}

export function configPath(env?: Env): string;
export function configExists(env?: Env): boolean;
export function generateSecret(bytes?: number): string;
export function validateInstallConfig(value: unknown): InstallConfig;
export function encryptInstallConfig(config: InstallConfig, env?: Env): string;
export function decryptInstallConfig(text: string, env?: Env): InstallConfig;
/** Null when config.enc is absent; throws (naming fields, never values) when it is present but unusable. */
export function readInstallConfigSync(env?: Env): InstallConfig | null;
export function readConfigSync(env?: Env): InstallConfig | null;
export function readConfig(env?: Env): Promise<InstallConfig | null>;
export function writeConfig(config: InstallConfig, env?: Env): Promise<void>;
export function databaseUrlFromConfig(config: InstallConfig, role: "owner" | "app"): string;
