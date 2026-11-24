import { headers } from "next/headers";
import DatabaseStep from "@/components/setup/database/DatabaseStep";
import { createdForYouAvailable } from "@/lib/setup/database/createdForYou";
import { BACKUP_OPTIONS, LOCAL_SERVER_UNAVAILABLE, localServerHostForThisImage } from "@/lib/setup/database/localServer";
import { resolveMode } from "@/lib/setup/mode";
import { requireSetupSession, SetupSessionError } from "@/lib/setup/setupSession";

// Step 2 of the setup wizard: the database. The shared shell (step list, setup-mode check) is the
// layout. The page needs the setup session; every action it takes goes through the database-step
// routes, which check the session, the request and the mode again.

export const dynamic = "force-dynamic";

const OWNER_STEP = "/setup/owner";

export default async function SetupDatabasePage() {
  try {
    requireSetupSession({ headers: await headers() });
  } catch (error) {
    if (!(error instanceof SetupSessionError)) throw error;
    return (
      <section className="ui-section flex flex-col gap-4">
        <h2 className="ui-section-title">Enter the setup code first</h2>
        <p role="status" className="ui-alert ui-alert-warning">{error.message}</p>
        <a href="/setup" className="ui-btn ui-btn-primary self-start">Go to the setup code</a>
      </section>
    );
  }

  // Configured and migrated already (settings from the environment, or this step was done before):
  // nothing to choose here, and offering the choices again would only confuse.
  if ((await resolveMode()).databaseReady) {
    return (
      <section className="ui-section flex flex-col gap-4">
        <p className="ui-eyebrow">Step 2</p>
        <h2 className="ui-section-title">Your database is ready</h2>
        <p role="status" className="ui-alert ui-alert-success">This server already has its database set up, so there is nothing to choose here.</p>
        <a href={OWNER_STEP} className="ui-btn ui-btn-primary self-start">Continue to your owner account</a>
      </section>
    );
  }

  return (
    <section className="ui-section flex flex-col gap-6">
      <header className="flex flex-col gap-2">
        <p className="ui-eyebrow">Step 2</p>
        <h2 className="ui-section-title">Choose the database</h2>
        <p className="ui-section-description">
          Your content lives in a PostgreSQL database. A managed database from your cloud is the safest choice if you don't want to look after a
          server: the cloud keeps it patched and backed up. We check the connection step by step and tell you exactly what to fix if something
          doesn't work.
        </p>
      </header>
      <DatabaseStep
        createdAvailable={createdForYouAvailable()}
        localAvailable={localServerHostForThisImage() !== null}
        localUnavailableReason={LOCAL_SERVER_UNAVAILABLE}
        backupOptions={BACKUP_OPTIONS.map((option) => ({ ...option }))}
        nextHref={OWNER_STEP}
      />
    </section>
  );
}
