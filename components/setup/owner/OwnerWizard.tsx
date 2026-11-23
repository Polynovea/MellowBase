"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Check } from "lucide-react";
import { ownerApi, OwnerApiError, type OwnerSummary } from "@/components/setup/owner/ownerApi";
import { AccountStep, AuthenticatorStep, FinishStep, KeysStep, OrganisationStep, PasskeyStep, RecoveryStep, type StepProps } from "@/components/setup/owner/OwnerSteps";

/**
 * The owner step of the setup wizard: walks the sub-steps in order, resuming from the server's
 * progress (the setup session holds it, so a reload or a takeover in another browser carries on).
 */

type StepId = keyof OwnerSummary["steps"] | "finish";

const STEPS: { id: StepId; label: string; Component: (props: StepProps) => React.ReactNode }[] = [
  { id: "account", label: "Account", Component: AccountStep },
  { id: "authenticator", label: "Authenticator app", Component: AuthenticatorStep },
  { id: "passkey", label: "Passkey", Component: PasskeyStep },
  { id: "recovery", label: "Recovery codes", Component: RecoveryStep },
  { id: "organisation", label: "Organisation", Component: OrganisationStep },
  { id: "keys", label: "Keys", Component: KeysStep },
  { id: "finish", label: "Finish", Component: FinishStep },
];

function firstOpenStep(summary: OwnerSummary): StepId {
  return STEPS.find((step) => step.id === "finish" || !summary.steps[step.id as keyof OwnerSummary["steps"]])!.id;
}

export default function OwnerWizard() {
  const [summary, setSummary] = useState<OwnerSummary | null>(null);
  const [current, setCurrent] = useState<StepId>("account");
  const [lost, setLost] = useState<string | null>(null);
  const [loadError, setLoadError] = useState("");

  const refresh = useCallback(async (advance: boolean) => {
    try {
      const next = await ownerApi.summary();
      setSummary(next);
      if (advance) setCurrent(firstOpenStep(next));
    } catch (error) {
      if (error instanceof OwnerApiError && error.needsSetupCode) setLost(error.message);
      else setLoadError(error instanceof Error ? error.message : "The setup status could not be loaded.");
    }
  }, []);

  useEffect(() => {
    void refresh(true);
  }, [refresh]);

  if (lost) {
    return (
      <div role="alert" className="ui-alert ui-alert-warning flex flex-col gap-2">
        <p>{lost}</p>
        <Link href="/setup" className="underline">Enter the setup code</Link>
      </div>
    );
  }
  if (loadError) return <p role="alert" className="ui-alert ui-alert-danger">{loadError}</p>;
  if (!summary) return <p role="status" className="text-sm text-fg-muted">Loading…</p>;

  const step = STEPS.find((item) => item.id === current)!;
  const isDone = (id: StepId) => id !== "finish" && summary.steps[id];
  const reachable = (index: number) => STEPS.slice(0, index).every((item) => isDone(item.id));

  return (
    <div className="flex flex-col gap-6">
      <nav aria-label="Owner account steps">
        <ol className="flex flex-wrap gap-2">
          {STEPS.map((item, index) => (
            <li key={item.id}>
              <button
                type="button"
                onClick={() => setCurrent(item.id)}
                disabled={!reachable(index)}
                aria-current={item.id === current ? "step" : undefined}
                className={`ui-btn ${item.id === current ? "ui-btn-primary" : "ui-btn-secondary"} inline-flex items-center gap-1.5 text-xs`}
              >
                {isDone(item.id) && <Check size={12} aria-hidden="true" />}
                {item.label}
                {isDone(item.id) && <span className="sr-only"> (done)</span>}
              </button>
            </li>
          ))}
        </ol>
      </nav>
      <step.Component key={step.id} summary={summary} onDone={() => void refresh(true)} onSessionLost={setLost} />
    </div>
  );
}
