import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const here = dirname(fileURLToPath(import.meta.url));
const options: ts.CompilerOptions = {
  strict: true,
  noEmit: true,
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ES2022,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  lib: ["lib.es2022.d.ts", "lib.dom.d.ts", "lib.dom.iterable.d.ts"],
  skipLibCheck: true,
  types: [],
};

function diagnostics(rootNames: string[], host?: ts.CompilerHost) {
  const program = ts.createProgram({ rootNames, options, host });
  return ts.getPreEmitDiagnostics(program).map((d) => ({
    file: d.file?.fileName,
    line: d.file && d.start !== undefined ? d.file.getLineAndCharacterOfPosition(d.start).line + 1 : 0,
    text: ts.flattenDiagnosticMessageText(d.messageText, "\n"),
  }));
}

const positive = resolve(here, "types.positive.ts");
const negative = resolve(here, "types.negative.ts");

describe("SDK types compiled against the fixture schema", () => {
  it("correct use type-checks, and every expected error fires", () => {
    expect(diagnostics([positive, negative])).toEqual([]);
  }, 60_000);

  it("each expected error is on its own line (no directive is satisfied by an unrelated error)", () => {
    const source = readFileSync(negative, "utf8");
    const lines = source.split("\n");
    const expected = lines.flatMap((line, i) => (line.trim().startsWith("// @ts-expect-error") ? [i + 2] : []));
    expect(expected.length).toBe(18);
    const stripped = lines.map((line) => (line.trim().startsWith("// @ts-expect-error") ? "" : line)).join("\n");
    const host = ts.createCompilerHost(options);
    const read = host.readFile.bind(host);
    host.readFile = (file) => (resolve(file) === negative ? stripped : read(file));
    const getSourceFile = host.getSourceFile.bind(host);
    host.getSourceFile = (file, lang, onError, create) =>
      resolve(file) === negative ? ts.createSourceFile(file, stripped, lang) : getSourceFile(file, lang, onError, create);
    const found = diagnostics([negative], host).filter((d) => d.file && resolve(d.file) === negative);
    const errorLines = new Set(found.map((d) => d.line));
    expect(expected.filter((line) => !errorLines.has(line))).toEqual([]);
    expect([...errorLines].filter((line) => !expected.includes(line))).toEqual([]);
  }, 60_000);
});
