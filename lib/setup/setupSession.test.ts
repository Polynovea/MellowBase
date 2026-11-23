import { beforeEach, describe, expect, it } from "vitest";
import {
  SETUP_SESSION_COOKIE, SETUP_SESSION_TTL_MS, SetupSessionError, clearSetupSessionCookie, deleteSetupState, endSetupSession, getSetupState,
  isActiveSetupSession, readSetupSessionToken, requireSetupSession, resetSetupSessionsForTests, setSetupState, setupSessionCookie,
  setupSessionErrorResponse, startSetupSession,
} from "./setupSession";

declare module "./setupSession" {
  interface SetupSessionState {
    testStep: { value: number };
  }
}

const T0 = Date.UTC(2026, 10, 23, 12, 0, 0);

function requestWith(token: string | null, extraCookies = "") {
  const cookie = [extraCookies, token ? `${SETUP_SESSION_COOKIE}=${token}` : ""].filter(Boolean).join("; ");
  return { headers: new Headers(cookie ? { cookie } : {}) };
}

function errorCode(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (error) {
    expect(error).toBeInstanceOf(SetupSessionError);
    expect((error as SetupSessionError).status).toBe(401);
    return (error as SetupSessionError).code;
  }
}

beforeEach(() => resetSetupSessionsForTests());

describe("cookie", () => {
  it("carries 256 random bits as base64url", () => {
    const { token } = startSetupSession("https", T0);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(token, "base64url")).toHaveLength(32);
  });

  it("is __Host-, HttpOnly, Secure, SameSite=Strict, Path=/ and one hour long", () => {
    const value = setupSessionCookie("abc");
    expect(value.startsWith("__Host-polynovea-setup=abc;")).toBe(true);
    for (const part of ["Path=/", "Max-Age=3600", "HttpOnly", "Secure", "SameSite=Strict"]) expect(value).toContain(part);
    expect(value).not.toMatch(/Domain=/i);
    expect(clearSetupSessionCookie()).toContain("Max-Age=0");
  });

  it("is read from among other cookies", () => {
    expect(readSetupSessionToken(`a=1; ${SETUP_SESSION_COOKIE}=tok; b=2`)).toBe("tok");
    expect(readSetupSessionToken("a=1")).toBeNull();
    expect(readSetupSessionToken(null)).toBeNull();
  });

  it("only a digest of the cookie is held on the server", () => {
    const { token } = startSetupSession("https", T0);
    const held = (globalThis as Record<symbol, unknown>)[Symbol.for("polynovea.setup.session")];
    expect(JSON.stringify(held)).not.toContain(token);
  });
});

describe("requireSetupSession", () => {
  it("returns the session for the right cookie", () => {
    const { token, session } = startSetupSession("loopback", T0);
    expect(requireSetupSession(requestWith(token), T0 + 1)).toEqual(session);
    expect(session).toMatchObject({ transport: "loopback", createdAt: T0, expiresAt: T0 + SETUP_SESSION_TTL_MS });
  });

  it("throws a 401 without a cookie or with an unknown one", () => {
    startSetupSession("https", T0);
    expect(errorCode(() => requireSetupSession(requestWith(null), T0))).toBe("SETUP_SESSION_REQUIRED");
    expect(errorCode(() => requireSetupSession(requestWith("made-up"), T0))).toBe("SETUP_SESSION_REQUIRED");
    expect(errorCode(() => requireSetupSession(requestWith("x".repeat(500)), T0))).toBe("SETUP_SESSION_REQUIRED");
  });

  it("expires one hour after the code was entered", () => {
    const { token } = startSetupSession("https", T0);
    expect(requireSetupSession(requestWith(token), T0 + SETUP_SESSION_TTL_MS - 1)).toBeTruthy();
    expect(errorCode(() => requireSetupSession(requestWith(token), T0 + SETUP_SESSION_TTL_MS))).toBe("SETUP_SESSION_EXPIRED");
  });

  it("ends when setup finishes", () => {
    const { token } = startSetupSession("https", T0);
    endSetupSession();
    expect(errorCode(() => requireSetupSession(requestWith(token), T0 + 1))).toBe("SETUP_SESSION_REQUIRED");
  });
});

describe("takeover", () => {
  it("entering the code again takes over; the old browser is told setup continued elsewhere", () => {
    const first = startSetupSession("https", T0);
    expect(first.tookOver).toBe(false);
    const second = startSetupSession("https", T0 + 1000);
    expect(second.tookOver).toBe(true);

    expect(requireSetupSession(requestWith(second.token), T0 + 2000).id).toBe(second.session.id);
    expect(errorCode(() => requireSetupSession(requestWith(first.token), T0 + 2000))).toBe("SETUP_TAKEN_OVER");
    expect(new SetupSessionError("SETUP_TAKEN_OVER").message).toBe("Setup continued in another browser.");
    expect(isActiveSetupSession(first.session, T0 + 2000)).toBe(false);
    expect(isActiveSetupSession(second.session, T0 + 2000)).toBe(true);
  });

  it("only one session is ever active", () => {
    const tokens = [0, 1, 2].map((i) => startSetupSession("https", T0 + i).token);
    const active = tokens.filter((token) => errorCode(() => requireSetupSession(requestWith(token), T0 + 10)) === null);
    expect(active).toEqual([tokens[2]]);
  });

  it("replacing an expired session is not reported as a takeover", () => {
    startSetupSession("https", T0);
    expect(startSetupSession("https", T0 + SETUP_SESSION_TTL_MS + 1).tookOver).toBe(false);
  });

  it("the new browser keeps the wizard's progress; the old one can no longer write", () => {
    const first = startSetupSession("https", T0);
    setSetupState(first.session, "testStep", { value: 1 }, T0 + 1);
    const second = startSetupSession("https", T0 + 2);
    expect(getSetupState(second.session, "testStep", T0 + 3)).toEqual({ value: 1 });
    expect(errorCode(() => setSetupState(first.session, "testStep", { value: 2 }, T0 + 3))).toBe("SETUP_TAKEN_OVER");
    expect(errorCode(() => getSetupState(first.session, "testStep", T0 + 3))).toBe("SETUP_TAKEN_OVER");
  });
});

describe("state store", () => {
  it("stores, reads and deletes typed state for the active session", () => {
    const { session } = startSetupSession("https", T0);
    expect(getSetupState(session, "testStep", T0)).toBeUndefined();
    setSetupState(session, "testStep", { value: 42 }, T0);
    expect(getSetupState(session, "testStep", T0)?.value).toBe(42);
    deleteSetupState(session, "testStep", T0);
    expect(getSetupState(session, "testStep", T0)).toBeUndefined();
  });

  it("refuses an expired session", () => {
    const { session } = startSetupSession("https", T0);
    expect(errorCode(() => setSetupState(session, "testStep", { value: 1 }, T0 + SETUP_SESSION_TTL_MS))).toBe("SETUP_SESSION_EXPIRED");
  });
});

describe("setupSessionErrorResponse", () => {
  it("is a plain 401 with the setup headers, clearing a stale cookie", async () => {
    const response = setupSessionErrorResponse(new SetupSessionError("SETUP_TAKEN_OVER"));
    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(await response.json()).toMatchObject({ success: false, code: "SETUP_TAKEN_OVER", error: "Setup continued in another browser." });
  });

  it("does not touch cookies when there was no session", () => {
    expect(setupSessionErrorResponse(new SetupSessionError("SETUP_SESSION_REQUIRED")).headers.get("set-cookie")).toBeNull();
  });
});
