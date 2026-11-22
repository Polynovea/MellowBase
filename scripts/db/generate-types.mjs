// Regenerates the Kysely database types in lib/db/generated/ from a database that has every
// migration applied (normally the local plain PostgreSQL 16 from scripts/dev-db/setup.mjs).
//
//   node scripts/db/generate-types.mjs [--url <postgres-url>] [--check]
//
// The URL defaults to POLYNOVEA_TEST_POSTGRES_OWNER_URL from .env.test.local. --check fails if the
// committed files differ from what the database produces (for local CI).
//
// Two files are written:
//   database.ts   tables and views, by kysely-codegen
//   functions.ts  the SQL functions in schema public, for lib/db/functions.ts callFunction()
//
// Type mappings follow what PostgREST returned, so converted code keeps the same shapes:
// timestamps and dates are ISO strings, bigint and numeric are numbers.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import pg from "pg";

const root = process.cwd();
const outDir = path.join(root, "lib", "db", "generated");
const check = process.argv.includes("--check");

function envFromFile(file, key) {
  if (!existsSync(file)) return undefined;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    if (line.startsWith(`${key}=`)) return line.slice(key.length + 1).trim();
  }
  return undefined;
}

const urlArg = process.argv.indexOf("--url");
const url = (urlArg > -1 ? process.argv[urlArg + 1] : undefined)
  || process.env.POLYNOVEA_TEST_POSTGRES_OWNER_URL
  || envFromFile(path.join(root, ".env.test.local"), "POLYNOVEA_TEST_POSTGRES_OWNER_URL");
if (!url) {
  console.error("No database URL. Run node scripts/dev-db/setup.mjs first, or pass --url.");
  process.exit(1);
}

const TYPE_MAPPING = { timestamptz: "string", timestamp: "string", date: "string", int8: "number" };

// ── Tables (kysely-codegen) ──────────────────────────────────────────────────
const tmp = mkdtempSync(path.join(os.tmpdir(), "polynovea-typegen-"));
const tablesOut = path.join(tmp, "database.ts");
execFileSync(
  process.execPath,
  [
    path.join(root, "node_modules", "kysely-codegen", "dist", "cli", "bin.js"),
    "--dialect", "postgres",
    "--url", url,
    "--default-schema", "public",
    // Only the CMS tables; polynovea_auth belongs to the auth library and is typed by it.
    "--include-pattern", "public.*",
    "--date-parser", "string",
    "--numeric-parser", "number",
    "--type-mapping", JSON.stringify(TYPE_MAPPING),
    "--log-level", "error",
    "--out-file", tablesOut,
  ],
  { stdio: "inherit" },
);

// ── Functions (pg_proc) ──────────────────────────────────────────────────────
const SCALAR_TYPES = {
  uuid: "string", text: "string", "character varying": "string", character: "string", citext: "string", name: "string", inet: "string",
  smallint: "number", integer: "number", bigint: "number", real: "number", "double precision": "number", numeric: "number",
  boolean: "boolean", json: "JsonValue", jsonb: "JsonValue",
  "timestamp with time zone": "string", "timestamp without time zone": "string", date: "string", "time without time zone": "string", interval: "string",
  void: "null",
};

function tsType(pgType) {
  if (pgType.endsWith("[]")) return `${tsType(pgType.slice(0, -2))}[]`;
  const base = pgType.replace(/\(.*\)$/, "");
  return SCALAR_TYPES[base] ?? "unknown";
}

const client = new pg.Client({ connectionString: url, ssl: false });
await client.connect();
const { rows } = await client.query(`
  select
    p.proname as name,
    p.proretset as returns_set,
    p.prokind as kind,
    format_type(p.prorettype, null) as return_type,
    t.typtype as return_typtype,
    p.pronargs as nargs,
    p.pronargdefaults as ndefaults,
    coalesce(p.proargnames, array[]::text[]) as arg_names,
    coalesce(p.proargmodes::text[], array[]::text[]) as arg_modes,
    array(select format_type(x, null) from unnest(coalesce(p.proallargtypes, p.proargtypes::oid[])) with ordinality as a(x, n) order by n) as arg_types,
    case when t.typtype = 'c' then array(
      select format('%s:%s', a.attname, format_type(a.atttypid, null))
      from pg_attribute a where a.attrelid = t.typrelid and a.attnum > 0 and not a.attisdropped order by a.attnum
    ) else array[]::text[] end as composite_columns
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  join pg_type t on t.oid = p.prorettype
  where n.nspname = 'public'
    and p.prokind = 'f'
    and p.prorettype <> 'trigger'::regtype
    and not exists (select 1 from pg_depend d where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e')
  order by p.proname, p.oid
`);
await client.end();

const seen = new Set();
const entries = [];
for (const fn of rows) {
  if (seen.has(fn.name)) {
    console.error(`Function ${fn.name} is overloaded; callFunction needs one signature per name.`);
    process.exit(1);
  }
  seen.add(fn.name);

  const modes = fn.arg_modes.length ? fn.arg_modes : fn.arg_types.map(() => "i");
  const inArgs = [];
  const outCols = [];
  fn.arg_types.forEach((type, index) => {
    const mode = modes[index];
    const name = fn.arg_names[index] || `arg${index + 1}`;
    if (mode === "i" || mode === "b" || mode === "v") inArgs.push({ name, type });
    if (mode === "o" || mode === "b" || mode === "t") outCols.push({ name, type });
  });
  const firstOptional = inArgs.length - fn.ndefaults;
  const args = inArgs.map((a, i) => `${JSON.stringify(a.name)}${i >= firstOptional ? "?" : ""}: ${tsType(a.type)} | null`);

  let shape;
  let returns;
  if (outCols.length) {
    returns = `{ ${outCols.map((c) => `${JSON.stringify(c.name)}: ${tsType(c.type)} | null`).join("; ")} }`;
    shape = fn.returns_set ? "rows" : "row";
  } else if (fn.return_typtype === "c") {
    returns = `{ ${fn.composite_columns.map((c) => { const [n, ...t] = c.split(":"); return `${JSON.stringify(n)}: ${tsType(t.join(":"))} | null`; }).join("; ")} }`;
    shape = fn.returns_set ? "rows" : "row";
  } else if (fn.return_type === "void") {
    returns = "null";
    shape = "void";
  } else {
    returns = `${tsType(fn.return_type)}${fn.return_type === "record" ? "" : " | null"}`;
    if (fn.return_type === "record") returns = "Record<string, unknown>";
    shape = fn.returns_set ? (fn.return_type === "record" ? "rows" : "scalars") : (fn.return_type === "record" ? "row" : "scalar");
  }
  entries.push({ name: fn.name, args, argNames: inArgs.map((a) => a.name), returns, shape });
}

const functionsTs = `/**
 * Generated by scripts/db/generate-types.mjs from pg_proc. Do not edit by hand.
 * One entry per SQL function in schema public (extension and trigger functions excluded).
 */
import type { JsonValue } from "./database";

export type SqlFunctionShape = "scalar" | "scalars" | "row" | "rows" | "void";

export interface SqlFunctions {
${entries.map((e) => `  ${e.name}: {\n    args: ${e.args.length ? `{ ${e.args.join("; ")} }` : "Record<string, never>"};\n    returns: ${e.returns};\n    shape: ${JSON.stringify(e.shape)};\n  };`).join("\n")}
}

/** Runtime copy of each function's argument names and result shape, used to validate calls. */
export const SQL_FUNCTIONS: { readonly [K in keyof SqlFunctions]: { readonly argNames: readonly string[]; readonly shape: SqlFunctionShape } } = {
${entries.map((e) => `  ${e.name}: { argNames: ${JSON.stringify(e.argNames)}, shape: ${JSON.stringify(e.shape)} },`).join("\n")}
};
`;

const outputs = {
  "database.ts": readFileSync(tablesOut, "utf8"),
  "functions.ts": functionsTs,
};
rmSync(tmp, { recursive: true, force: true });

let stale = false;
for (const [file, content] of Object.entries(outputs)) {
  const target = path.join(outDir, file);
  const current = existsSync(target) ? readFileSync(target, "utf8").replace(/\r\n/g, "\n") : null;
  if (check) {
    if (current !== content.replace(/\r\n/g, "\n")) {
      console.error(`lib/db/generated/${file} is out of date. Run node scripts/db/generate-types.mjs`);
      stale = true;
    }
  } else {
    writeFileSync(target, content);
  }
}
if (stale) process.exit(1);
console.log(check ? "Generated database types are up to date." : `Wrote lib/db/generated/database.ts and functions.ts (${entries.length} functions).`);
