"use client";

import { useEffect, useRef, useState } from "react";
import { Lock, ShieldCheck, X } from "lucide-react";
import BuiltinSignInForm from "@/components/admin/auth/BuiltinSignInForm";
import { setStepUpHandler } from "@/lib/auth/adminFetch";
import { usesBuiltinAuth } from "@/lib/auth/browser";
import { getSupabaseBrowserIdentityProvider } from "@/lib/auth/supabaseProvider";

/** Supabase (GoTrue): signing in again with the password gives a token with a fresh sign-in time. */
function SupabaseConfirmForm({ email, onConfirmed }: { email: string; onConfirmed: () => void }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError("");
    setBusy(true);
    try {
      const { session, error: signInError } = await getSupabaseBrowserIdentityProvider().signInWithPassword({ email, password });
      if (signInError || !session) return setError("That password is not right.");
      setPassword("");
      onConfirmed();
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={submit} aria-busy={busy} className="flex flex-col gap-4">
      <label htmlFor="step-up-password" className="font-body text-[10px] font-semibold uppercase tracking-[0.1em] text-fg-muted">Password</label>
      <div className="relative">
        <input id="step-up-password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)}
          required autoFocus aria-invalid={error ? true : undefined} aria-describedby={error ? "step-up-error" : undefined}
          className="w-full h-12 rounded-xl border border-subtle bg-surface-1 pl-4 pr-11 text-sm text-on-surface outline-none focus:border-primary focus-visible:ring-2 focus-visible:ring-primary/60" />
        <Lock size={15} aria-hidden="true" className="pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 text-fg-muted" />
      </div>
      {error && <p id="step-up-error" role="alert" className="rounded-xl border border-danger bg-danger-muted px-3 py-2.5 text-xs text-danger">{error}</p>}
      <button type="submit" disabled={busy} className="ui-btn ui-btn-primary">{busy ? "Checking..." : "Confirm"}</button>
    </form>
  );
}

/**
 * "Confirm it's you": shown when the server refuses a sensitive action with STEP_UP_REQUIRED (API
 * token creation, role changes, sign-in settings, exports). Signing in again creates a fresh session
 * and ends the old one; the admin fetch wrapper then retries the action once.
 */
export default function StepUpDialog({ email }: { email: string | null }) {
  const [open, setOpen] = useState(false);
  const resolver = useRef<((confirmed: boolean) => void) | null>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    if (!email) return;
    setStepUpHandler(() => new Promise<boolean>((resolve) => {
      resolver.current?.(false);
      resolver.current = resolve;
      setOpen(true);
    }));
    return () => setStepUpHandler(null);
  }, [email]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  const close = (confirmed: boolean) => {
    setOpen(false);
    resolver.current?.(confirmed);
    resolver.current = null;
  };

  if (!email) return null;
  return (
    <dialog
      ref={dialogRef}
      aria-labelledby="step-up-title"
      onCancel={(event) => { event.preventDefault(); close(false); }}
      className="w-[min(420px,calc(100vw-32px))] rounded-2xl border border-outline-variant bg-surface p-8 text-on-surface shadow-2xl backdrop:bg-black/60"
    >
      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <p className="mb-2 flex items-center gap-2 font-body text-[10px] font-semibold uppercase tracking-[0.12em] text-primary">
            <ShieldCheck size={14} aria-hidden="true" /> Security check
          </p>
          <h2 id="step-up-title" className="font-headline text-2xl font-extrabold tracking-tight">Confirm it&apos;s you</h2>
          <p className="mt-2 text-sm text-on-surface-variant">This action needs a sign-in from the last 10 minutes. Sign in again as {email} to continue.</p>
        </div>
        <button type="button" onClick={() => close(false)} aria-label="Cancel" className="rounded-full border-none bg-transparent p-1 text-fg-muted hover:text-on-surface cursor-pointer">
          <X size={18} />
        </button>
      </div>
      {open && (usesBuiltinAuth()
        ? <BuiltinSignInForm fixedEmail={email} submitLabel="Confirm" onSignedIn={() => close(true)} />
        : <SupabaseConfirmForm email={email} onConfirmed={() => close(true)} />)}
    </dialog>
  );
}
