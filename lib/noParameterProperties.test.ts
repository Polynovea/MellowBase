import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

// Scripts (certification, content:move, the workers) load lib/ through Node's type stripping, which
// rejects TypeScript that needs code generation: constructor parameter properties, enums and
// namespaces with runtime code. One such line breaks every script that imports the file, so keep
// them out of the code those scripts can reach. Test files run under Vitest and are exempt.
// packages/cms-sdk is compiled by its own build, so it is not checked here.
const ROOTS = ["lib", "scripts"];
const repo = path.resolve(__dirname, "..");

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "generated" || entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (/\.(ts|mts)$/.test(entry.name) && !/\.(test|spec)\.ts$|\.d\.ts$/.test(entry.name)) out.push(full);
  }
  return out;
}

function strippingProblems(file: string): string[] {
  const text = readFileSync(file, "utf8");
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const problems: string[] = [];
  const where = (node: ts.Node) => `${path.relative(repo, file).replaceAll("\\", "/")}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}`;
  const visit = (node: ts.Node) => {
    if (ts.isConstructorDeclaration(node)) {
      for (const parameter of node.parameters) {
        if (ts.getModifiers(parameter)?.length) problems.push(`${where(parameter)} parameter property`);
      }
    }
    if (ts.isEnumDeclaration(node) && !ts.getModifiers(node)?.some((m) => m.kind === ts.SyntaxKind.DeclareKeyword)) problems.push(`${where(node)} enum`);
    if (ts.isModuleDeclaration(node) && node.body && ts.isModuleBlock(node.body) && !ts.getModifiers(node)?.some((m) => m.kind === ts.SyntaxKind.DeclareKeyword)) {
      problems.push(`${where(node)} namespace`);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return problems;
}

describe("code loaded by scripts works under Node's type stripping", () => {
  it("has no parameter properties, enums or runtime namespaces", () => {
    const problems = ROOTS.flatMap((root) => sourceFiles(path.join(repo, root))).flatMap(strippingProblems);
    expect(problems).toEqual([]);
  });
});
