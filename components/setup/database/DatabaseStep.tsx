"use client";

import { useEffect, useId, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, Cloud, Database, Server, TriangleAlert } from "lucide-react";
import { runSetupStream, type SetupStreamEvent } from "./eventStream";
import SetupProgress, { applyProgressEvent, EMPTY_PROGRESS, type ProgressState } from "./SetupProgress";

/**
 * Step 2 of the setup wizard: choose where the database lives and watch it being prepared.
 * Every form is sent with fetch in a POST body; nothing typed here ever goes into the address bar.
 */

export interface BackupOptionView {
  kind: "s3" | "azure" | "same-server";
  title: string;
  recommended: boolean;
  cost: string;
  warning?: string;
}

type Choice = "managed" | "created" | "local";
type RunState = { phase: "idle" } | { phase: "running" } | { phase: "done"; restoreTestPending: boolean } | { phase: "failed"; message: string };

const inputClass =
  "w-full h-11 rounded-xl border border-subtle bg-surface-1 px-4 text-sm text-on-surface outline-none transition-all placeholder:text-fg-muted focus:border-primary focus-visible:ring-2 focus-visible:ring-primary/60 disabled:opacity-60";
const labelClass = "font-body text-[10px] font-semibold uppercase tracking-[0.1em] text-fg-muted";

function Field({ id, label, hint, children }: { id: string; label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className={labelClass}>{label}</label>
      {children}
      {hint && <p id={`${id}-hint`} className="text-xs text-fg-muted">{hint}</p>}
    </div>
  );
}

function OptionCard({ name, value, selected, disabled, onSelect, icon, title, badge, summary }: {
  name: string; value: Choice; selected: boolean; disabled?: boolean; onSelect: (value: Choice) => void;
  icon: React.ReactNode; title: string; badge?: string; summary: string;
}) {
  const id = `${name}-${value}`;
  return (
    <label htmlFor={id} className={`ui-card flex gap-3 rounded-lg border p-4 transition-colors ${disabled ? "cursor-not-allowed opacity-60" : "cursor-pointer"} ${selected ? "border-primary" : "border-subtle hover:border-default"}`}>
      <input id={id} type="radio" name={name} value={value} checked={selected} disabled={disabled} onChange={() => onSelect(value)} className="mt-1 accent-primary" />
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="flex flex-wrap items-center gap-2">
          {icon}
          <span className="text-sm font-semibold text-fg-primary">{title}</span>
          {badge && <span className="ui-badge ui-badge-info">{badge}</span>}
        </span>
        <span className="text-sm text-fg-secondary">{summary}</span>
      </span>
    </label>
  );
}

export default function DatabaseStep({ createdAvailable, localAvailable, localUnavailableReason, backupOptions, nextHref }: {
  createdAvailable: boolean;
  localAvailable: boolean;
  localUnavailableReason: string;
  backupOptions: BackupOptionView[];
  nextHref: string;
}) {
  const name = useId();
  const router = useRouter();
  const [choice, setChoice] = useState<Choice>(createdAvailable ? "created" : "managed");
  const [run, setRun] = useState<RunState>({ phase: "idle" });
  const [progress, setProgress] = useState<ProgressState>(EMPTY_PROGRESS);

  // Managed database form. The password is cleared from the page as soon as the run starts.
  const [hostname, setHostname] = useState("");
  const [port, setPort] = useState("5432");
  const [database, setDatabase] = useState("postgres");
  const [user, setUser] = useState("");
  const [password, setPassword] = useState("");

  // On this server.
  const [backupKind, setBackupKind] = useState<BackupOptionView["kind"]>("s3");
  const [bucket, setBucket] = useState("");
  const [region, setRegion] = useState("");
  const [account, setAccount] = useState("");
  const [container, setContainer] = useState("");

  const busy = run.phase === "running";

  // Once the database is ready, move on to the owner step (the button below stays as a fallback).
  useEffect(() => {
    if (run.phase !== "done") return;
    const timer = setTimeout(() => router.push(nextHref), 2500);
    return () => clearTimeout(timer);
  }, [run.phase, nextHref, router]);

  const start = async (url: string, body: unknown) => {
    setRun({ phase: "running" });
    setProgress(EMPTY_PROGRESS);
    let outcome: RunState = { phase: "failed", message: "The run ended without a result. Try again." };
    await runSetupStream(url, body, (event: SetupStreamEvent) => {
      if (event.type === "done") outcome = { phase: "done", restoreTestPending: Boolean(event.restoreTestPending) };
      else if (event.type === "error") outcome = { phase: "failed", message: event.message };
      else setProgress((current) => applyProgressEvent(current, event));
    });
    setRun(outcome);
  };

  const submitManaged = (event: React.FormEvent) => {
    event.preventDefault();
    const body = { hostname, port, database, user, password };
    setPassword("");
    void start("/api/setup/database/managed", body);
  };

  const submitCreated = (event: React.FormEvent) => {
    event.preventDefault();
    void start("/api/setup/database/created", {});
  };

  const submitLocal = (event: React.FormEvent) => {
    event.preventDefault();
    const body = backupKind === "s3" ? { kind: "s3", bucket, region } : backupKind === "azure" ? { kind: "azure", account, container } : { kind: "same-server" };
    void start("/api/setup/database/local", body);
  };

  if (run.phase === "done") {
    return (
      <div className="flex flex-col gap-4">
        <SetupProgress progress={progress} />
        <p role="status" className="ui-alert ui-alert-success">
          The database is ready. Polynovea CMS now has its own database users, and its settings are saved on this server, encrypted with the master key.
          {run.restoreTestPending ? " The first backup was verified; a full restore test will run as the backup service's first job." : ""} Taking you to the next step…
        </p>
        <a href={nextHref} className="ui-btn ui-btn-primary inline-flex items-center justify-center gap-2 self-start">
          Continue to the owner account
          <ArrowRight size={15} aria-hidden="true" />
        </a>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <fieldset className="flex flex-col gap-3" disabled={busy}>
        <legend className="mb-2 text-sm font-semibold text-fg-primary">Where should the database live?</legend>
        {createdAvailable && (
          <OptionCard name={name} value="created" selected={choice === "created"} onSelect={setChoice}
            icon={<Cloud size={15} aria-hidden="true" className="text-fg-muted" />} title="Created for you" badge="Recommended"
            summary="Our cloud template already made a managed database in your account. We'll connect to it and prepare it; there's nothing to type." />
        )}
        <OptionCard name={name} value="managed" selected={choice === "managed"} onSelect={setChoice}
          icon={<Database size={15} aria-hidden="true" className="text-fg-muted" />} title="Existing managed database" badge={createdAvailable ? undefined : "Recommended"}
          summary="Amazon RDS or Azure Database for PostgreSQL. Your cloud keeps the backups. You'll need the endpoint name and the admin login." />
        <OptionCard name={name} value="local" selected={choice === "local"} disabled={!localAvailable} onSelect={setChoice}
          icon={<Server size={15} aria-hidden="true" className="text-fg-muted" />} title="On this server" badge="For trials and small sites"
          summary={localAvailable ? "PostgreSQL runs on this server's data disk with automatic backups. You look after the server's disk, updates and uptime." : localUnavailableReason} />
      </fieldset>

      {choice === "managed" && (
        <form method="post" action="/api/setup/database/managed" onSubmit={submitManaged} aria-busy={busy} className="flex max-w-lg flex-col gap-4">
          <Field id="db-host" label="Endpoint name" hint="From your cloud console, for example mydb.abc123.eu-west-1.rds.amazonaws.com. Not an IP address.">
            <input id="db-host" value={hostname} onChange={(e) => setHostname(e.target.value)} required disabled={busy} autoComplete="off" spellCheck={false} maxLength={255} aria-describedby="db-host-hint" className={inputClass} />
          </Field>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-[8rem_1fr]">
            <Field id="db-port" label="Port">
              <input id="db-port" inputMode="numeric" value={port} onChange={(e) => setPort(e.target.value)} required disabled={busy} maxLength={5} className={inputClass} />
            </Field>
            <Field id="db-name" label="Database name">
              <input id="db-name" value={database} onChange={(e) => setDatabase(e.target.value)} required disabled={busy} autoComplete="off" spellCheck={false} maxLength={63} className={inputClass} />
            </Field>
          </div>
          <Field id="db-user" label="Admin username" hint="The master or administrator login your cloud created with the database.">
            <input id="db-user" value={user} onChange={(e) => setUser(e.target.value)} required disabled={busy} autoComplete="off" spellCheck={false} maxLength={63} aria-describedby="db-user-hint" className={inputClass} />
          </Field>
          <Field id="db-password" label="Admin password" hint="Used once to create Polynovea's own database users, then forgotten. It is never saved.">
            <input id="db-password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} required disabled={busy} autoComplete="off" maxLength={1024} aria-describedby="db-password-hint" className={inputClass} />
          </Field>
          <button type="submit" disabled={busy} className="ui-btn ui-btn-primary inline-flex items-center justify-center gap-2 self-start">
            {busy ? "Working…" : "Check and set up the database"}
          </button>
        </form>
      )}

      {choice === "created" && createdAvailable && (
        <form method="post" action="/api/setup/database/created" onSubmit={submitCreated} aria-busy={busy} className="flex flex-col gap-4">
          <p className="text-sm text-fg-secondary">
            We'll read the database's admin login from the secret your cloud template made (this server is allowed to read it), run the same checks as for any managed database, and create Polynovea's own database users. The admin login isn't saved.
          </p>
          <button type="submit" disabled={busy} className="ui-btn ui-btn-primary inline-flex items-center justify-center gap-2 self-start">
            {busy ? "Working…" : "Set up the database"}
          </button>
        </form>
      )}

      {choice === "local" && localAvailable && (
        <form method="post" action="/api/setup/database/local" onSubmit={submitLocal} aria-busy={busy} className="flex flex-col gap-4">
          <fieldset className="flex flex-col gap-3" disabled={busy}>
            <legend className="mb-1 text-sm font-semibold text-fg-primary">Where should backups go?</legend>
            {backupOptions.map((option) => (
              <label key={option.kind} className={`ui-card flex cursor-pointer gap-3 rounded-lg border p-4 ${backupKind === option.kind ? "border-primary" : "border-subtle"}`}>
                <input type="radio" name={`${name}-backup`} value={option.kind} checked={backupKind === option.kind} onChange={() => setBackupKind(option.kind)} className="mt-1 accent-primary" />
                <span className="flex flex-col gap-1">
                  <span className="text-sm font-semibold text-fg-primary">{option.title}</span>
                  <span className="text-sm text-fg-secondary">{option.cost}</span>
                  {option.warning && (
                    <span className="flex gap-2 text-sm text-warning">
                      <TriangleAlert size={15} aria-hidden="true" className="mt-0.5 shrink-0" />
                      {option.warning}
                    </span>
                  )}
                </span>
              </label>
            ))}
          </fieldset>
          {backupKind === "s3" && (
            <div className="grid max-w-lg grid-cols-1 gap-4 sm:grid-cols-2">
              <Field id="backup-bucket" label="S3 bucket"><input id="backup-bucket" value={bucket} onChange={(e) => setBucket(e.target.value)} required disabled={busy} spellCheck={false} className={inputClass} /></Field>
              <Field id="backup-region" label="Bucket region"><input id="backup-region" value={region} onChange={(e) => setRegion(e.target.value)} required disabled={busy} placeholder="eu-west-1" spellCheck={false} className={inputClass} /></Field>
            </div>
          )}
          {backupKind === "azure" && (
            <div className="grid max-w-lg grid-cols-1 gap-4 sm:grid-cols-2">
              <Field id="backup-account" label="Storage account"><input id="backup-account" value={account} onChange={(e) => setAccount(e.target.value)} required disabled={busy} spellCheck={false} className={inputClass} /></Field>
              <Field id="backup-container" label="Container"><input id="backup-container" value={container} onChange={(e) => setContainer(e.target.value)} required disabled={busy} spellCheck={false} className={inputClass} /></Field>
            </div>
          )}
          <p className="text-sm text-fg-secondary">Setup finishes only after the first full backup has been taken and verified.</p>
          <button type="submit" disabled={busy} className="ui-btn ui-btn-primary inline-flex items-center justify-center gap-2 self-start">
            {busy ? "Working…" : "Set up the database and backups"}
          </button>
        </form>
      )}

      <SetupProgress progress={progress} />

      {run.phase === "failed" && (
        <p role="alert" className="ui-alert ui-alert-danger">{run.message}</p>
      )}
    </div>
  );
}
