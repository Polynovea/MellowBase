"use client";

import { FormEvent, Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Fingerprint, KeyRound, LaptopMinimal, LogOut, ShieldAlert, ShieldCheck, Smartphone, Trash2 } from "lucide-react";
import { encode } from "uqr";
import AdminLayout from "@/components/admin/AdminLayout";
import { useAdminAccess } from "@/lib/admin/useAdminAccess";
import { announceSessionChange, builtinAuthClient } from "@/lib/auth/builtinClient";
import { requestStepUp, resetCsrfToken } from "@/lib/auth/adminFetch";
import { usesBuiltinAuth } from "@/lib/auth/browser";

type Message = { type: "success" | "error"; text: string } | null;
type ApiError = { code?: string; message?: string; status?: number } | null | undefined;
type Passkey = { id: string; name?: string | null; createdAt?: string | Date | null; deviceType?: string };
type SessionRow = { id: string; token: string; createdAt: string | Date; updatedAt?: string | Date; ipAddress?: string | null; userAgent?: string | null };

const inputClass = "w-full rounded-xl border border-subtle bg-surface-1 px-4 py-3 text-sm text-fg-primary outline-none transition focus:border-primary/50";
const labelClass = "mb-2 block text-[10px] font-bold uppercase tracking-wider text-fg-muted";

/**
 * Runs a Better Auth client call; when the library says the session is too old for this change
 * (sign-in more than 10 minutes ago), asks the user to confirm it's them and tries once more.
 */
async function withFreshSession<T extends { error?: ApiError }>(call: () => Promise<T>): Promise<T> {
  const first = await call();
  if (first.error?.code !== "SESSION_NOT_FRESH") return first;
  if (!(await requestStepUp())) return first;
  return call();
}

function errorText(error: ApiError, fallback: string): string {
  if (error?.code === "SESSION_NOT_FRESH") return "Confirm it's you to make this change.";
  if (error?.code === "INVALID_PASSWORD" || error?.code === "INVALID_EMAIL_OR_PASSWORD") return "That password is not right.";
  return error?.message || fallback;
}

function QrCode({ value }: { value: string }) {
  const { data, size } = useMemo(() => encode(value, { ecc: "M", border: 2 }), [value]);
  return (
    <svg viewBox={`0 0 ${size} ${size}`} role="img" aria-label="QR code for your authenticator app" className="h-48 w-48 rounded-lg bg-white p-1" shapeRendering="crispEdges">
      {data.flatMap((row, y) => row.map((dark, x) => (dark ? <rect key={`${x}-${y}`} x={x} y={y} width={1} height={1} fill="#000" /> : null)))}
    </svg>
  );
}

function RecoveryCodes({ codes, onDone }: { codes: string[]; onDone: () => void }) {
  const text = codes.join("\n");
  const download = () => {
    const url = URL.createObjectURL(new Blob([`Polynovea CMS recovery codes\nEach code works once.\n\n${text}\n`], { type: "text/plain" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = "polynovea-recovery-codes.txt";
    link.click();
    URL.revokeObjectURL(url);
  };
  return (
    <div className="rounded-xl border border-primary/40 bg-surface-1 p-4">
      <p className="text-sm font-semibold text-fg-primary">Save your recovery codes now</p>
      <p className="mt-1 text-[11px] text-fg-muted">Each code signs you in once if you lose your devices. They are shown only this time.</p>
      <ul className="mt-3 grid grid-cols-2 gap-2 font-mono text-[13px] text-fg-primary">
        {codes.map((code) => <li key={code}>{code}</li>)}
      </ul>
      <div className="mt-4 flex flex-wrap gap-2">
        <button type="button" className="ui-btn ui-btn-secondary" onClick={() => void navigator.clipboard?.writeText(text)}>Copy</button>
        <button type="button" className="ui-btn ui-btn-secondary" onClick={download}>Download</button>
        <button type="button" className="ui-btn ui-btn-primary" onClick={onDone}>I have saved them</button>
      </div>
    </div>
  );
}

function Section({ icon, title, description, children }: { icon: React.ReactNode; title: string; description: string; children: React.ReactNode }) {
  return (
    <section className="border-t border-subtle pt-5">
      <div className="mb-5 flex items-center gap-3">
        <span className="text-primary">{icon}</span>
        <div>
          <h2 className="text-sm font-semibold text-fg-primary">{title}</h2>
          <p className="text-[11px] text-fg-muted">{description}</p>
        </div>
      </div>
      {children}
    </section>
  );
}

function Note({ message }: { message: Message }) {
  if (!message) return null;
  return <p role={message.type === "error" ? "alert" : "status"} className={`text-[11px] ${message.type === "success" ? "text-success" : "text-danger"}`}>{message.text}</p>;
}

function describeDevice(userAgent?: string | null): string {
  if (!userAgent) return "Unknown device";
  const browser = /Edg\//.test(userAgent) ? "Edge" : /Chrome\//.test(userAgent) ? "Chrome" : /Firefox\//.test(userAgent) ? "Firefox" : /Safari\//.test(userAgent) ? "Safari" : "Browser";
  const os = /Windows/.test(userAgent) ? "Windows" : /Mac OS X/.test(userAgent) ? "macOS" : /Android/.test(userAgent) ? "Android" : /iPhone|iPad/.test(userAgent) ? "iOS" : /Linux/.test(userAgent) ? "Linux" : "";
  return os ? `${browser} on ${os}` : browser;
}

const when = (value?: string | Date | null) => (value ? new Date(value).toLocaleString() : "—");

function SecurityPage() {
  const auth = builtinAuthClient();
  const params = useSearchParams();
  const { profile } = useAdminAccess();
  const [twoFactorEnabled, setTwoFactorEnabled] = useState(false);
  const [passkeys, setPasskeys] = useState<Passkey[]>([]);
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const [totpPassword, setTotpPassword] = useState("");
  const [totpUri, setTotpUri] = useState<string | null>(null);
  const [totpCode, setTotpCode] = useState("");
  const [newCodes, setNewCodes] = useState<string[] | null>(null);
  const [pendingCodes, setPendingCodes] = useState<string[] | null>(null);
  const [totpMessage, setTotpMessage] = useState<Message>(null);
  const [passkeyName, setPasskeyName] = useState("");
  const [passkeyMessage, setPasskeyMessage] = useState<Message>(null);
  const [codesPassword, setCodesPassword] = useState("");
  const [codesMessage, setCodesMessage] = useState<Message>(null);
  const [sessionMessage, setSessionMessage] = useState<Message>(null);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [passwordMessage, setPasswordMessage] = useState<Message>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const [session, keys, list] = await Promise.all([
      auth.getSession({ query: { disableCookieCache: true } }),
      auth.passkey.listUserPasskeys(),
      auth.listSessions(),
    ]);
    const user = session.data?.user as { twoFactorEnabled?: boolean | null } | undefined;
    setTwoFactorEnabled(Boolean(user?.twoFactorEnabled));
    setCurrentSessionId(session.data?.session.id ?? null);
    setPasskeys((keys.data as Passkey[] | null) ?? []);
    setSessions(((list.data as SessionRow[] | null) ?? []).sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()));
    setLoading(false);
  }, [auth]);

  useEffect(() => {
    void load();
  }, [load]);

  const authenticators = (twoFactorEnabled ? 1 : 0) + passkeys.length;
  const required = profile?.role === "master" ? 2 : profile?.role === "admin" ? 1 : 0;
  const missing = Math.max(0, required - authenticators);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } finally {
      setBusy(false);
    }
  };

  const startTotp = (event: FormEvent) => {
    event.preventDefault();
    void run(async () => {
      setTotpMessage(null);
      const result = await withFreshSession(() => auth.twoFactor.enable({ password: totpPassword }));
      if (result.error || !result.data || result.data.method !== "totp") return setTotpMessage({ type: "error", text: errorText(result.error, "Could not start set-up.") });
      setTotpPassword("");
      setTotpUri(result.data.totpURI);
      setPendingCodes(result.data.backupCodes);
    });
  };

  const confirmTotp = (event: FormEvent) => {
    event.preventDefault();
    void run(async () => {
      const result = await auth.twoFactor.verifyTotp({ code: totpCode.replace(/\s+/g, "") });
      if (result.error) return setTotpMessage({ type: "error", text: errorText(result.error, "That code is not right. Check the time on your device and try again.") });
      setTotpUri(null);
      setTotpCode("");
      setNewCodes(pendingCodes);
      setPendingCodes(null);
      setTotpMessage({ type: "success", text: "Authenticator app added." });
      await load();
    });
  };

  const disableTotp = (event: FormEvent) => {
    event.preventDefault();
    void run(async () => {
      const result = await withFreshSession(() => auth.twoFactor.disable({ password: totpPassword }));
      if (result.error) return setTotpMessage({ type: "error", text: errorText(result.error, "Could not turn it off.") });
      setTotpPassword("");
      setTotpMessage({ type: "success", text: "Authenticator app removed." });
      await load();
    });
  };

  const addPasskey = (event: FormEvent) => {
    event.preventDefault();
    void run(async () => {
      setPasskeyMessage(null);
      const result = await withFreshSession(async () => (await auth.passkey.addPasskey({ name: passkeyName.trim() || undefined })) ?? {});
      if (result?.error) return setPasskeyMessage({ type: "error", text: errorText(result.error, "The passkey was not added.") });
      setPasskeyName("");
      setPasskeyMessage({ type: "success", text: "Passkey added." });
      await load();
    });
  };

  const removePasskey = (id: string) => {
    void run(async () => {
      const result = await withFreshSession(() => auth.passkey.deletePasskey({ id }));
      if (result.error) return setPasskeyMessage({ type: "error", text: errorText(result.error, "Could not remove the passkey.") });
      await load();
    });
  };

  const regenerateCodes = (event: FormEvent) => {
    event.preventDefault();
    void run(async () => {
      setCodesMessage(null);
      const result = await withFreshSession(() => auth.twoFactor.generateBackupCodes({ password: codesPassword }));
      if (result.error || !result.data) return setCodesMessage({ type: "error", text: errorText(result.error, "Could not make new codes.") });
      setCodesPassword("");
      setNewCodes(result.data.backupCodes);
      setCodesMessage({ type: "success", text: "New codes made. The old ones no longer work." });
    });
  };

  const revoke = (token: string) => {
    void run(async () => {
      const result = await auth.revokeSession({ token });
      if (result.error) return setSessionMessage({ type: "error", text: errorText(result.error, "Could not sign that session out.") });
      await load();
    });
  };

  const signOutOthers = () => {
    void run(async () => {
      const result = await auth.revokeOtherSessions();
      if (result.error) return setSessionMessage({ type: "error", text: errorText(result.error, "Could not sign the other sessions out.") });
      setSessionMessage({ type: "success", text: "Signed out everywhere else." });
      await load();
    });
  };

  const signOutEverywhere = () => {
    void run(async () => {
      await auth.revokeSessions();
      resetCsrfToken();
      announceSessionChange();
    });
  };

  const changePassword = (event: FormEvent) => {
    event.preventDefault();
    void run(async () => {
      setPasswordMessage(null);
      const result = await withFreshSession(() => auth.changePassword({ currentPassword, newPassword, revokeOtherSessions: true }));
      if (result.error) return setPasswordMessage({ type: "error", text: errorText(result.error, "Could not change the password.") });
      setCurrentPassword("");
      setNewPassword("");
      resetCsrfToken();
      setPasswordMessage({ type: "success", text: "Password changed. Other sessions were signed out." });
      await load();
    });
  };

  return (
    <div className="ui-page mx-auto max-w-4xl">
      <header className="ui-page-header">
        <div>
          <div className="mb-2 flex items-center gap-2 text-[10px] font-bold uppercase tracking-widest text-fg-muted">
            <span>Account</span><span className="opacity-40">/</span><span className="text-primary">Sign-in &amp; security</span>
          </div>
          <h1 className="font-headline text-[32px] font-extrabold leading-none tracking-[-0.02em] text-on-surface">SIGN-IN &amp; SECURITY</h1>
          <p className="mt-1 font-body text-[13px] text-fg-muted">Two-step sign-in, passkeys, recovery codes and where you are signed in.</p>
        </div>
      </header>

      {(missing > 0 || params.get("setup") === "mfa") && !loading && (
        <div role="status" className="mb-6 flex items-start gap-3 rounded-xl border border-warning bg-surface-1 p-4 text-[12px] text-fg-primary">
          <ShieldAlert size={16} className="mt-0.5 shrink-0 text-warning" aria-hidden="true" />
          <p>
            {missing > 0
              ? `Your role needs ${required} sign-in method${required > 1 ? "s" : ""} besides your password (a passkey or an authenticator app). Add ${missing} more to use the CMS.`
              : "Two-step sign-in is set up."}
            {" "}A passkey is the safest choice: it cannot be phished.
          </p>
        </div>
      )}

      {newCodes && <div className="mb-6"><RecoveryCodes codes={newCodes} onDone={() => setNewCodes(null)} /></div>}

      <div className="flex flex-col gap-7">
        <Section icon={<Fingerprint size={16} />} title="Passkeys" description="Sign in with your fingerprint, face or device PIN. Works only on this CMS's address, so it cannot be phished.">
          <ul className="mb-4 divide-y divide-subtle rounded-xl border border-subtle">
            {passkeys.length === 0 && <li className="p-4 text-[12px] text-fg-muted">{loading ? "Loading..." : "No passkeys yet."}</li>}
            {passkeys.map((key) => (
              <li key={key.id} className="flex items-center justify-between gap-3 p-4">
                <div>
                  <p className="text-sm text-fg-primary">{key.name || "Passkey"}</p>
                  <p className="text-[11px] text-fg-muted">Added {when(key.createdAt)}{key.deviceType === "multiDevice" ? " · synced" : ""}</p>
                </div>
                <button type="button" disabled={busy} className="ui-btn ui-btn-tertiary" onClick={() => removePasskey(key.id)} aria-label={`Remove ${key.name || "passkey"}`}>
                  <Trash2 size={13} /> Remove
                </button>
              </li>
            ))}
          </ul>
          <form onSubmit={addPasskey} className="flex max-w-xl flex-wrap items-end gap-3">
            <label className="min-w-[200px] flex-1">
              <span className={labelClass}>Name (optional)</span>
              <input value={passkeyName} onChange={(e) => setPasskeyName(e.target.value)} maxLength={60} placeholder="Work laptop" className={inputClass} />
            </label>
            <button type="submit" disabled={busy} className="ui-btn ui-btn-primary"><Fingerprint size={13} /> Add a passkey</button>
          </form>
          <div className="mt-2"><Note message={passkeyMessage} /></div>
        </Section>

        <Section icon={<Smartphone size={16} />} title="Authenticator app" description="A 6-digit code from an app such as Google Authenticator, 1Password or Authy, asked for after your password.">
          {totpUri ? (
            <div className="flex flex-col gap-4 sm:flex-row">
              <QrCode value={totpUri} />
              <form onSubmit={confirmTotp} className="flex max-w-sm flex-1 flex-col gap-3">
                <p className="text-[12px] text-fg-muted">Scan the code with your app, or enter this key by hand:</p>
                <code className="break-all rounded-lg bg-surface-2 p-2 text-[12px] text-fg-primary">{new URL(totpUri).searchParams.get("secret")}</code>
                <label>
                  <span className={labelClass}>Code from the app</span>
                  <input value={totpCode} onChange={(e) => setTotpCode(e.target.value)} inputMode="numeric" autoComplete="one-time-code" required className={inputClass} />
                </label>
                <button type="submit" disabled={busy} className="ui-btn ui-btn-primary">Turn on</button>
              </form>
            </div>
          ) : (
            <form onSubmit={twoFactorEnabled ? disableTotp : startTotp} className="flex max-w-xl flex-wrap items-end gap-3">
              <p className="w-full text-[12px] text-fg-primary">{loading ? "Loading..." : twoFactorEnabled ? "On." : "Off."}</p>
              <label className="min-w-[200px] flex-1">
                <span className={labelClass}>Your password</span>
                <input type="password" value={totpPassword} onChange={(e) => setTotpPassword(e.target.value)} autoComplete="current-password" required className={inputClass} />
              </label>
              <button type="submit" disabled={busy || loading} className={twoFactorEnabled ? "ui-btn ui-btn-danger" : "ui-btn ui-btn-primary"}>
                {twoFactorEnabled ? "Turn off" : "Set up"}
              </button>
            </form>
          )}
          <div className="mt-2"><Note message={totpMessage} /></div>
        </Section>

        {twoFactorEnabled && (
          <Section icon={<KeyRound size={16} />} title="Recovery codes" description="Ten single-use codes for when you cannot use your app or passkeys. Making new ones cancels the old ones.">
            <form onSubmit={regenerateCodes} className="flex max-w-xl flex-wrap items-end gap-3">
              <label className="min-w-[200px] flex-1">
                <span className={labelClass}>Your password</span>
                <input type="password" value={codesPassword} onChange={(e) => setCodesPassword(e.target.value)} autoComplete="current-password" required className={inputClass} />
              </label>
              <button type="submit" disabled={busy} className="ui-btn ui-btn-secondary">Make new codes</button>
            </form>
            <div className="mt-2"><Note message={codesMessage} /></div>
          </Section>
        )}

        <Section icon={<LaptopMinimal size={16} />} title="Where you're signed in" description="Sessions end after 12 hours without use, and always after 7 days.">
          <ul className="mb-4 divide-y divide-subtle rounded-xl border border-subtle">
            {sessions.map((row) => (
              <li key={row.id} className="flex flex-wrap items-center justify-between gap-3 p-4">
                <div>
                  <p className="text-sm text-fg-primary">
                    {describeDevice(row.userAgent)}
                    {row.id === currentSessionId && <span className="ml-2 rounded-full bg-surface-2 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-primary">This device</span>}
                  </p>
                  <p className="text-[11px] text-fg-muted">Signed in {when(row.createdAt)}{row.ipAddress ? ` · ${row.ipAddress}` : ""}</p>
                </div>
                {row.id !== currentSessionId && (
                  <button type="button" disabled={busy} className="ui-btn ui-btn-tertiary" onClick={() => revoke(row.token)}>Sign out</button>
                )}
              </li>
            ))}
          </ul>
          <div className="flex flex-wrap gap-3">
            <button type="button" disabled={busy || sessions.length < 2} className="ui-btn ui-btn-secondary" onClick={signOutOthers}>Sign out everywhere else</button>
            <button type="button" disabled={busy} className="ui-btn ui-btn-danger" onClick={signOutEverywhere}><LogOut size={13} /> Sign out everywhere</button>
          </div>
          <div className="mt-2"><Note message={sessionMessage} /></div>
        </Section>

        <Section icon={<ShieldCheck size={16} />} title="Password" description="At least 15 characters, or 8 once you have a passkey or authenticator app. Long phrases are best; known-leaked passwords are refused.">
          <form onSubmit={changePassword} className="max-w-xl space-y-4">
            <label className="block">
              <span className={labelClass}>Current password</span>
              <input type="password" value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} autoComplete="current-password" required className={inputClass} />
            </label>
            <label className="block">
              <span className={labelClass}>New password</span>
              <input type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} autoComplete="new-password" required maxLength={128} className={inputClass} />
            </label>
            <button type="submit" disabled={busy} className="ui-btn ui-btn-primary">Change password</button>
            <Note message={passwordMessage} />
          </form>
        </Section>
      </div>
    </div>
  );
}

export default function SecurityRoute() {
  if (!usesBuiltinAuth()) {
    return (
      <AdminLayout>
        <div className="ui-page mx-auto max-w-4xl">
          <p className="text-sm text-fg-muted">Sign-in security is managed by Supabase Auth on this install. Switch to the built-in auth to manage passkeys, two-step sign-in and sessions here.</p>
        </div>
      </AdminLayout>
    );
  }
  return (
    <AdminLayout>
      <Suspense fallback={null}>
        <SecurityPage />
      </Suspense>
    </AdminLayout>
  );
}
