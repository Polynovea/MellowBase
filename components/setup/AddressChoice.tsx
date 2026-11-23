"use client";

import { useId, useState } from "react";
import { Globe, TerminalSquare, TriangleAlert } from "lucide-react";

/**
 * How the owner reaches the wizard over a secure connection, each route labelled with what it
 * costs. The setup code is only accepted over HTTPS or through an SSH tunnel to localhost.
 *
 * - Own domain (about $10–15 a year at a registrar): a stable HTTPS address; the authenticator app
 *   and a passkey are enrolled in the wizard and keep working.
 * - SSH tunnel to localhost (free): the free fallback. sslip.io and nip.io were rejected: they are
 *   not on the Public Suffix List, so Let's Encrypt's 50-certificates-a-week limit is shared by
 *   everyone using them. Free subdomains that are on the list (duckdns.org, dedyn.io, dynv6.net)
 *   are pending approval and only mentioned, not offered.
 *
 * Every free route carries the passkey warning: a passkey works only on the address it was made on.
 */

export type AddressRoute = "own-domain" | "ssh-tunnel";

function PasskeyWarning() {
  return (
    <div role="note" className="ui-alert ui-alert-warning flex gap-2">
      <TriangleAlert size={16} aria-hidden="true" className="mt-0.5 shrink-0" />
      <p className="text-sm">
        A passkey only works on the address it was created on. If this CMS moves to a different address later, you'll sign in with your
        authenticator app instead, and the CMS will ask you to register a new passkey.
      </p>
    </div>
  );
}

function Option({
  route, selected, current, onSelect, name, icon, title, cost, summary,
}: {
  route: AddressRoute; selected: boolean; current: boolean; onSelect: (route: AddressRoute) => void; name: string;
  icon: React.ReactNode; title: string; cost: string; summary: string;
}) {
  const id = `${name}-${route}`;
  return (
    <label
      htmlFor={id}
      className={`ui-card flex cursor-pointer gap-3 rounded-lg border p-4 transition-colors ${selected ? "border-primary" : "border-subtle hover:border-default"}`}
    >
      <input id={id} type="radio" name={name} value={route} checked={selected} onChange={() => onSelect(route)} className="mt-1 accent-primary" />
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="flex flex-wrap items-center gap-2">
          {icon}
          <span className="text-sm font-semibold text-fg-primary">{title}</span>
          <span className="ui-badge ui-badge-info">{cost}</span>
          {current && <span className="ui-badge ui-badge-success">You're using this</span>}
        </span>
        <span className="text-sm text-fg-secondary">{summary}</span>
      </span>
    </label>
  );
}

export default function AddressChoice({ current, port = "3000" }: { current: AddressRoute | null; port?: string }) {
  const name = useId();
  const [route, setRoute] = useState<AddressRoute>(current ?? "own-domain");

  return (
    <fieldset className="flex flex-col gap-3">
      <legend className="mb-2 text-sm font-semibold text-fg-primary">{current ? "Your secure address" : "Choose a secure address"}</legend>

      <Option
        route="own-domain" name={name} selected={route === "own-domain"} current={current === "own-domain"} onSelect={setRoute}
        icon={<Globe size={15} aria-hidden="true" className="text-fg-muted" />}
        title="Your own domain"
        cost="About $10–15 a year, paid to a domain registrar"
        summary="A permanent HTTPS address such as cms.yourcompany.com. You'll set up an authenticator app and a passkey in this wizard, and both keep working."
      />
      {route === "own-domain" && !current && (
        <ol className="ml-5 list-decimal space-y-1.5 text-sm text-fg-secondary">
          <li>Buy a domain from any registrar, or use one you already own.</li>
          <li>Point it at this server: add an A record (and AAAA for IPv6) with the server's public address.</li>
          <li>
            Put a web server that handles HTTPS in front of the CMS. Caddy does it automatically, and the certificate itself is free from Let's
            Encrypt.
          </li>
          <li>
            Tell the CMS its address: set <code>POLYNOVEA_PUBLIC_URL</code> to <code>https://your-domain</code> and <code>POLYNOVEA_TRUSTED_PROXIES</code>{" "}
            to the web server's address (<code>127.0.0.1</code> if it runs on this machine), then restart the CMS.
          </li>
          <li>
            Open <code>https://your-domain/setup</code> and enter the new code from the server log.
          </li>
        </ol>
      )}

      <Option
        route="ssh-tunnel" name={name} selected={route === "ssh-tunnel"} current={current === "ssh-tunnel"} onSelect={setRoute}
        icon={<TerminalSquare size={15} aria-hidden="true" className="text-fg-muted" />}
        title="SSH tunnel to localhost"
        cost="Free"
        summary="Reach the wizard through the SSH connection you already use to manage the server. Nothing to buy; you can add a domain later."
      />
      {route === "ssh-tunnel" && (
        <div className="flex flex-col gap-3">
          {!current && (
            <ol className="ml-5 list-decimal space-y-1.5 text-sm text-fg-secondary">
              <li>
                On your own computer, open a terminal and run:{" "}
                <code className="whitespace-nowrap">
                  ssh -L {port}:localhost:{port} you@your-server
                </code>
              </li>
              <li>Leave that window open.</li>
              <li>
                In your browser, open <code>http://localhost:{port}/setup</code> and enter the code from the server log.
              </li>
            </ol>
          )}
          <PasskeyWarning />
        </div>
      )}

      <p className="text-xs text-fg-muted">
        Free subdomains from duckdns.org, dedyn.io or dynv6.net are pending approval and not available yet. The passkey note above would apply to
        them too.
      </p>
    </fieldset>
  );
}
