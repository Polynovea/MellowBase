// The one key rule for model api keys and field keys, shared by validateCanonicalSchema and the schema
// engine. No imports, so browser code that validates schemas can load it.
export const KEY_PATTERN = /^[a-z][a-z0-9_]*$/;
