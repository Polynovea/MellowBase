/**
 * Schema drift: is the server's model still the one these types were pulled from?
 *
 * The SDK sends the pulled hash; when the server's differs it answers `minor`, `major` or `unknown`
 * for the fields that still exist, plus the caller's currently readable fields. Fields that were in
 * the types file but are no longer readable are a breaking change the SDK detects itself.
 */
import { SCHEMA_CHANGE_HEADER, SCHEMA_FIELDS_HEADER, SCHEMA_HASH_HEADER } from "./contract.js";

/** The `schema` constant of a generated types file. */
export interface SchemaManifest {
  readonly hash?: string;
  readonly models: { readonly [model: string]: { readonly hash: string; readonly fields: readonly string[] } };
}

export type SchemaChangeKind = "minor" | "major" | "unknown";

export interface SchemaChangeEvent {
  model: string;
  pulledHash: string;
  serverHash: string;
  change: SchemaChangeKind;
  /** Fields in the types file the caller can no longer read (removed, renamed or hidden). */
  removedFields: string[];
}

export class PolynoveaSchemaDriftError extends Error {
  constructor(public event: SchemaChangeEvent) {
    super(`${event.model} changed in a breaking way since your types were pulled (${describe(event)}). The request completed; run \`polynovea-cms types pull\`.`);
    this.name = "PolynoveaSchemaDriftError";
  }
}

export interface DriftOptions {
  /** Throw PolynoveaSchemaDriftError on a breaking change instead of warning. Default false. */
  strictSchema?: boolean;
  /** Called once per model and server hash for every change, minor included. */
  onSchemaChange?: (event: SchemaChangeEvent) => void;
  /** Where warnings go. Default console. */
  logger?: { warn: (message: string) => void };
}

function describe(event: SchemaChangeEvent): string {
  const removed = event.removedFields.length ? `; no longer readable: ${event.removedFields.join(", ")}` : "";
  return `types ${event.pulledHash.slice(0, 12)}, server ${event.serverHash.slice(0, 12)}${removed}`;
}

/** Warnings are once per process. */
const warned = new Set<string>();

/** Tests only. */
export function resetSchemaDriftWarnings(): void {
  warned.clear();
}

export class SchemaDriftMonitor {
  private readonly seen = new Set<string>();
  constructor(private readonly manifest: SchemaManifest | undefined, private readonly options: DriftOptions) {}

  /** The hash to send for a model, if its types were pulled. */
  requestHash(model: string): string | undefined {
    return this.manifest?.models[model]?.hash;
  }

  /** Inspect a response. Throws only in strict mode, and only on a breaking change. */
  check(model: string, headers: Headers): SchemaChangeEvent | null {
    const pulled = this.manifest?.models[model];
    const serverHash = headers.get(SCHEMA_HASH_HEADER)?.trim().toLowerCase();
    if (!pulled || !serverHash || serverHash === pulled.hash) return null;

    const signal = headers.get(SCHEMA_CHANGE_HEADER)?.trim().toLowerCase();
    let change: SchemaChangeKind = signal === "minor" || signal === "major" ? signal : "unknown";
    const fieldsHeader = headers.get(SCHEMA_FIELDS_HEADER);
    let removedFields: string[] = [];
    if (fieldsHeader !== null) {
      const now = new Set(fieldsHeader.split(",").map((key) => key.trim()).filter(Boolean));
      removedFields = pulled.fields.filter((key) => !now.has(key));
      if (removedFields.length) change = "major";
    }
    const event: SchemaChangeEvent = { model, pulledHash: pulled.hash, serverHash, change, removedFields };

    const key = `${model}\n${pulled.hash}\n${serverHash}`;
    if (!this.seen.has(key)) {
      this.seen.add(key);
      this.options.onSchemaChange?.(event);
    }
    if (change !== "minor" && !warned.has(key)) {
      warned.add(key);
      const message = change === "major"
        ? `[polynovea-cms] ${model} changed in a breaking way since your types were pulled (${describe(event)}). Run \`polynovea-cms types pull\`.`
        : `[polynovea-cms] ${model} changed since your types were pulled and the server cannot say whether it is breaking (${describe(event)}). Run \`polynovea-cms types pull\`.`;
      (this.options.logger ?? console).warn(message);
    }
    if (change === "major" && this.options.strictSchema) throw new PolynoveaSchemaDriftError(event);
    return event;
  }
}
