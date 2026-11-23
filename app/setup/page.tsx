import { headers } from "next/headers";
import AddressChoice from "@/components/setup/AddressChoice";
import SetupCodeForm from "@/components/setup/SetupCodeForm";
import { setupTransport } from "@/lib/setup/requestGuards";

// Step 1 of the setup wizard: the setup code. The shared shell (step list, setup-mode check) is the
// layout next to this page. The code form only appears on a connection that can carry the code:
// HTTPS through a trusted proxy, or an SSH tunnel to localhost.

export const dynamic = "force-dynamic";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function SetupCodePage({ searchParams }: { searchParams: SearchParams }) {
  const requestHeaders = await headers();
  const params = await searchParams;
  const transport = setupTransport(requestHeaders);
  const codeInAddress = Object.keys(params).some((key) => key.trim().toLowerCase() === "code");
  const port = process.env.PORT?.trim() || "3000";

  return (
    <section className="ui-section flex flex-col gap-6">
      <header className="flex flex-col gap-2">
        <p className="ui-eyebrow">Step 1</p>
        <h2 className="ui-section-title">Enter the setup code</h2>
        <p className="ui-section-description">
          When the CMS started, it printed a one-time setup code in the server log, next to the setup address. Entering it proves you're the person
          who runs this server. It works for one hour; restarting the CMS prints a new one.
        </p>
      </header>

      {codeInAddress && (
        <p role="alert" className="ui-alert ui-alert-danger">
          The setup code was put in the web address, where logs can record it, so it was not used. Restart the CMS to get a fresh code, then type
          it in the box below instead.
        </p>
      )}

      {transport ? (
        <SetupCodeForm />
      ) : (
        <p role="status" className="ui-alert ui-alert-warning">
          This page isn't on a secure connection, so it won't accept the setup code: it would travel across the internet unprotected. Choose a
          secure address below, then come back to this page there.
        </p>
      )}

      <div className="ui-divider" />

      <AddressChoice current={transport === "loopback" ? "ssh-tunnel" : transport === "https" ? "own-domain" : null} port={port} />
    </section>
  );
}
