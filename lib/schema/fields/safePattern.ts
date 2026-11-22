// Field validation patterns are written by workspace admins and run against editor input on
// the server, so a pattern with catastrophic backtracking would let one workspace stall the
// process for everyone. Patterns are therefore length-limited, must compile, and may not
// repeat a group that itself contains a quantifier (the classic `(a+)+` shape).

export const MAX_FIELD_PATTERN_LENGTH = 256;
export const MAX_PATTERN_INPUT_LENGTH = 10_000;

// A group containing an open-ended quantifier that is itself repeated: (a+)+, (\w*){2,}, (.*a){12}.
const NESTED_UNBOUNDED = /\((?:[^()\\]|\\.){0,256}?(?:[+*]|\{\d+,\})(?:[^()\\]|\\.){0,256}?\)[+*{]/;
// An alternation group repeated without bound: (a|aa)*. Bounded repeats like (\d{3}-){2} stay allowed.
const UNBOUNDED_ALTERNATION = /\((?:[^()\\]|\\.){0,256}?\|(?:[^()\\]|\\.){0,256}?\)(?:[+*]|\{\d+,\})/;
// A backreference makes matching non-regular and can be exponential.
const BACKREFERENCE = /\\[1-9]|\\k</;

export function fieldPatternProblem(pattern: string): string | null {
  if (pattern.length > MAX_FIELD_PATTERN_LENGTH) return `Pattern must be at most ${MAX_FIELD_PATTERN_LENGTH} characters`;
  // nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp -- compile-only validity check, never run against input
  try { new RegExp(pattern); } catch { return "Pattern is not a valid regular expression"; }
  if (NESTED_UNBOUNDED.test(pattern) || UNBOUNDED_ALTERNATION.test(pattern)) return "Pattern may not repeat a group that has an open-ended quantifier or alternation";
  if (BACKREFERENCE.test(pattern)) return "Pattern may not use backreferences";
  return null;
}

const compiled = new Map<string, RegExp | null>();

/** Returns the compiled pattern, or null when it is not a safe pattern. */
export function compileFieldPattern(pattern: string): RegExp | null {
  if (!compiled.has(pattern)) {
    if (compiled.size > 1000) compiled.clear();
    // nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp -- vetted by fieldPatternProblem
    compiled.set(pattern, fieldPatternProblem(pattern) ? null : new RegExp(pattern));
  }
  return compiled.get(pattern) ?? null;
}
