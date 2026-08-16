# Agent Note: Plugin engineering layer — manifest gate, scaffold, and registry

Status: proposed

English | [中文](2026-08-17-plugin-engineering-layer.zh.md)

## Problem

Parallel plugin development in one checkout concentrates conflicts in shared committed files — the lockfile, the generated catalogs and their hand-maintained registries, and the aggregate tsconfigs — and in whole-repo gates (per-file coverage, catalog freshness, typecheck). Dynamic packages (`cordis_define`) live in process memory only (see the [self-referential cordis toolset](../../implemented/feature/2026-07-08-self-referential-cordis-toolset.md)) and have no promote path to a published static package. Static packages publish via npm and activate through cordis.yml, but the repository offers them no engineering surface: no manifest declaration, no scaffold, no registry of released plugins.

## Proposal

Add a thin plugin engineering layer that keeps the runtime native and pins only what gates can see.

### The dsh.plugin manifest

Every plugin package declares `dsh.plugin` in package.json: `type` (host|client|dual-half|mcp), `mount` (static|dynamic, default static), `name` (registry id), `provides`/`consumes` capability lists, an optional `configSchema` path, an optional `trust` block (dynamic mounts only), and an `mcp` launch block (mcp type only). `scripts/verify-plugin-manifests.ts` validates the declaration fields and runs in `hygiene` (`pnpm run plugin:verify`). Validation is field-level by design: cordis boot remains the authoritative service resolver for `consumes`; the manifest gate rejects only declarations that are invalid under every composition.

### The plugins group and registry

Plugins live at `packages/plugins/<name>` (the depth-two workspace layout is unchanged). `packages/plugins/registry.json` is the committed closed inventory; `scripts/assemble-registry.ts` renders `packages/plugins/aggregate.cordis.yml` — an include chain over each registered plugin's own cordis.yml fragment. Default invocation writes; `--check` (`pnpm run plugin:assemble:check`, part of `hygiene`) verifies membership in both directions and the aggregate's freshness.

### The scaffold

`pnpm run plugin:scaffold <name> --type host|client|dual-half|mcp` generates a gate-shaped skeleton: the function-plugin host half (`name`/`inject`/`Config`/`apply`, no default export), a browser half for client/dual-half, a cordis.yml fragment, a bilingual README with the Model Experience and Known Limitations sections, tests, and the manifest. The generated package passes `plugin:verify` immediately.

### Deliberate v1 boundaries

- `consumes` entries are checked for name form only; resolution stays with cordis boot.
- Catalog derivation from `provides` follows the direction of [discover package inventories](2026-06-20-discover-package-inventory.md); promote from dynamic definitions, per-plugin CI fan-out, and aggregate registration of generated packages are follow-up increments, not this proposal.

## Alternatives considered

**A standalone plugin-harness repository.** Rejected for now: the gates, catalogs, and build faces live in this repository, and a second home would duplicate them and drift. Reconsider when plugins get out-of-tree consumers (see Risks).

**No manifest — extend the existing hand-maintained registries (TOOL_PACKAGES and friends).** Rejected: every consumer (registry, UI, CI, catalogs) would keep its own list; one declaration feeds all of them.

**Promote and catalog derivation in this increment.** Rejected: both need the manifest and registry formats to stabilize first; shipping them together would freeze three young formats at once.

## Acceptance criteria

- `scripts/plugin-manifests.ts`, `scripts/verify-plugin-manifests.ts`, `scripts/scaffold-plugin.ts`, and `scripts/assemble-registry.ts` exist with spec tests covering the validation matrix, the scaffold round trip, and the registry checks in both directions.
- `packages/plugins/registry.json` and the generated `aggregate.cordis.yml` are committed and fresh; both plugin gates run in `hygiene` and pass on the current tree.
- A scaffolded plugin package passes `plugin:verify` and `plugin:assemble:check` once registered.
- No shipped composition or existing gate changes behavior.

## Risks

- The closed inventory can be friction for a plugin that exists before its registry entry; the both-direction check fails loud with the exact remediation, which is the accepted cost.
- Scaffolded packages are not gate-verified until registered in the aggregates; the README documents the registration steps, and a committed scaffold output is exercised by the scaffold spec's round trip only.
- Field-level `consumes` validation accepts a name cordis rejects at boot; the boot error is the loud failure point, acceptable until a catalog-derived resolver lands.
