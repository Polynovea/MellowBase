"use client";

import { useEffect, useRef, useState } from "react";
import { ShieldCheck, X } from "lucide-react";
import BuiltinSignInForm from "@/components/admin/auth/BuiltinSignInForm";
import { setStepUpHandler } from "@/lib/auth/adminFetch";

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
      {open && <BuiltinSignInForm fixedEmail={email} submitLabel="Confirm" onSignedIn={() => close(true)} />}
    </dialog>
  );
}
