# @deepseek-ai/dsh-clock

English | [中文](README.zh.md)

A model-facing wall-clock tool: `clock` reads the current date and time in an IANA time zone. This package is the first member of the [plugins group](../README.md), scaffolded, registered, and gated through the [plugin engineering layer](../../../.agents/notes/proposed/process/2026-08-17-plugin-engineering-layer.md).

## Tools

- `clock(timeZone?, format?)` returns the current reading. `format: 'iso'` (default) renders the ISO-8601 instant plus zone-local text; `format: 'unix'` renders bare Unix milliseconds. The resolved zone and Unix milliseconds always travel in the canonical value.

Invalid zones fail the call loud with `CLOCK_INVALID_ZONE`. The composition-level fallback zone is resolved at plugin load, so a broken configured zone fails the composition instead of the first call.

## Config

```yaml
- id: clock
  name: '@deepseek-ai/dsh-clock'
  config:
    timeZone: UTC
```

`timeZone` is an optional IANA zone, default `UTC`, applied when a call omits one.

## Model Experience

### Tool schemas and results

#### What the model sees

The generated [`clock` schema](../../../docs/tool-catalog.md#deepseek-aidsh-clock). A successful result is one short text block carrying the zone, the ISO-8601 instant, and the zone-local rendering.

#### Token effect

Fixed schema cost plus one short result per call.

#### KV Cache effect

Schema is prefix-stable while this tool view is unchanged. Calls and results append after the reusable request prefix without invalidating earlier entries.

## Known Limitations and Deferred Work

- **No durable event stream** — readings are per-call values with no session events; the package's invariant companion registers an empty installer for that reason.
- **Zone database follows the runtime** — IANA zone availability is whatever the Node ICU provides; exotic zones fail at load or call time with `CLOCK_INVALID_ZONE`.
