import { describe, expect, it } from "vitest";
import { compileFieldPattern, fieldPatternProblem } from "./safePattern";

describe("field validation patterns", () => {
  it.each(["^[a-z0-9-]+$", "^\\d{3}-\\d{4}$", "^(?:https?)://\\S+$", "^[A-Z]{2}\\d{2}(?:[A-Z0-9]{4}){2,7}$", "^(\\d{3}-){2}\\d{4}$", "^(foo|bar)$", "^#?([a-f0-9]{6}|[a-f0-9]{3})$"])(
    "accepts the ordinary pattern %s",
    (pattern) => expect(fieldPatternProblem(pattern)).toBeNull(),
  );

  it.each(["(a+)+$", "^(a|aa)*$", "(\\w*){2,}", "^(.*a){12}$", "(a)\\1", "x".repeat(300), "("])(
    "rejects the unsafe or invalid pattern %s",
    (pattern) => {
      expect(fieldPatternProblem(pattern)).not.toBeNull();
      expect(compileFieldPattern(pattern)).toBeNull();
    },
  );

  it("compiles and caches a safe pattern", () => {
    expect(compileFieldPattern("^[a-z]+$")?.test("slug")).toBe(true);
  });
});
