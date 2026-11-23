"use client";

import { useState } from "react";
import { ArrowRight, Fingerprint, KeyRound, Lock, User } from "lucide-react";
import { announceSessionChange, builtinAuthClient } from "@/lib/auth/builtinClient";
import { resetCsrfToken } from "@/lib/auth/adminFetch";

const inputClass =
  "w-full h-12 rounded-xl border border-subtle bg-surface-1 pl-4 pr-11 text-sm text-on-surface outline-none transition-all placeholder:text-fg-muted focus:border-primary focus-visible:ring-2 focus-visible:ring-primary/60";
const labelClass = "font-body text-[10px] font-semibold uppercase tracking-[0.1em] text-fg-muted";
const primaryButton =
  "group flex w-full h-12 items-center justify-center gap-2 rounded-full border-none bg-primary/90 font-body text-[12px] font-bold uppercase tracking-[0.12em] text-background transition-all duration-300 hover:bg-primary active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50";
const secondaryButton =
  "flex w-full h-11 items-center justify-center gap-2 rounded-full border border-outline bg-transparent font-body text-[11px] font-bold uppercase tracking-[0.1em] text-on-surface-variant transition-colors hover:border-primary hover:text-on-surface disabled:cursor-not-allowed disabled:opacity-50";

type Step = "password" | "code";

/** Readable text for the library's error codes; never says whether an account exists. */
function messageFor(error: { code?: string; message?: string; status?: number } | null | undefined, fallback: string): string {
  switch (error?.code) {
    case "INVALID_EMAIL_OR_PASSWORD":
      return "That email and password do not match.";
    case "PASSKEY_REQUIRED":
      return "This account uses a passkey. Sign in with your passkey.";
    case "INVALID_CODE":
    case "INVALID_BACKUP_CODE":
      return "That code is not right. Try again.";
    case "TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE":
    case "INVALID_TWO_FACTOR_COOKIE":
      return "Too many tries for this sign-in. Start again with your password.";
    case "ACCOUNT_TEMPORARILY_LOCKED":
      return "Two-step sign-in is paused for 15 minutes after too many wrong codes.";
    default:
      if (error?.status === 429) return "Too many attempts. Wait a minute and try again.";
      return fallback;
  }
}

/**
 * Built-in sign-in: email and password, then the authenticator-app code (or a recovery code), or a
 * passkey. Used by the sign-in screen and, with a fixed email, by the "confirm it's you" dialog.
 */
export default function BuiltinSignInForm({ fixedEmail, submitLabel = "Sign In", onSignedIn }: { fixedEmail?: string; submitLabel?: string; onSignedIn?: () => void }) {
  const auth = builtinAuthClient();
  const [step, setStep] = useState<Step>("password");
  const [email, setEmail] = useState(fixedEmail ?? "");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [useRecoveryCode, setUseRecoveryCode] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const finish = () => {
    resetCsrfToken();
    setPassword("");
    setCode("");
    announceSessionChange();
    onSignedIn?.();
  };

  const submitPassword = async (event: React.FormEvent) => {
    event.preventDefault();
    setError("");
    setBusy(true);
    try {
      const { data, error: signInError } = await auth.signIn.email({ email: email.trim().toLowerCase(), password });
      if (signInError) return setError(messageFor(signInError, "Sign-in failed. Try again."));
      if (data && "twoFactorRedirect" in data && data.twoFactorRedirect) {
        setStep("code");
        return;
      }
      finish();
    } finally {
      setBusy(false);
    }
  };

  const submitCode = async (event: React.FormEvent) => {
    event.preventDefault();
    setError("");
    setBusy(true);
    try {
      const value = code.trim();
      const result = useRecoveryCode
        ? await auth.twoFactor.verifyBackupCode({ code: value })
        : await auth.twoFactor.verifyTotp({ code: value.replace(/\s+/g, "") });
      if (result.error) {
        const message = messageFor(result.error, "That code is not right. Try again.");
        if (result.error.code === "TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE" || result.error.code === "INVALID_TWO_FACTOR_COOKIE") setStep("password");
        return setError(message);
      }
      finish();
    } finally {
      setBusy(false);
    }
  };

  const signInWithPasskey = async () => {
    setError("");
    setBusy(true);
    try {
      const result = await auth.signIn.passkey();
      if (result?.error) return setError(messageFor(result.error, "The passkey did not sign you in. Try again, or use your password."));
      finish();
    } finally {
      setBusy(false);
    }
  };

  if (step === "code") {
    return (
      <form onSubmit={submitCode} aria-busy={busy} className="flex flex-col gap-5">
        <div className="flex flex-col gap-1.5">
          <label htmlFor="signin-code" className={labelClass}>{useRecoveryCode ? "Recovery code" : "Code from your authenticator app"}</label>
          <div className="relative group">
            <input
              id="signin-code"
              name="code"
              inputMode={useRecoveryCode ? "text" : "numeric"}
              autoComplete="one-time-code"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              required
              autoFocus
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? "signin-error" : undefined}
              className={inputClass}
            />
            <KeyRound size={15} aria-hidden="true" className="pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 text-fg-muted" />
          </div>
        </div>
        {error && <p id="signin-error" role="alert" className="rounded-xl border border-danger bg-danger-muted px-3 py-2.5 text-xs text-danger">{error}</p>}
        <button type="submit" disabled={busy} className={primaryButton}>
          {busy ? "Checking..." : "Verify"}
        </button>
        <button type="button" className="bg-transparent border-none text-[11px] text-fg-muted underline cursor-pointer" onClick={() => { setUseRecoveryCode((v) => !v); setCode(""); setError(""); }}>
          {useRecoveryCode ? "Use the authenticator app instead" : "Lost your device? Use a recovery code"}
        </button>
      </form>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      <button type="button" onClick={() => void signInWithPasskey()} disabled={busy} className={secondaryButton}>
        <Fingerprint size={15} aria-hidden="true" /> Sign in with a passkey
      </button>
      <div className="flex items-center gap-3 text-[10px] uppercase tracking-[0.12em] text-fg-muted" aria-hidden="true">
        <span className="h-px flex-1 bg-surface-2" />or<span className="h-px flex-1 bg-surface-2" />
      </div>
      <form onSubmit={submitPassword} aria-busy={busy} className="flex flex-col gap-5">
        {!fixedEmail && (
          <div className="flex flex-col gap-1.5">
            <label htmlFor="signin-email" className={labelClass}>Email</label>
            <div className="relative group">
              <input id="signin-email" name="email" type="email" autoComplete="username webauthn" placeholder="you@example.com" value={email}
                onChange={(e) => setEmail(e.target.value)} required autoFocus aria-invalid={error ? true : undefined}
                aria-describedby={error ? "signin-error" : undefined} className={inputClass} />
              <User size={15} aria-hidden="true" className="pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 text-fg-muted" />
            </div>
          </div>
        )}
        <div className="flex flex-col gap-1.5">
          <label htmlFor="signin-password" className={labelClass}>Password</label>
          <div className="relative group">
            <input id="signin-password" name="password" type="password" autoComplete="current-password" value={password}
              onChange={(e) => setPassword(e.target.value)} required autoFocus={Boolean(fixedEmail)} aria-invalid={error ? true : undefined}
              aria-describedby={error ? "signin-error" : undefined} className={inputClass} />
            <Lock size={15} aria-hidden="true" className="pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 text-fg-muted" />
          </div>
        </div>
        {error && <p id="signin-error" role="alert" className="rounded-xl border border-danger bg-danger-muted px-3 py-2.5 text-xs text-danger">{error}</p>}
        <button type="submit" disabled={busy} className={primaryButton}>
          {busy ? "Checking..." : (<>{submitLabel}<ArrowRight size={15} className="transition-transform duration-300 group-hover:translate-x-1" /></>)}
        </button>
      </form>
    </div>
  );
}
