import { beforeEach, describe, expect, it, vi } from "vitest";

const { timingSafeEqualSpy } = vi.hoisted(() => ({ timingSafeEqualSpy: { calls: [] as Array<[number, number]> } }));

vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return {
    ...actual,
    timingSafeEqual: (a: NodeJS.ArrayBufferView, b: NodeJS.ArrayBufferView) => {
      timingSafeEqualSpy.calls.push([a.byteLength, b.byteLength]);
      return actual.timingSafeEqual(a, b);
    },
  };
});

const {
  SETUP_CODE_ENV, SETUP_CODE_TTL_MS, SetupCodeConfigError, classifyEnvironmentCode, encodeCrockford, formatSetupCode, issueAndPrintSetupCode,
  issueSetupCode, normaliseSetupCode, resetSetupCodeForTests, setupCodeExpiresAt, verifySetupCode,
} = await import("./setupCode");

const T0 = Date.UTC(2026, 10, 23, 12, 0, 0);

function issue(env: Record<string, string | undefined> = {}) {
  return issueSetupCode({ env, now: T0 });
}

beforeEach(() => {
  resetSetupCodeForTests();
  timingSafeEqualSpy.calls = [];
});

describe("generated setup code", () => {
  it("is 26 Crockford base32 characters (128 bits) shown in 6-5-5-5-5 groups", () => {
    const issued = issue();
    expect(issued.source).toBe("generated");
    expect(issued.display).toMatch(/^[0-7][0-9A-HJKMNP-TV-Z]{5}(-[0-9A-HJKMNP-TV-Z]{5}){4}$/);
    expect(issued.display!.replace(/-/g, "")).toHaveLength(26);
  });

  it("encodes 16 bytes losslessly", () => {
    expect(encodeCrockford(new Uint8Array(16))).toBe("0".repeat(26));
    expect(encodeCrockford(new Uint8Array(16).fill(255))).toBe("7" + "Z".repeat(25));
  });

  it("differs on every issue and replaces the previous code", () => {
    const first = issue().display!;
    const second = issue().display!;
    expect(first).not.toBe(second);
    expect(verifySetupCode(first, T0 + 1)).toBe(false);
    expect(verifySetupCode(second, T0 + 1)).toBe(true);
  });

  it("is never stored in plain text", () => {
    const issued = issue();
    const raw = issued.display!.replace(/-/g, "");
    const state = (globalThis as Record<symbol, unknown>)[Symbol.for("polynovea.setup.code")];
    expect(JSON.stringify(state)).not.toContain(raw);
    expect(String((state as { digest: Buffer }).digest.length)).toBe("32");
  });
});

describe("expiry", () => {
  it("works until one hour after issue, then stops", () => {
    const code = issue().display!;
    expect(setupCodeExpiresAt()).toBe(T0 + SETUP_CODE_TTL_MS);
    expect(verifySetupCode(code, T0 + SETUP_CODE_TTL_MS - 1)).toBe(true);
    expect(verifySetupCode(code, T0 + SETUP_CODE_TTL_MS)).toBe(false);
    expect(verifySetupCode(code, T0 + 2 * SETUP_CODE_TTL_MS)).toBe(false);
  });

  it("a restart (a new issue) gives a fresh hour", () => {
    issue();
    const later = issueSetupCode({ env: {}, now: T0 + 3 * SETUP_CODE_TTL_MS });
    expect(verifySetupCode(later.display!, T0 + 3 * SETUP_CODE_TTL_MS + 1000)).toBe(true);
  });

  it("nothing verifies before a code is issued", () => {
    expect(verifySetupCode("0".repeat(26))).toBe(false);
    expect(verifySetupCode("")).toBe(false);
  });
});

describe("normalisation", () => {
  it("ignores case, spaces, dashes, dots and underscores", () => {
    expect(normaliseSetupCode(" ab-cd ef_gh.jk ")).toBe("ABCDEFGHJK");
  });

  it("maps Crockford look-alikes I and L to 1 and O to 0", () => {
    expect(normaliseSetupCode("iIlLoO")).toBe("111100");
  });

  it("accepts the code typed loosely", () => {
    const code = issue().display!;
    const loose = code.toLowerCase().replace(/-/g, " ").replace(/1/g, "l").replace(/0/g, "o");
    expect(verifySetupCode(loose, T0 + 1)).toBe(true);
    expect(verifySetupCode(code.replace(/-/g, ""), T0 + 1)).toBe(true);
  });

  it("formats any 26-character code in groups", () => {
    expect(formatSetupCode("ABCDEFGHJKMNPQRSTVWXYZ0123")).toBe("ABCDEF-GHJKM-NPQRS-TVWXY-Z0123");
  });
});

describe("constant-time check (structural)", () => {
  it("every input takes one digest comparison of two 32-byte buffers, right or wrong", () => {
    const code = issue().display!;
    const inputs: unknown[] = [code, "WRONG-CODE", "", "x".repeat(10_000), 12345, null, code.slice(0, 10)];
    const results = inputs.map((input) => {
      timingSafeEqualSpy.calls = [];
      const ok = verifySetupCode(input, T0 + 1);
      return { ok, calls: [...timingSafeEqualSpy.calls] };
    });
    expect(results.map((r) => r.ok)).toEqual([true, false, false, false, false, false, false]);
    for (const r of results) expect(r.calls).toEqual([[32, 32]]);
  });

  it("an expired or absent code still costs one comparison", () => {
    const code = issue().display!;
    timingSafeEqualSpy.calls = [];
    expect(verifySetupCode(code, T0 + SETUP_CODE_TTL_MS + 1)).toBe(false);
    resetSetupCodeForTests();
    expect(verifySetupCode(code, T0)).toBe(false);
    expect(timingSafeEqualSpy.calls).toEqual([[32, 32], [32, 32]]);
  });
});

describe("POLYNOVEA_SETUP_CODE", () => {
  const base32 = "7K3M9Q2T8VXZ4HNP6RJWBCDEFG"; // 26 Crockford characters
  const base64 = "q8Zr2Vx+L0p/Wn5TfGh_Ka"; // 22 base64 characters

  it("is used instead of a generated code, never echoed, and deleted from the environment", () => {
    const env: Record<string, string | undefined> = { [SETUP_CODE_ENV]: base32 };
    const issued = issue(env);
    expect(issued).toMatchObject({ source: "environment", display: null, expiresAt: T0 + SETUP_CODE_TTL_MS });
    expect(SETUP_CODE_ENV in env).toBe(false);
    expect(verifySetupCode(base32.toLowerCase(), T0 + 1)).toBe(true);
    expect(verifySetupCode(base32, T0 + SETUP_CODE_TTL_MS)).toBe(false);
  });

  it("accepts a grouped base32 code and a mixed-case base64 code without symbols", () => {
    issue({ [SETUP_CODE_ENV]: "7K3M9Q-2T8VX-Z4HNP-6RJWB-CDEFG" });
    expect(verifySetupCode("7k3m9q2t8vxz4hnp6rjwbcdefg", T0 + 1)).toBe(true);
    issue({ [SETUP_CODE_ENV]: "q8Zr2VxL0pWn5TfGhKaB3c" });
    expect(verifySetupCode("q8Zr2VxL0pWn5TfGhKaB3c", T0 + 1)).toBe(true);
  });

  it("compares a base64 code exactly (it is case-sensitive)", () => {
    issue({ [SETUP_CODE_ENV]: base64 });
    expect(verifySetupCode(base64, T0 + 1)).toBe(true);
    expect(verifySetupCode(` ${base64} `, T0 + 1)).toBe(true);
    expect(verifySetupCode(base64.toUpperCase(), T0 + 1)).toBe(false);
  });

  it.each([
    ["25 base32 characters", "7K3M9Q2T8VXZ4HNP6RJWBCDEF"],
    ["21 base64 characters", "q8Zr2Vx+L0p/Wn5TfGh_K"],
    ["24 single-case letters and digits (judged as base32)", "Q8ZR2VXL0PWN5TFGHKAB3C7D"],
    ["a short password", "hunter2"],
    ["characters outside both alphabets", "this is my setup code, ok!"],
    ["a long but repetitive value", "A".repeat(40)],
  ])("is refused at boot when it is %s", (_label, value) => {
    const env: Record<string, string | undefined> = { [SETUP_CODE_ENV]: value };
    expect(() => issue(env)).toThrow(SetupCodeConfigError);
    expect(SETUP_CODE_ENV in env).toBe(false);
    expect(verifySetupCode(value, T0 + 1)).toBe(false);
  });

  it("the refusal never repeats the value", () => {
    try {
      classifyEnvironmentCode("hunter2-secret");
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message).not.toContain("hunter2");
    }
  });

  it("an empty value falls back to a generated code", () => {
    const env: Record<string, string | undefined> = { [SETUP_CODE_ENV]: "  " };
    expect(issue(env).source).toBe("generated");
    expect(SETUP_CODE_ENV in env).toBe(false);
  });
});

describe("issueAndPrintSetupCode", () => {
  it("issues once and hands the code to the announcer", () => {
    const announce = vi.fn();
    const issued = issueAndPrintSetupCode({ env: {}, now: T0, announce });
    expect(announce).toHaveBeenCalledWith(issued);
    expect(verifySetupCode(issued.display!, T0 + 1)).toBe(true);
  });

  it("the default announcer logs the generated code but not an operator-supplied one", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const generated = issueAndPrintSetupCode({ env: {}, now: T0 });
    expect(info.mock.calls[0][0]).toContain(generated.display!);
    issueAndPrintSetupCode({ env: { [SETUP_CODE_ENV]: "7K3M9Q2T8VXZ4HNP6RJWBCDEFG" }, now: T0 });
    expect(info.mock.calls[1][0]).not.toContain("7K3M9Q2T8VXZ4HNP6RJWBCDEFG");
    info.mockRestore();
  });
});
