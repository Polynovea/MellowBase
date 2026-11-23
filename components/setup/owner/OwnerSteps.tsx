"use client";

import { useMemo, useState } from "react";
import { encode } from "uqr";
import { ownerApi, OwnerApiError, type OwnerSummary } from "@/components/setup/owner/ownerApi";
import { createPasskey, passkeysSupported } from "@/components/setup/owner/webauthn";

/** The owner step's screens. Each calls one action and reports back with onDone. */

const labelClass = "font-body text-[10px] font-semibold uppercase tracking-[0.1em] text-fg-muted";
const inputClass =
  "w-full h-12 rounded-xl border border-subtle bg-surface-1 px-4 text-sm text-on-surface outline-none transition-all placeholder:text-fg-muted focus:border-primary focus-visible:ring-2 focus-visible:ring-primary/60";
const monoInput = `${inputClass} font-mono tracking-[0.06em]`;

export interface StepProps {
  summary: OwnerSummary;
  onDone: () => void;
  onSessionLost: (message: string) => void;
}

function useAction(onSessionLost: (message: string) => void) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const run = async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
    setError("");
    setBusy(true);
    try {
      return await fn();
    } catch (caught) {
      if (caught instanceof OwnerApiError && caught.needsSetupCode) onSessionLost(caught.message);
      else setError(caught instanceof Error ? caught.message : "Something went wrong. Try again.");
      return undefined;
    } finally {
      setBusy(false);
    }
  };
  return { error, busy, run, setError };
}

function Field({ id, label, hint, children }: { id: string; label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className={labelClass}>{label}</label>
      {children}
      {hint && <p id={`${id}-hint`} className="text-xs text-fg-muted">{hint}</p>}
    </div>
  );
}

function ErrorNote({ id, message }: { id: string; message: string }) {
  if (!message) return null;
  return <p id={id} role="alert" className="ui-alert ui-alert-danger">{message}</p>;
}

function Submit({ busy, label, disabled }: { busy: boolean; label: string; disabled?: boolean }) {
  return (
    <button type="submit" disabled={busy || disabled} className="ui-btn ui-btn-primary self-start">
      {busy ? "Working…" : label}
    </button>
  );
}

function StepHeader({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <header className="flex flex-col gap-2">
      <h3 className="ui-section-title">{title}</h3>
      <div className="ui-section-description flex flex-col gap-2">{children}</div>
    </header>
  );
}

// ── 1. Account ───────────────────────────────────────────────────────────────

export function AccountStep({ summary, onDone, onSessionLost }: StepProps) {
  const [email, setEmail] = useState(summary.email ?? "");
  const [displayName, setDisplayName] = useState(summary.displayName ?? "");
  const [password, setPassword] = useState("");
  const [repeat, setRepeat] = useState("");
  const { error, busy, run, setError } = useAction(onSessionLost);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (password !== repeat) return setError("The two passwords don't match.");
    const done = await run(() => ownerApi.post("account", { email, displayName, password }));
    if (done) {
      setPassword("");
      setRepeat("");
      onDone();
    }
  };

  return (
    <form onSubmit={submit} aria-busy={busy} className="flex max-w-md flex-col gap-4">
      <StepHeader title="Your owner account">
        <p>You&apos;ll be the owner: the one account that can do everything, including adding other people.</p>
        <p>Use a long password: at least 15 characters. A short sentence you&apos;ll remember works well. Next you&apos;ll add two more ways to prove it&apos;s you.</p>
      </StepHeader>
      <Field id="owner-email" label="Email">
        <input id="owner-email" type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} className={inputClass} />
      </Field>
      <Field id="owner-name" label="Your name">
        <input id="owner-name" type="text" autoComplete="name" required maxLength={120} value={displayName} onChange={(e) => setDisplayName(e.target.value)} className={inputClass} />
      </Field>
      <Field id="owner-password" label="Password" hint="At least 15 characters. It's checked against lists of leaked passwords.">
        <input id="owner-password" type="password" autoComplete="new-password" required minLength={15} maxLength={128} value={password} onChange={(e) => setPassword(e.target.value)} aria-describedby="owner-password-hint" className={inputClass} />
      </Field>
      <Field id="owner-password-repeat" label="Password again">
        <input id="owner-password-repeat" type="password" autoComplete="new-password" required value={repeat} onChange={(e) => setRepeat(e.target.value)} className={inputClass} />
      </Field>
      <ErrorNote id="owner-account-error" message={error} />
      <Submit busy={busy} label="Continue" />
    </form>
  );
}

// ── 2. Authenticator app ─────────────────────────────────────────────────────

function QrCode({ value }: { value: string }) {
  const { data, size } = useMemo(() => encode(value, { ecc: "M", border: 2 }), [value]);
  return (
    <svg viewBox={`0 0 ${size} ${size}`} role="img" aria-label="QR code for your authenticator app" className="h-48 w-48 rounded-lg bg-white p-1" shapeRendering="crispEdges">
      {data.flatMap((row, y) => row.map((dark, x) => (dark ? <rect key={`${x}-${y}`} x={x} y={y} width={1} height={1} fill="#000" /> : null)))}
    </svg>
  );
}

export function AuthenticatorStep({ onDone, onSessionLost }: StepProps) {
  const [uri, setUri] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const { error, busy, run } = useAction(onSessionLost);
  const manualKey = uri ? new URL(uri).searchParams.get("secret") : null;

  const start = async () => {
    const result = await run(() => ownerApi.post<{ totpURI: string }>("totp-start"));
    if (result) setUri(result.totpURI);
  };
  const confirm = async (event: React.FormEvent) => {
    event.preventDefault();
    if (await run(() => ownerApi.post("totp-confirm", { code }))) onDone();
  };

  return (
    <div className="flex max-w-md flex-col gap-4">
      <StepHeader title="Add an authenticator app">
        <p>An authenticator app on your phone (for example Google Authenticator, Microsoft Authenticator or 1Password) shows a new 6-digit code every 30 seconds. You&apos;ll type one each time you sign in with your password.</p>
      </StepHeader>
      {!uri ? (
        <button type="button" onClick={() => void start()} disabled={busy} className="ui-btn ui-btn-primary self-start">{busy ? "Working…" : "Show the QR code"}</button>
      ) : (
        <form onSubmit={confirm} aria-busy={busy} className="flex flex-col gap-4">
          <QrCode value={uri} />
          <p className="text-xs text-fg-muted">
            Can&apos;t scan it? Add an account by hand with this key: <code className="break-all font-mono text-fg-primary">{manualKey}</code>
          </p>
          <Field id="owner-totp" label="Code from the app">
            <input id="owner-totp" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9 ]{6,7}" required value={code} onChange={(e) => setCode(e.target.value)} className={monoInput} />
          </Field>
          <ErrorNote id="owner-totp-error" message={error} />
          <Submit busy={busy} label="Check the code" />
        </form>
      )}
      {!uri && <ErrorNote id="owner-totp-start-error" message={error} />}
    </div>
  );
}

// ── 3. Passkey ───────────────────────────────────────────────────────────────

export function PasskeyStep({ summary, onDone, onSessionLost }: StepProps) {
  const { error, busy, run, setError } = useAction(onSessionLost);
  const supported = passkeysSupported();

  const add = async () => {
    const options = await run(() => ownerApi.post<{ options: Parameters<typeof createPasskey>[0] }>("passkey-options"));
    if (!options) return;
    let response: Record<string, unknown>;
    try {
      response = await createPasskey(options.options);
    } catch (caught) {
      const name = (caught as { name?: string })?.name;
      setError(name === "NotAllowedError" ? "The passkey wasn't created (it was cancelled or timed out). Try again." : "Your browser couldn't create a passkey. Try again, or use another browser or device.");
      return;
    }
    if (await run(() => ownerApi.post("passkey", { response }))) onDone();
  };

  return (
    <div className="flex max-w-md flex-col gap-4">
      <StepHeader title="Add a passkey">
        <p>A passkey lets you sign in with your fingerprint, face or device PIN instead of typing a code. It&apos;s required for the owner, so you can still get in if your phone is lost.</p>
      </StepHeader>
      {summary.temporaryRouteWarning && (
        <p role="note" className="ui-alert ui-alert-warning">{summary.temporaryRouteWarning}</p>
      )}
      {!supported && (
        <p role="alert" className="ui-alert ui-alert-warning">This browser can&apos;t create passkeys. Open this page in a current version of Chrome, Edge, Safari or Firefox.</p>
      )}
      <ErrorNote id="owner-passkey-error" message={error} />
      <button type="button" onClick={() => void add()} disabled={busy || !supported} className="ui-btn ui-btn-primary self-start">{busy ? "Waiting for your device…" : "Add a passkey"}</button>
    </div>
  );
}

// ── 4. Recovery codes ────────────────────────────────────────────────────────

export function RecoveryStep({ onDone, onSessionLost }: StepProps) {
  const [codes, setCodes] = useState<string[] | null>(null);
  const [confirmNumber, setConfirmNumber] = useState(0);
  const [typed, setTyped] = useState("");
  const { error, busy, run } = useAction(onSessionLost);

  const issue = async () => {
    const result = await run(() => ownerApi.post<{ codes: string[]; confirmNumber: number }>("recovery-codes"));
    if (result) {
      setCodes(result.codes);
      setConfirmNumber(result.confirmNumber);
      setTyped("");
    }
  };
  const download = () => {
    if (!codes) return;
    const url = URL.createObjectURL(new Blob([`Polynovea CMS recovery codes\nEach code works once.\n\n${codes.join("\n")}\n`], { type: "text/plain" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = "polynovea-recovery-codes.txt";
    link.click();
    URL.revokeObjectURL(url);
  };
  const confirm = async (event: React.FormEvent) => {
    event.preventDefault();
    if (await run(() => ownerApi.post("recovery-confirm", { code: typed }))) {
      setCodes(null);
      onDone();
    }
  };

  return (
    <div className="flex max-w-md flex-col gap-4">
      <StepHeader title="Save your recovery codes">
        <p>If you lose your phone and your passkey, each of these codes lets you sign in once. They&apos;re shown only now: save them in a password manager or print them, away from this server.</p>
      </StepHeader>
      {!codes ? (
        <button type="button" onClick={() => void issue()} disabled={busy} className="ui-btn ui-btn-primary self-start">{busy ? "Working…" : "Show my recovery codes"}</button>
      ) : (
        <>
          <ol className="grid grid-cols-2 gap-2 font-mono text-[13px] text-fg-primary">
            {codes.map((code, index) => <li key={code}><span className="text-fg-muted">{index + 1}.</span> {code}</li>)}
          </ol>
          <div className="flex flex-wrap gap-2">
            <button type="button" className="ui-btn ui-btn-secondary" onClick={() => void navigator.clipboard?.writeText(codes.join("\n"))}>Copy</button>
            <button type="button" className="ui-btn ui-btn-secondary" onClick={download}>Download</button>
          </div>
          <form onSubmit={confirm} aria-busy={busy} className="flex flex-col gap-4">
            <Field id="owner-recovery" label={`Type code number ${confirmNumber} to show you saved them`}>
              <input id="owner-recovery" autoComplete="off" spellCheck={false} required value={typed} onChange={(e) => setTyped(e.target.value)} className={monoInput} />
            </Field>
            <ErrorNote id="owner-recovery-error" message={error} />
            <Submit busy={busy} label="Confirm" />
          </form>
        </>
      )}
      {!codes && <ErrorNote id="owner-recovery-issue-error" message={error} />}
    </div>
  );
}

// ── 5. Organisation ──────────────────────────────────────────────────────────

export function OrganisationStep({ summary, onDone, onSessionLost }: StepProps) {
  const [organisationName, setOrganisationName] = useState(summary.organisation?.organisationName ?? "");
  const [workspaceName, setWorkspaceName] = useState(summary.organisation?.workspaceName ?? "");
  const [starterContent, setStarterContent] = useState(summary.organisation?.starterContent ?? true);
  const { error, busy, run } = useAction(onSessionLost);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (await run(() => ownerApi.post("organisation", { organisationName, workspaceName, starterContent }))) onDone();
  };

  return (
    <form onSubmit={submit} aria-busy={busy} className="flex max-w-md flex-col gap-4">
      <StepHeader title="Your organisation">
        <p>These names appear in the CMS. You can change them later.</p>
      </StepHeader>
      <Field id="owner-organisation" label="Organisation name">
        <input id="owner-organisation" autoComplete="organization" required maxLength={200} value={organisationName} onChange={(e) => setOrganisationName(e.target.value)} className={inputClass} />
      </Field>
      <Field id="owner-workspace" label="Workspace name" hint="The space your team's content lives in, for example your website's name.">
        <input id="owner-workspace" required maxLength={120} value={workspaceName} onChange={(e) => setWorkspaceName(e.target.value)} aria-describedby="owner-workspace-hint" className={inputClass} />
      </Field>
      <label className="flex items-start gap-3 text-sm">
        <input type="checkbox" checked={starterContent} onChange={(e) => setStarterContent(e.target.checked)} className="mt-1" />
        <span>Add starter content: an example article type and a draft welcome article to explore. You can delete them any time.</span>
      </label>
      <ErrorNote id="owner-organisation-error" message={error} />
      <Submit busy={busy} label="Continue" />
    </form>
  );
}

// ── 6. Keys ──────────────────────────────────────────────────────────────────

interface Keys {
  masterKey: string | null;
  backupRepoPassword: string | null;
}

function SecretBlock({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-2 rounded-xl border border-subtle bg-surface-1 p-3">
      <p className={labelClass}>{label}</p>
      <code className="break-all font-mono text-[13px] text-fg-primary">{value}</code>
      <button type="button" className="ui-btn ui-btn-secondary self-start" onClick={() => void navigator.clipboard?.writeText(value)}>Copy</button>
    </div>
  );
}

export function KeysStep({ onDone, onSessionLost }: StepProps) {
  const [keys, setKeys] = useState<Keys | null>(null);
  const [masterKeyTail, setMasterKeyTail] = useState("");
  const [backupTail, setBackupTail] = useState("");
  const { error, busy, run } = useAction(onSessionLost);

  const reveal = async () => {
    const result = await run(() => ownerApi.post<Keys>("keys-reveal"));
    if (result) setKeys(result);
  };
  const confirm = async (event: React.FormEvent) => {
    event.preventDefault();
    if (await run(() => ownerApi.post("keys-confirm", { masterKeyTail, backupTail }))) {
      setKeys(null);
      onDone();
    }
  };
  const nothingToShow = keys && !keys.masterKey && !keys.backupRepoPassword;

  return (
    <div className="flex max-w-xl flex-col gap-4">
      <StepHeader title="Save your keys">
        <p>The master key unlocks the CMS&apos;s stored passwords and settings. Without it, a restored backup can&apos;t be read. Keep a copy in a password manager, away from this server and its backups.</p>
      </StepHeader>
      {!keys ? (
        <button type="button" onClick={() => void reveal()} disabled={busy} className="ui-btn ui-btn-primary self-start">{busy ? "Working…" : "Show my keys"}</button>
      ) : (
        <form onSubmit={confirm} aria-busy={busy} className="flex flex-col gap-4">
          {keys.masterKey && <SecretBlock label="Master key" value={keys.masterKey} />}
          {keys.backupRepoPassword && <SecretBlock label="Backup password (database on this server)" value={keys.backupRepoPassword} />}
          {nothingToShow && <p className="ui-alert ui-alert-success">Your server&apos;s administrator supplied the master key, so there&apos;s nothing new to save here.</p>}
          {keys.masterKey && (
            <Field id="owner-master-tail" label="Last 6 characters of the master key">
              <input id="owner-master-tail" autoComplete="off" spellCheck={false} required maxLength={6} value={masterKeyTail} onChange={(e) => setMasterKeyTail(e.target.value)} className={monoInput} />
            </Field>
          )}
          {keys.backupRepoPassword && (
            <Field id="owner-backup-tail" label="Last 6 characters of the backup password">
              <input id="owner-backup-tail" autoComplete="off" spellCheck={false} required maxLength={6} value={backupTail} onChange={(e) => setBackupTail(e.target.value)} className={monoInput} />
            </Field>
          )}
          <ErrorNote id="owner-keys-error" message={error} />
          <Submit busy={busy} label={nothingToShow ? "Continue" : "I've saved them"} />
        </form>
      )}
      {!keys && <ErrorNote id="owner-keys-reveal-error" message={error} />}
    </div>
  );
}

// ── 7. Finish ────────────────────────────────────────────────────────────────

export function FinishStep({ summary, onSessionLost }: StepProps) {
  const { error, busy, run } = useAction(onSessionLost);
  const [finished, setFinished] = useState(false);

  const finish = async () => {
    const result = await run(() => ownerApi.post<{ next: string }>("finish"));
    if (result) {
      setFinished(true);
      window.location.assign(result.next || "/admin");
    }
  };

  if (finished) return <p role="status" className="ui-alert ui-alert-success">Setup is finished. Opening the sign-in page…</p>;

  return (
    <div className="flex max-w-md flex-col gap-4">
      <StepHeader title="Finish setup">
        <p>
          This creates the owner account for <strong>{summary.email}</strong>
          {summary.organisation ? <> and names the organisation <strong>{summary.organisation.organisationName}</strong></> : null}. After that this
          setup page closes for good and you sign in like everyone else.
        </p>
      </StepHeader>
      <ErrorNote id="owner-finish-error" message={error} />
      <button type="button" onClick={() => void finish()} disabled={busy} className="ui-btn ui-btn-primary self-start">{busy ? "Finishing…" : "Finish setup"}</button>
    </div>
  );
}
