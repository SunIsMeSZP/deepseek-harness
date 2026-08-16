/**
 * Model-facing `clock` tool: the current date and time in an IANA time zone,
 * with a per-composition fallback zone.
 * @module @deepseek-ai/dsh-clock
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { GenericCallView } from '@deepseek-ai/dsh-tools'

export const name = 'plugin-clock'
export const inject = ['tools']

/** Plugin configuration. Invalid values fail plugin load. */
export interface Config {
  /** IANA time zone applied when a call omits one. Default 'UTC'. */
  timeZone?: string
}

/** Schemastery validation for {@link Config}. */
export const Config: z<Config> = z.object({
  timeZone: z.string().default('UTC'),
})

const CLOCK_DESCRIPTION =
  'Return the current date and time. The result carries the resolved IANA time zone, '
  + 'the ISO-8601 instant, the zone-local rendering, and Unix milliseconds. Use it when '
  + 'wall-clock facts matter to the task: deadlines, timestamps, or elapsed durations.'

/** Output value a clock call resolves to. */
export interface ClockValue {
  timeZone: string
  unixMs: number
  text: string
}

/**
 * Render the CLOCK_INVALID_ZONE teaching message for one zone failure.
 * @param timeZone - the rejected zone candidate.
 * @param error - the Intl rejection, an Error in practice but not required.
 * @returns the message carried by the resulting {@link HarnessError}.
 */
export function zoneErrorMessage(timeZone: string, error: unknown): string {
  return `clock: invalid IANA timeZone ${JSON.stringify(timeZone)}: `
    + (error instanceof Error ? error.message : String(error))
}

/**
 * Resolve one IANA zone to its canonical name.
 * @param timeZone - IANA zone candidate.
 * @returns the canonical zone name Intl reports.
 * @throws {@link HarnessError} CLOCK_INVALID_ZONE when Intl rejects the zone.
 */
export function resolveZone(timeZone: string): string {
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone }).resolvedOptions().timeZone
  } catch (error) {
    throw new HarnessError(zoneErrorMessage(timeZone, error), 'CLOCK_INVALID_ZONE')
  }
}

/**
 * Render one clock reading.
 * @param now - Unix milliseconds to render.
 * @param timeZone - canonical IANA zone.
 * @param format - 'iso' renders the instant plus zone-local text; 'unix' renders milliseconds only.
 * @returns the resolved reading.
 */
export function renderClock(now: number, timeZone: string, format: 'iso' | 'unix'): ClockValue {
  const date = new Date(now)
  if (format === 'unix') {
    return { timeZone, unixMs: now, text: String(now) }
  }
  const local = new Intl.DateTimeFormat('en-US', {
    timeZone,
    dateStyle: 'full',
    timeStyle: 'long',
  }).format(date)
  return { timeZone, unixMs: now, text: `${date.toISOString()} ${timeZone} (${local})` }
}

/** Generic, args-only pending presentation for the clock call. */
function present(title: string, rawInput?: unknown): GenericCallView {
  return { card: 'generic', title, kind: 'read', ...rawInput === undefined ? {} : { rawInput } }
}

/**
 * Register the `clock` tool for the lifetime of `ctx`.
 * @param ctx - plugin context carrying the tool registry.
 * @param config - plugin configuration; its fallback zone is resolved at load.
 */
export function apply(ctx: Context, config: Config): void {
  const fallbackZone = resolveZone(config.timeZone ?? 'UTC')
  ctx.tools.register(defineTool({
    name: 'clock',
    description: CLOCK_DESCRIPTION,
    parameters: {
      timeZone: {
        type: 'string',
        description: 'IANA time zone override for this call. Omit to use the configured zone.',
      },
      format: {
        type: 'string',
        enum: ['iso', 'unix'],
        description: "'iso' renders the ISO-8601 instant and zone-local text; 'unix' renders Unix milliseconds.",
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          timeZone: { type: 'string', required: true },
          unixMs: { type: 'number', required: true },
          text: { type: 'string', required: true },
        },
      },
      render: (_args: unknown, value: ClockValue) => [{ type: 'text' as const, text: value.text }],
    },
    execute(args) {
      const zone = args.timeZone === undefined ? fallbackZone : resolveZone(args.timeZone)
      const format = args.format === undefined ? 'iso' : args.format
      return Promise.resolve(renderClock(Date.now(), zone, format))
    },
    presentCall: args => present('Read clock', args.timeZone),
  }))
}
