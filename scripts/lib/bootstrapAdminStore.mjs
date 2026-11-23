// Database writes of `npm run bootstrap:admin`: make an auth identity the active master admin and
// workspace owner, over a pg client in one transaction, so a failure never leaves a master admin with
// no membership or a membership with its system roles removed and no owner role yet.
//
// The auth identity comes from Supabase Auth (AUTH_PROVIDER=supabase, the rollback path) or from
// lib/auth/bootstrapOwner.mjs, which also owns the PostgreSQL rows used here (grantOwnerRows).

import { grantOwnerRows } from "../../lib/auth/bootstrapOwner.mjs";

/** @param {import("pg").Client} client a connected client; the store runs one transaction on it */
export function postgresAdminStore(client) {
  return {
    async grantOwner(details) {
      await client.query("begin");
      try {
        const granted = await grantOwnerRows(client, details);
        await client.query("commit");
        return granted;
      } catch (error) {
        await client.query("rollback").catch(() => {});
        throw error;
      }
    },
  };
}
