export interface PostgresConnectionConfig {
  connectionString: string;
  ssl: false | { rejectUnauthorized: true; ca?: string[] };
}

export function postgresConnectionConfig(connectionString: string, env?: Record<string, string | undefined>): PostgresConnectionConfig;

export interface PinnedTlsOptions { rejectUnauthorized: true; servername: string; ca: string[]; minVersion: "TLSv1.2" }
export function pinnedTlsOptions(options: { servername: string; ca: string[] }): PinnedTlsOptions;
