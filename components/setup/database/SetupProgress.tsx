"use client";

import { CheckCircle2, Circle, Loader2, XCircle } from "lucide-react";
import type { SetupStreamEvent, StepStatus } from "./eventStream";

/**
 * The live list for one run: one row per check, step and backup stage (latest status wins), and one
 * row for the migrations with a count, the file being applied and a bar.
 */

export interface ProgressState {
  steps: { key: string; label: string; status: StepStatus; message?: string }[];
  migrations: { done: number; total: number; current: string | null; failed: string | null } | null;
}

export const EMPTY_PROGRESS: ProgressState = { steps: [], migrations: null };

export function applyProgressEvent(state: ProgressState, event: SetupStreamEvent): ProgressState {
  if (event.type === "check" || event.type === "step" || event.type === "backup") {
    const key = `${event.type}:${event.id}`;
    const row = { key, label: event.label, status: event.status, message: event.message };
    const index = state.steps.findIndex((step) => step.key === key);
    const steps = index === -1 ? [...state.steps, row] : state.steps.map((step, i) => (i === index ? row : step));
    return { ...state, steps };
  }
  if (event.type === "migration") {
    const done = event.status === "applied" || event.status === "skipped" ? event.index : event.index - 1;
    return {
      ...state,
      migrations: {
        done: Math.max(state.migrations?.done ?? 0, done),
        total: event.total,
        current: event.status === "running" ? event.filename : null,
        failed: event.status === "failed" ? event.filename : (state.migrations?.failed ?? null),
      },
    };
  }
  return state;
}

function StatusIcon({ status }: { status: StepStatus }) {
  if (status === "passed") return <CheckCircle2 size={16} aria-hidden="true" className="mt-0.5 shrink-0 text-success" />;
  if (status === "failed") return <XCircle size={16} aria-hidden="true" className="mt-0.5 shrink-0 text-danger" />;
  return <Loader2 size={16} aria-hidden="true" className="mt-0.5 shrink-0 animate-spin text-fg-muted" />;
}

const STATUS_TEXT: Record<StepStatus, string> = { running: "in progress", passed: "done", failed: "failed" };

export default function SetupProgress({ progress }: { progress: ProgressState }) {
  if (progress.steps.length === 0 && !progress.migrations) return null;
  const migrations = progress.migrations;
  const migrationsIndex = progress.steps.findIndex((step) => step.key === "step:migrations");
  const rows = progress.steps.map((step) => (
    <li key={step.key} className="flex flex-col gap-1">
      <span className="flex gap-2 text-sm">
        <StatusIcon status={step.status} />
        <span>
          {step.label}
          <span className="sr-only"> ({STATUS_TEXT[step.status]})</span>
        </span>
      </span>
      {step.message && <span className="ml-6 text-sm text-fg-secondary">{step.message}</span>}
      {step.key === "step:migrations" && migrations && (
        <span className="ml-6 flex flex-col gap-1">
          <span className="text-xs text-fg-muted">
            {migrations.done} of {migrations.total} table updates{migrations.current ? `: ${migrations.current}` : ""}
            {migrations.failed ? ` (stopped at ${migrations.failed})` : ""}
          </span>
          <progress className="h-1.5 w-full max-w-xs" max={migrations.total} value={migrations.done} aria-label="Table updates" />
        </span>
      )}
    </li>
  ));
  return (
    <section aria-label="Progress" aria-live="polite" className="flex flex-col gap-3">
      <ol className="flex flex-col gap-2.5">{rows}</ol>
      {migrations && migrationsIndex === -1 && (
        <p className="flex items-center gap-2 text-sm">
          <Circle size={16} aria-hidden="true" className="text-fg-muted" />
          {migrations.done} of {migrations.total} table updates
        </p>
      )}
    </section>
  );
}
