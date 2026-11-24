"use client";

import { usePathname } from "next/navigation";
import { Check } from "lucide-react";

export interface SetupStep {
  id: "code" | "database" | "owner" | "finish";
  label: string;
  hint: string;
}

/** Which wizard step a /setup address is: the owner page covers both the owner account and Finish. */
function currentStep(pathname: string): SetupStep["id"] {
  if (pathname.startsWith("/setup/database")) return "database";
  if (pathname.startsWith("/setup/owner")) return "owner";
  return "code";
}

/**
 * The wizard's step list, showing where you are: earlier steps are ticked, the current one is marked
 * (and announced as the current step), later ones are plain. It used to show every step the same.
 */
export default function SetupStepList({ steps }: { steps: readonly SetupStep[] }) {
  const current = currentStep(usePathname() ?? "/setup");
  const currentIndex = steps.findIndex((step) => step.id === current);
  return (
    <ol className="mt-6 space-y-3" aria-label="Setup steps">
      {steps.map((step, index) => {
        const done = index < currentIndex;
        const isCurrent = index === currentIndex || (current === "owner" && step.id === "finish");
        return (
          <li key={step.id} className="flex gap-3" aria-current={index === currentIndex ? "step" : undefined}>
            <span
              className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-xs ${
                done ? "border-success bg-success-muted text-success" : isCurrent ? "border-primary text-fg-primary" : "border-default text-fg-secondary"
              }`}
            >
              {done ? <Check size={12} aria-hidden /> : index + 1}
            </span>
            <span>
              <span className={`block text-sm ${isCurrent ? "font-semibold text-fg-primary" : "font-medium"}`}>
                {step.label}
                {done ? <span className="sr-only"> (done)</span> : null}
              </span>
              <span className="block text-xs text-fg-muted">{step.hint}</span>
            </span>
          </li>
        );
      })}
    </ol>
  );
}
