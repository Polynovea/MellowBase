import {
  confirmKeys,
  confirmRecoveryCode,
  confirmTotp,
  enrolmentSummary,
  issueRecoveryCodes,
  passkeyRegistrationOptions,
  publicAddress,
  readEnrolment,
  revealKeys,
  stageAccount,
  stageOrganisation,
  startTotp,
  TEMPORARY_ROUTE_WARNING,
  verifyPasskeyRegistration,
} from "@/lib/setup/owner/enrolment";
import { finaliseOwnerSetup } from "@/lib/setup/owner/finalise";
import type { OwnerAction } from "@/lib/setup/owner/http";

/**
 * The owner step's actions, one per POST /api/setup/owner/<name>. Each returns only what the
 * browser needs for that moment: secrets (the QR address, recovery codes, keys) are returned once,
 * by the call that makes or reveals them, and never by the summary.
 */
export const OWNER_ACTIONS: Readonly<Record<string, OwnerAction>> = Object.freeze({
  account: async (session, body) => stageAccount(session, { email: body.email, displayName: body.displayName, password: body.password }),
  "totp-start": async (session) => startTotp(session),
  "totp-confirm": async (session, body) => {
    await confirmTotp(session, body.code);
    return { confirmed: true };
  },
  "passkey-options": async (session) => passkeyRegistrationOptions(session),
  passkey: async (session, body) => {
    await verifyPasskeyRegistration(session, body.response);
    return { registered: true };
  },
  "recovery-codes": async (session) => issueRecoveryCodes(session),
  "recovery-confirm": async (session, body) => {
    confirmRecoveryCode(session, body.code);
    return { confirmed: true };
  },
  organisation: async (session, body) => stageOrganisation(session, { organisationName: body.organisationName, workspaceName: body.workspaceName, starterContent: body.starterContent }),
  "keys-reveal": async (session) => revealKeys(session),
  "keys-confirm": async (session, body) => {
    await confirmKeys(session, { masterKeyTail: body.masterKeyTail, backupTail: body.backupTail });
    return { confirmed: true };
  },
  finish: async (session) => {
    const { next } = await finaliseOwnerSetup(session);
    return { next };
  },
});

/** GET /api/setup/owner: progress and labels only, plus whether this address is a temporary one. */
export const ownerSummary: OwnerAction = async (session) => {
  let temporaryRoute: boolean | null = null;
  try {
    temporaryRoute = publicAddress().temporary;
  } catch {
    // Reported by the passkey step, with what to fix.
  }
  return { ...enrolmentSummary(readEnrolment(session)), temporaryRoute, temporaryRouteWarning: temporaryRoute ? TEMPORARY_ROUTE_WARNING : null };
};
