"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, KeyRound } from "lucide-react";

/**
 * The setup code box. The code is sent only in a POST body with fetch, never in the address: the
 * form has method="post" and its input has no name, so even without JavaScript the browser can
 * never turn it into a GET with the code in the URL.
 */

const inputClass =
  "w-full h-12 rounded-xl border border-subtle bg-surface-1 pl-4 pr-11 font-mono text-sm tracking-[0.08em] text-on-surface outline-none transition-all placeholder:text-fg-muted focus:border-primary focus-visible:ring-2 focus-visible:ring-primary/60";

interface CodeResponse {
  success?: boolean;
  error?: string | null;
  data?: { next?: string; tookOver?: boolean } | null;
}

export default function SetupCodeForm() {
  const router = useRouter();
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [accepted, setAccepted] = useState<string | null>(null);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError("");
    setBusy(true);
    try {
      const response = await fetch("/api/setup/code", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        cache: "no-store",
        body: JSON.stringify({ code }),
      });
      const body = (await response.json().catch(() => null)) as CodeResponse | null;
      if (!response.ok || !body?.success) {
        setError(body?.error || "Something went wrong. Check your connection and try again.");
        return;
      }
      setCode("");
      setAccepted(body.data?.tookOver ? "Code accepted. Setup continues in this browser; the other browser can no longer make changes." : "Code accepted.");
      router.push(body.data?.next || "/setup");
    } catch {
      setError("The server could not be reached. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  };

  if (accepted) {
    return (
      <p role="status" className="ui-alert ui-alert-success">
        {accepted} Opening the next step…
      </p>
    );
  }

  return (
    <form method="post" action="/api/setup/code" onSubmit={submit} aria-busy={busy} className="flex max-w-md flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <label htmlFor="setup-code" className="font-body text-[10px] font-semibold uppercase tracking-[0.1em] text-fg-muted">
          Setup code
        </label>
        <div className="relative">
          <input
            id="setup-code"
            type="text"
            inputMode="text"
            autoComplete="off"
            autoCapitalize="characters"
            autoCorrect="off"
            spellCheck={false}
            placeholder="XXXXXX-XXXXX-XXXXX-XXXXX-XXXXX"
            value={code}
            onChange={(event) => setCode(event.target.value)}
            required
            autoFocus
            maxLength={128}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? "setup-code-error setup-code-hint" : "setup-code-hint"}
            className={inputClass}
          />
          <KeyRound size={15} aria-hidden="true" className="pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 text-fg-muted" />
        </div>
        <p id="setup-code-hint" className="text-xs text-fg-muted">
          Capitals, spaces and dashes don't matter.
        </p>
      </div>
      {error && (
        <p id="setup-code-error" role="alert" className="ui-alert ui-alert-danger">
          {error}
        </p>
      )}
      <button type="submit" disabled={busy || code.trim() === ""} className="ui-btn ui-btn-primary inline-flex items-center justify-center gap-2 self-start">
        {busy ? "Checking…" : (
          <>
            Continue
            <ArrowRight size={15} aria-hidden="true" />
          </>
        )}
      </button>
    </form>
  );
}
