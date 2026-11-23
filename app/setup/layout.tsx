import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { resolveMode } from "@/lib/setup/mode";

// The setup wizard's shell. Server-rendered; each step is its own page under /setup.
// The mode check here is the page-side second layer under middleware.ts: on a finished install every
// /setup page is a 404 even if the middleware was skipped.

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Set up Polynovea CMS",
  robots: { index: false, follow: false },
};

const SETUP_STEPS = [
  { id: "code", label: "Setup code", hint: "From the server log" },
  { id: "database", label: "Database", hint: "Where your content lives" },
  { id: "owner", label: "Owner account", hint: "You, with two-step sign-in" },
  { id: "finish", label: "Finish", hint: "Organisation and first workspace" },
] as const;

export default async function SetupLayout({ children }: { children: React.ReactNode }) {
  const { mode } = await resolveMode();
  if (mode === "running") notFound();

  return (
    <div className="bg-canvas min-h-screen text-fg-primary">
      <div className="mx-auto flex max-w-5xl flex-col gap-8 px-4 py-10 md:flex-row md:px-8">
        <aside className="md:w-60 md:shrink-0">
          <p className="ui-eyebrow">Polynovea CMS</p>
          <h1 className="ui-page-title">Set up</h1>
          <ol className="mt-6 space-y-3" aria-label="Setup steps">
            {SETUP_STEPS.map((step, index) => (
              <li key={step.id} className="flex gap-3">
                <span className="border-default flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-xs text-fg-secondary">{index + 1}</span>
                <span>
                  <span className="block text-sm font-medium">{step.label}</span>
                  <span className="block text-xs text-fg-muted">{step.hint}</span>
                </span>
              </li>
            ))}
          </ol>
        </aside>
        <main className="ui-surface border-subtle min-w-0 flex-1 rounded-lg border p-6">
          {mode === "unavailable" ? (
            <section className="ui-section">
              <h2 className="ui-section-title">The database cannot be reached</h2>
              <p className="ui-section-description">Setup continues once the database is back. The server log says what failed.</p>
            </section>
          ) : (
            children
          )}
        </main>
      </div>
    </div>
  );
}
