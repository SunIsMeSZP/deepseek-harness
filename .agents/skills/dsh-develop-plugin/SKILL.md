---
name: dsh-develop-plugin
description: Use when the user asks to develop, extend, or promote a DeepSeek Harness plugin through conversation. Covers the five-phase flow (spec → dynamic sandbox validation → branch staticization → gates → push/publish), the design-spec template, the function-plugin form, the test traps, the six-step integration checklist, and the gate quick reference. Load before any plugin development work; do not re-explore these conventions per session.
---

# DSH Develop Plugin

Develop DSH plugins through conversation, reusing the verified flow from the plugin engineering layer (`packages/plugins/`, manifest gate, scaffold, registry). Everything here was proven on the `clock` vertical slice.

## Five-phase flow

1. **Spec** — fill the design-spec template with the user, get approval.
2. **Dynamic validation** — when the session has `cordis_*` tools, validate in the sandbox before writing any package.
3. **Staticize** — new worktree + branch `feat/plugin-<name>` off master; `plugin:scaffold`; port the validated halves (promote extracts them).
4. **Gates** — three test tiers, six integration steps, full gate battery. All green before commit.
5. **Push/publish** — commit (conventional message), push; publish is a separate, user-approved step.

## Design-spec template

Fill all eight fields with the user before coding:

```
目标 → 能力(provides/consumes) → 配置 schema → 工具 schema
→ UI 面(slots/卡片) → 信任面(static/dynamic/mcp) → 测试计划
→ 集成点(cordis.yml 片段) → 拒绝文案(teaching text)
```

- `consumes` must resolve to real service names (check the cordis API catalog or `cordis_inspect`).
- Ask about side effects (disk/network/external API) to pick the trust surface.
- Confirm refusal wording with the user in conversation — DSH requires teaching text on every refusal.

## Function-plugin form (packages/AGENTS.md contract)

```ts
export const name = 'plugin-<name>'      // cordis name, loader diagnostics
export const inject = ['tools']          // declared service injections
export interface Config { ... }
export const Config = z.object({ ... })  // schemastery; loader fills defaults
export function apply(ctx: Context, config: Config): void { ... }
```

No default export. Registers go through `ctx.effect()` / service registries. Every package also owns `src/invariant.ts` (empty installer with a `No runtime invariant:` reason is fine) and a bilingual README with `## Model Experience` + `## Known Limitations and Deferred Work`.

## Manifest (`dsh.plugin` in package.json)

`type: host|client|dual-half|mcp`, `mount: static|dynamic` (default static), `name` (kebab-case, unique), `provides` (e.g. `tool:weather`), `consumes` (service names), optional `configSchema`, `trust` (dynamic only), `mcp` block (mcp only). Package name derives to `@deepseek-ai/dsh-<name>`; collisions with any workspace package fail the gate. Scaffold: `pnpm run plugin:scaffold <name> --type <type>`.

## Dynamic validation (sandbox first)

When `cordis_*` tools are present: `cordis_inspect` the real contracts, then `cordis_define` (host + client halves), the user approves `cordis_run`, iterate with `cordis_undefine` + redefine. Keep the define call in the session log — it is the promote input (`rawInput` carries both halves). Facts: definitions are process memory only, each run needs human approval, and `cordis_define` broadcasts nothing. Playground: `pnpm run demo:cordis` (needs key). When the session has no cordis tools, ask the user whether to skip dynamic validation (record the skip in the spec) — the unit + keyless e2e tiers then carry the verification weight.

## Promote (dynamic → static)

`pnpm exec tsx scripts/promote-plugin.ts <session-jsonl> <pluginId> --package <name> --type host|dual-half`

Extracts the define call's halves into `dynamic-source/host.js` / `client.js`, scaffolds the package, and generates a TODO-marked function-plugin skeleton. The port from the raw halves is agent work: translate to the function form, add the Config schema, refusals, invariant, README. Red lines: promote never publishes, never edits shipped cordis.yml, never deletes the dynamic definition; static = assembly-tree trust, so it must pass every gate and the user's merge decision.

## Test tiers (clock is the reference)

1. Unit + coverage: registration/disposal round trip, execute through `ctx.tools.execute`, `presentCall`, `output.render`. `pnpm vitest run packages/plugins/<name>/tests --coverage` must hit 100/100/100/100 per file.
2. Keyless Loader e2e: fixture trio under `examples/<agent>/tests/fixtures/<group>/<name>/` (cordis.yml + scripted mock LLM emitting the tool call + package-local e2e). Run: `pnpm vitest run --config vitest.e2e.config.ts examples/<agent>/tests/<name>.e2e.ts`.

Traps (all bitten, all fixed): the first wrapped plugin mount in a package test has pending-fork semantics — mount a core service (e.g. `SystemPrompt`) first; every `**/*cordis*.yml` is scanned by `verify-cordis-config` — fragments/aggregate must be Loader entry arrays; a new tool must be added to `TOOL_PACKAGES` AND the exact-name assertion in `packages/core/tools/tests/gen-tool-catalog.spec.ts`; loaders fill Config defaults, so the `?? default` fallback path needs a direct `apply(ctx, {})` call to cover.

## Six integration steps (once per plugin, at integration time)

1. `packages/plugins/registry.json` + `pnpm run plugin:assemble`
2. `tsconfig.base.json` paths (package + `/invariant`) + `tsconfig.host.json` project reference
3. `TOOL_PACKAGES` entry in `scripts/gen-tool-catalog.ts` + `pnpm run gen-tool-catalog`
4. `pnpm run gen-module-graph`
5. New packages into `examples/package.json`
6. `pnpm install`

## Gate battery

`plugin:verify`, `plugin:assemble:check`, `verify-tool-catalog`, `verify-module-graph`, `verify-cordis-config`, `pnpm exec tsc -b tsconfig.host.json`, oxlint on changed files, `knip`, `verify-translation-pairing --write <new bilingual docs>`. Pre-push runs the incremental typecheck; CI owns the rest — but run the battery locally before claiming green.
