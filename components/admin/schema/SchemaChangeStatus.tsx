"use client";

import { useState } from "react";
import { AlertTriangle, Clock3 } from "lucide-react";

export interface SchemaChangeView {
  ledgerId: string;
  stage: "expand" | "destructive";
  status: string;
  createdAt: string;
  plan: string[];
  /** valuesDeleted is null when it was not counted. */
  confirmation?: { prompt: string; valuesDeleted: number | null };
  errorRef?: string | null;
}

function deletesLine(values: number | null): string {
  if (values === null) return "This deletes the saved values of the fields listed.";
  return `This deletes ${values.toLocaleString("en-US")} saved value${values === 1 ? "" : "s"}.`;
}

/**
 * The model page's line about its schema changes: being applied, failed, or a deletion waiting for
 * the admin to type the model's API key. Confirming calls the confirm route (permission, step-up,
 * audit and the key check happen on the server).
 */
export default function SchemaChangeStatus({ modelId, apiKey, changes, onChanged, onConfirmed }: { modelId: string; apiKey: string; changes: SchemaChangeView[]; onChanged: () => void; onConfirmed?: () => void }) {
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  if (!changes.length) return null;

  const applying = changes.filter((change) => change.status === "pending" || change.status === "running");
  const failed = changes.filter((change) => change.status === "failed");
  const waiting = changes.filter((change) => change.status === "awaiting_confirmation" && change.confirmation);

  async function confirm(change: SchemaChangeView) {
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`/api/models/${modelId}/schema-changes/${change.ledgerId}/confirm`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ typedApiKey: typed }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || "The deletion could not be confirmed.");
      setOpen(null);
      setTyped("");
      onConfirmed?.();
      onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The deletion could not be confirmed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-label="Database changes" className="space-y-2">
      {applying.length > 0 && (
        <div className="flex items-start gap-2 rounded-xl border border-subtle bg-surface-2 px-4 py-3 text-sm">
          <Clock3 size={16} className="mt-0.5 shrink-0 text-action" aria-hidden />
          <div>
            <p className="font-semibold">Applying your changes to the database</p>
            {applying.some((change) => change.plan.length > 0)
              ? <ul className="mt-1 list-disc pl-5 text-fg-muted">{applying.flatMap((change) => change.plan).map((line, i) => <li key={i}>{line}</li>)}</ul>
              : <p className="mt-1 text-fg-muted">No columns change; the table is moving to the new version.</p>}
            <p className="mt-1 text-xs text-fg-muted">Until this finishes, entries of this model are read from their saved versions.</p>
          </div>
        </div>
      )}
      {failed.map((change) => (
        <div key={change.ledgerId} className="flex items-start gap-2 rounded-xl border border-danger bg-danger-muted px-4 py-3 text-sm text-danger">
          <AlertTriangle size={16} className="mt-0.5 shrink-0" aria-hidden />
          <p>The last change could not be applied to the database{change.errorRef ? ` (reference ${change.errorRef})` : ""}. Your saved model is safe; ask an administrator to check the schema worker.</p>
        </div>
      ))}
      {waiting.map((change) => (
        <div key={change.ledgerId} className="rounded-xl border border-warning bg-warning-muted px-4 py-3 text-sm">
          <p className="font-semibold">A deletion is waiting for your confirmation</p>
          <ul className="mt-1 list-disc pl-5">{change.plan.map((line, i) => <li key={i}>{line}</li>)}</ul>
          <p className="mt-1">{deletesLine(change.confirmation!.valuesDeleted)} Nothing is deleted until you confirm.</p>
          {open === change.ledgerId ? (
            <div role="dialog" aria-label="Confirm deletion" className="mt-3 space-y-2">
              <label className="block text-sm">
                {change.confirmation!.prompt}
                <input
                  className="mt-1 block w-full max-w-xs rounded-lg border border-subtle bg-surface-1 px-3 py-2"
                  value={typed}
                  onChange={(event) => setTyped(event.target.value)}
                  autoComplete="off"
                  spellCheck={false}
                  aria-describedby={`confirm-${change.ledgerId}`}
                />
              </label>
              <p id={`confirm-${change.ledgerId}`} className="text-xs text-fg-muted">You may be asked to sign in again first.</p>
              {error && <p className="text-sm text-danger" role="alert">{error}</p>}
              <div className="flex gap-2">
                <button type="button" disabled={busy || typed.trim() !== apiKey} onClick={() => confirm(change)} className="rounded-lg bg-danger px-3 py-2 font-semibold text-white disabled:opacity-50">Delete for good</button>
                <button type="button" onClick={() => { setOpen(null); setTyped(""); setError(""); }} className="rounded-lg border border-subtle px-3 py-2">Cancel</button>
              </div>
            </div>
          ) : (
            <button type="button" onClick={() => setOpen(change.ledgerId)} className="mt-2 rounded-lg border border-danger px-3 py-2 font-semibold text-danger">Review and confirm</button>
          )}
        </div>
      ))}
    </section>
  );
}
