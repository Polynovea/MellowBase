"use client";

import { useCallback, useEffect, useState } from "react";
import { CheckCircle2, CircleAlert, HeartPulse, RefreshCw, Rocket, TriangleAlert } from "lucide-react";
import AdminLayout from "@/components/admin/AdminLayout";
import { getAuthHeaders } from "@/lib/admin/authCheck";

// The System page (design: "Operations"): health, backups and restore tests, and upgrades to newer
// signed releases. Everything here comes from /api/system; nothing upgrades without the button.

type Check = { key: string; severity: "ok" | "info" | "warning" | "blocking"; message: string };
type Step = { step: string; outcome: string; at: string; detail?: string };
type Upgrade = { request_id: string; from_release: string | null; to_release: string; rollback_mode: string; status: string; steps_json: Step[]; requested_at: string; finished_at: string | null };
type RestoreTest = { id: string; reason: string; status: string; backup_label: string | null; error_message: string | null; started_at: string; finished_at: string | null };
type Release = {
  configured: boolean;
  current: { releaseId: string | null; version: string | null };
  latest: { releaseId: string; version: string; rollback: "compatible" | "restore"; changelog: string | null; createdAt: string | null } | null;
  upgradeAvailable: boolean;
  error: string | null;
};
type State = { checks: Check[]; upgrades: Upgrade[]; restoreTests: RestoreTest[]; upgradeAgent: boolean; release: Release | null };

const CHECK_NAMES: Record<string, string> = {
  "system.database": "Database",
  "system.tls": "Database encryption",
  "system.disk": "Disk space",
  "system.backup": "Backups",
  "system.restore_test": "Restore test",
  "system.migrations": "Database migrations",
  "system.worker": "Background worker",
  "system.auth_advisories": "Sign-in library",
};
const STATUS_TEXT: Record<string, string> = {
  requested: "Waiting for the upgrade agent",
  running: "Upgrading",
  succeeded: "Upgraded",
  rolled_back: "Switched back to the previous release",
  restore_needed: "Switched back; the database must be restored",
  failed: "Failed; nothing was changed",
  passed: "Passed",
  skipped: "Skipped",
};

async function authFetch(input: string, init: RequestInit = {}) {
  const auth = await getAuthHeaders();
  if (!auth.Authorization) throw new Error("Admin session unavailable. Please sign in again.");
  const headers = new Headers(init.headers);
  for (const [key, value] of Object.entries(auth)) headers.set(key, value);
  if (init.body) headers.set("content-type", "application/json");
  return fetch(input, { ...init, headers });
}

function SeverityIcon({ severity }: { severity: Check["severity"] }) {
  if (severity === "blocking") return <CircleAlert size={16} className="text-danger" aria-label="Needs attention" />;
  if (severity === "warning") return <TriangleAlert size={16} className="text-warning" aria-label="Warning" />;
  return <CheckCircle2 size={16} className="text-success" aria-label="OK" />;
}

const when = (value: string | null) => (value ? new Date(value).toLocaleString() : "—");

export default function SystemPage() {
  const [state, setState] = useState<State | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [confirmRestore, setConfirmRestore] = useState(false);
  const [starting, setStarting] = useState(false);

  const load = useCallback(async (withRelease = false) => {
    setError(null);
    if (withRelease) setChecking(true);
    try {
      const response = await authFetch(`/api/system${withRelease ? "?release=1" : ""}`);
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "Could not load the system state.");
      setState((previous) => ({ ...body.data, release: body.data.release ?? previous?.release ?? null }));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not load the system state.");
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    void load(false);
  }, [load]);

  const open = state?.upgrades.find((upgrade) => upgrade.status === "requested" || upgrade.status === "running");
  useEffect(() => {
    if (!open) return;
    const timer = setInterval(() => void load(false), 5000);
    return () => clearInterval(timer);
  }, [open, load]);

  async function startUpgrade() {
    const latest = state?.release?.latest;
    if (!latest) return;
    setStarting(true);
    setError(null);
    try {
      const response = await authFetch("/api/system", { method: "POST", body: JSON.stringify({ operation: "upgrade", releaseId: latest.releaseId, acknowledgeRestore: confirmRestore }) });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "Could not start the upgrade.");
      setNotice(`Upgrade to ${latest.version} started. This page updates as it runs; the CMS is unavailable for about a minute while it switches.`);
      await load(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not start the upgrade.");
    } finally {
      setStarting(false);
    }
  }

  const release = state?.release;
  const latest = release?.latest;
  const failedRestore = state?.restoreTests[0]?.status === "failed" ? state.restoreTests[0] : null;
  const needsAck = latest?.rollback !== "compatible";

  return (
    <AdminLayout>
      <div className="ui-page mx-auto max-w-5xl">
        <header className="ui-page-header">
          <div>
            <p className="ui-eyebrow">Self-hosted server</p>
            <h1 className="ui-page-title">System</h1>
            <p className="ui-page-description">Health, backups and upgrades for this server.</p>
          </div>
          <button onClick={() => void load(false)} className="ui-btn ui-btn-secondary"><RefreshCw size={14} />Refresh</button>
        </header>

        {error ? <div className="ui-alert ui-alert-danger mt-5" role="alert">{error}</div> : null}
        {notice ? <div className="ui-alert ui-alert-success mt-5" role="status">{notice}</div> : null}
        {failedRestore ? (
          <div className="ui-alert ui-alert-danger mt-5" role="alert">
            The last restore test failed ({when(failedRestore.finished_at)}): {failedRestore.error_message}. Your backups may not be restorable. Check the backup location and run a restore test again.
          </div>
        ) : null}

        <section className="mt-8" aria-labelledby="health-heading">
          <h2 id="health-heading" className="flex items-center gap-2 text-base font-semibold"><HeartPulse size={16} />Health</h2>
          <ul className="mt-3 divide-y divide-[var(--border-subtle)] rounded-lg border border-[var(--border-subtle)]">
            {(state?.checks ?? []).map((check) => (
              <li key={check.key} className="flex items-start gap-3 px-4 py-3">
                <span className="mt-0.5"><SeverityIcon severity={check.severity} /></span>
                <div className="min-w-0">
                  <p className="text-sm font-medium">{CHECK_NAMES[check.key] ?? check.key}</p>
                  <p className="text-[13px] text-fg-secondary">{check.message}</p>
                </div>
              </li>
            ))}
            {!state ? <li className="px-4 py-3 text-sm text-fg-muted">Loading…</li> : null}
          </ul>
        </section>

        <section className="mt-10" aria-labelledby="upgrade-heading">
          <h2 id="upgrade-heading" className="flex items-center gap-2 text-base font-semibold"><Rocket size={16} />Upgrades</h2>
          <p className="mt-2 text-[13px] text-fg-secondary">
            Running release: <strong>{release?.current.releaseId ?? "not reported"}</strong>
          </p>
          {!state?.upgradeAgent ? (
            <p className="mt-2 text-[13px] text-fg-muted">This server has no upgrade agent, so upgrades are done by hand (see the self-hosting guide).</p>
          ) : null}
          <button onClick={() => void load(true)} disabled={checking} className="ui-btn ui-btn-secondary mt-3">
            <RefreshCw size={14} />{checking ? "Checking…" : "Check for updates"}
          </button>
          {release && !release.configured ? <p className="mt-3 text-[13px] text-fg-muted">No release channel is set (POLYNOVEA_RELEASE_CHANNEL_URL), so this server does not look for updates.</p> : null}
          {release?.error ? <div className="ui-alert ui-alert-danger mt-3">{release.error}</div> : null}
          {release?.configured && !release.error && !release.upgradeAvailable ? <p className="mt-3 text-[13px] text-fg-secondary">This server runs the newest signed release.</p> : null}

          {latest && release?.upgradeAvailable ? (
            <div className="mt-4 rounded-lg border border-[var(--border-subtle)] p-4">
              <p className="text-sm font-medium">Release {latest.version} is available (signature verified).</p>
              {latest.changelog ? <pre className="mt-3 max-h-80 overflow-auto whitespace-pre-wrap text-[13px] text-fg-secondary">{latest.changelog}</pre> : <p className="mt-2 text-[13px] text-fg-muted">This release has no changelog.</p>}
              <p className="mt-3 text-[13px] text-fg-secondary">
                The upgrade takes a backup, checks the signature, updates the database, and starts the new release. The CMS is unavailable for about a minute. If the new release is not healthy within 2 minutes, the server switches back automatically.
              </p>
              {needsAck ? (
                <label className="mt-3 flex items-start gap-2 text-[13px]">
                  <input type="checkbox" checked={confirmRestore} onChange={(event) => setConfirmRestore(event.target.checked)} className="mt-0.5" />
                  <span>
                    This release changes the database in a way the current release cannot use. If the upgrade fails, the switch-back restores the backup taken at the start, and changes made after that are lost. On a cloud database the restore must be done by hand from that backup. I understand.
                  </span>
                </label>
              ) : null}
              <button onClick={() => void startUpgrade()} disabled={starting || Boolean(open) || !state?.upgradeAgent || (needsAck && !confirmRestore)} className="ui-btn ui-btn-primary mt-4">
                {starting ? "Starting…" : `Upgrade to ${latest.version}`}
              </button>
            </div>
          ) : null}

          {(state?.upgrades ?? []).length ? (
            <ul className="mt-6 space-y-3">
              {state!.upgrades.map((upgrade) => (
                <li key={upgrade.request_id} className="rounded-lg border border-[var(--border-subtle)] p-4">
                  <p className="text-sm font-medium">{upgrade.from_release ?? "?"} → {upgrade.to_release}: {STATUS_TEXT[upgrade.status] ?? upgrade.status}</p>
                  <p className="text-[12px] text-fg-muted">Started {when(upgrade.requested_at)}{upgrade.finished_at ? `, finished ${when(upgrade.finished_at)}` : ""}</p>
                  {upgrade.status === "restore_needed" ? (
                    <p className="mt-2 text-[13px] text-danger">The previous release is running on a database it may not fully understand. Restore the pre-upgrade backup (the dump in backups/pre-upgrade on the data disk, or the cloud backup from before the upgrade) following the self-hosting guide.</p>
                  ) : null}
                  {upgrade.steps_json.length ? (
                    <ol className="mt-2 space-y-0.5 text-[12px] text-fg-secondary">
                      {upgrade.steps_json.filter((step) => step.outcome !== "started").map((step, index) => (
                        <li key={index}>{step.step}: {step.outcome}{step.detail ? ` (${step.detail})` : ""}</li>
                      ))}
                    </ol>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : null}
        </section>

        <section className="mt-10 pb-10" aria-labelledby="restore-heading">
          <h2 id="restore-heading" className="text-base font-semibold">Restore tests</h2>
          <p className="mt-2 text-[13px] text-fg-secondary">Each month the server restores its newest backup into a temporary copy, checks it, and deletes it.</p>
          <ul className="mt-3 space-y-1 text-[13px]">
            {(state?.restoreTests ?? []).map((test) => (
              <li key={test.id}>
                {when(test.finished_at ?? test.started_at)}: {STATUS_TEXT[test.status] ?? test.status}
                {test.backup_label ? ` (backup ${test.backup_label})` : ""}
                {test.error_message ? `: ${test.error_message}` : ""}
              </li>
            ))}
            {state && !state.restoreTests.length ? <li className="text-fg-muted">No restore test has run yet.</li> : null}
          </ul>
        </section>
      </div>
    </AdminLayout>
  );
}
