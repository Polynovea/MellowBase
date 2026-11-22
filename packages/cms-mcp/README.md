# Polynovea CMS MCP

`@polynovea/cms-mcp` is a stdio JSON-RPC MCP transport. Configure `POLYNOVEA_CMS_URL` and a scoped, agent-bound `POLYNOVEA_CMS_TOKEN`. The transport never receives a database connection, service-role key, filesystem access, or unbounded network authority.

It first records authorization/provenance through `/api/v1/agent-tools`, then calls the normal `/api/v1` endpoint for the CMS operation. High-risk tools therefore retain ordinary scopes, approvals, deterministic plans, simulations and evidence.

## Requirements

- Node.js 22 or later (`engines.node` is `>=22`). The transport is a single ESM script using Node's built-in `fetch`, `readline` and `crypto`; it has no npm dependencies and no build step.
- The package is `private` and is not published to npm. Run it from this repository: `node packages/cms-mcp/bin/polynovea-cms-mcp.mjs`.
- `POLYNOVEA_CMS_URL`: origin of a running Polynovea CMS instance. There is no default.
- `POLYNOVEA_CMS_TOKEN`: a Developer API token (`pnv_...`) bound to an active workspace agent identity, with `agent.read` plus the scope each tool needs. The process exits on start if either variable is missing.

See [docs/agents/MCP.md](../../docs/agents/MCP.md) for agent modes and approval rules.
