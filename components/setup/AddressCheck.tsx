"use client";

import { useEffect, useState } from "react";
import { addressMismatch, expectedAddress } from "@/lib/setup/publicAddress";

/**
 * The setup wizard's address line: the address this CMS was configured with (POLYNOVEA_PUBLIC_URL), so
 * the admin can compare it with the address bar, and a warning when the browser is somewhere else.
 * Passkeys and sign-in belong to that exact address (scheme, host and port): http://127.0.0.1:3000 is
 * not http://localhost:3000 to a browser, and an SSH tunnel's local port is part of the address.
 */
export default function AddressCheck({ expected }: { expected: string | null }) {
  const [actual, setActual] = useState<string | null>(null);
  useEffect(() => { setActual(window.location.origin); }, []);

  if (!expected) {
    return (
      <p role="alert" className="ui-alert ui-alert-danger mb-6 text-sm">
        POLYNOVEA_PUBLIC_URL is not set (or is not a valid web address), so passkeys and sign-in can&apos;t work. Set it to the address you open in your browser (for an SSH
        tunnel: <code>http://localhost:3000</code>) and restart the CMS.
      </p>
    );
  }

  const { origin, tunnelCommand } = expectedAddress(expected);
  const mismatch = addressMismatch(expected, actual);

  return (
    <div className="mb-6 flex flex-col gap-2">
      <p className="text-sm text-fg-secondary">
        This CMS&apos;s address is <code>{origin}</code>. Open setup at exactly this address, including the port: passkeys and sign-in only
        work there.
        {tunnelCommand && (
          <>
            {" "}Through an SSH tunnel, forward that port:{" "}
            <code className="whitespace-nowrap">{tunnelCommand}</code>, then open <code>{origin}/setup</code>.
          </>
        )}
      </p>
      {mismatch && (
        <p role="alert" className="ui-alert ui-alert-warning text-sm">
          Your browser is on <code>{actual}</code>, not <code>{origin}</code>. A passkey made here would not work, and you couldn&apos;t sign
          in. Open <a className="underline" href={`${origin}/setup`}>{origin}/setup</a> instead, or set POLYNOVEA_PUBLIC_URL to the
          address you use and restart the CMS.
        </p>
      )}
    </div>
  );
}
