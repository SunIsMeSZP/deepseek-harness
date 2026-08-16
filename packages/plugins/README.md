# plugins/ — third-party-shaped plugin packages

English | [中文](README.zh.md)

The engineering home for plugins developed against the harness's own extension points: each package declares a `dsh.plugin` manifest (type, mount, provided/consumed capabilities, config schema) that the plugin tooling derives every other view from — the verify gate, the registry assembler, and the scaffold.

| Artifact | Role |
|---|---|
| [`registry.json`](registry.json) | Committed membership list; the closed inventory every plugin manifest must appear in |
| [`aggregate.cordis.yml`](aggregate.cordis.yml) | Generated include chain over each registered plugin's own `cordis.yml` fragment (`pnpm run plugin:assemble`; freshness-gated by `pnpm run plugin:assemble:check`) |
| `<name>/` | One plugin package, scaffolded by `pnpm run plugin:scaffold <name> --type host\|client\|dual-half\|mcp` |

## Packages

| Package | Role | Tool |
|---|---|---|
| [`clock/`](clock/README.md) | Model-facing wall-clock readings in an IANA zone | `clock` |
| [`weather/`](weather/README.md) | Model-facing current conditions through the web seam | `weather` |

Manifest shape is validated by `pnpm run plugin:verify` (part of `hygiene`); cordis boot remains the authoritative service resolver for `consumes`. Design home: [the plugin engineering layer Agent Note](../../.agents/notes/proposed/process/2026-08-17-plugin-engineering-layer.md).
