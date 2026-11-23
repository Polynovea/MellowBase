import OwnerWizard from "@/components/setup/owner/OwnerWizard";

// Steps 3 and 4 of the setup wizard: the owner account (password, authenticator app, passkey,
// recovery codes), the organisation, the keys to keep, and the finish. The shared shell (step list,
// setup-mode check) is app/setup/layout.tsx. Everything is held in the setup session until Finish
// writes it in one transaction (lib/setup/owner/finalise.ts).

export const dynamic = "force-dynamic";

export default function SetupOwnerPage() {
  return (
    <section className="ui-section flex flex-col gap-6">
      <header className="flex flex-col gap-2">
        <p className="ui-eyebrow">Step 3</p>
        <h2 className="ui-section-title">Create the owner account</h2>
        <p className="ui-section-description">
          A few minutes, one screen at a time. Nothing is saved until you press Finish at the end. If you close this tab, or want to carry on in another
          browser, enter the replacement setup code the server log printed when your code was used, and you&apos;ll pick up where you left off
          (within the hour).
        </p>
      </header>
      <OwnerWizard />
    </section>
  );
}
