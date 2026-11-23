export type ConnectionSettings = {
  connectionString: string;
  ssl: false | { rejectUnauthorized: true; ca?: string[]; servername?: string; minVersion?: "TLSv1.2" };
};

export function tlsConnectionFor(
  connectionString: string,
  database: { host: string; caBundleId: string | null },
  env?: Record<string, string | undefined>,
): ConnectionSettings;
