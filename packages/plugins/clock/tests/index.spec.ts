import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { CallId, HarnessError } from '@deepseek-ai/dsh-llm'
import * as clock from '@deepseek-ai/dsh-clock'

const BASE = Date.parse('2026-08-17T12:00:00.000Z')
const testToolSignal = new AbortController().signal

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(BASE)
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

async function mountClock(): Promise<Context> {
  const ctx = new Context()
  // The first wrapped mount carries the invariant host's pending-fork
  // semantics; mount SystemPrompt first so later services stay visible on ctx.
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(clock)
  return ctx
}

describe('@deepseek-ai/dsh-clock', () => {
  it('registers the clock tool and removes it on disposal', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    const fiber = await ctx.plugin(clock)
    expect(ctx.tools.get('clock')).toBeDefined()
    await fiber.dispose()
    expect(ctx.tools.get('clock')).toBeUndefined()
  })

  it('executes the tool with the configured zone and per-call overrides', async () => {
    const ctx = await mountClock()
    const fallback = await ctx.tools.execute({
      signal: testToolSignal,
      callId: CallId('fallback'),
      name: 'clock',
      arguments: {},
    })
    expect(fallback.isError).toBe(false)
    if (!fallback.isError) {
      expect(fallback.value).toMatchObject({ timeZone: 'UTC', unixMs: BASE })
    }
    const override = await ctx.tools.execute({
      signal: testToolSignal,
      callId: CallId('override'),
      name: 'clock',
      arguments: { timeZone: 'Asia/Shanghai', format: 'unix' },
    })
    expect(override.isError).toBe(false)
    if (!override.isError) {
      expect(override.value).toMatchObject({ timeZone: 'Asia/Shanghai', unixMs: BASE, text: String(BASE) })
    }
  })

  it('fails the call loud with CLOCK_INVALID_ZONE for an invalid per-call zone', async () => {
    const ctx = await mountClock()
    const invalid = await ctx.tools.execute({
      signal: testToolSignal,
      callId: CallId('invalid'),
      name: 'clock',
      arguments: { timeZone: 'Not/AZone' },
    })
    expect(invalid.isError).toBe(true)
    if (invalid.isError) {
      expect(invalid.error.info?.code).toBe('CLOCK_INVALID_ZONE')
      expect(invalid.error.message).toContain('invalid IANA timeZone')
    }
  })

  it('presents the generic read card and renders the canonical output', async () => {
    const ctx = await mountClock()
    const definition = ctx.tools.get('clock')
    if (definition === undefined) throw new Error('clock tool missing after mount')
    expect(definition.presentCall!({})).toMatchObject({ card: 'generic', title: 'Read clock', kind: 'read' })
    expect(definition.presentCall!({ timeZone: 'UTC' })).toMatchObject({ rawInput: 'UTC' })
    expect(definition.output.render(undefined, { timeZone: 'UTC', unixMs: BASE, text: 't' }))
      .toEqual([{ type: 'text', text: 't' }])
  })

  it('renders the iso reading with the instant, zone, and zone-local text', () => {
    expect(clock.renderClock(BASE, 'UTC', 'iso')).toEqual({
      timeZone: 'UTC',
      unixMs: BASE,
      text: '2026-08-17T12:00:00.000Z UTC (Monday, August 17, 2026 at 12:00:00 PM UTC)',
    })
  })

  it('renders the unix reading as bare milliseconds', () => {
    expect(clock.renderClock(BASE, 'UTC', 'unix')).toEqual({
      timeZone: 'UTC',
      unixMs: BASE,
      text: String(BASE),
    })
  })

  it('canonicalizes zone aliases and fails loud on invalid zones', () => {
    expect(clock.resolveZone('Asia/Shanghai')).toBe('Asia/Shanghai')
    expect(() => clock.resolveZone('Not/AZone')).toThrow(HarnessError)
  })

  it('renders non-Error zone failures into the teaching message', () => {
    expect(clock.zoneErrorMessage('UTC', 'not-an-error')).toContain('not-an-error')
    expect(clock.zoneErrorMessage('UTC', new Error('real-error'))).toContain('real-error')
  })

  it('falls back to UTC when the resolved config omits the zone', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    clock.apply(ctx, {})
    expect(ctx.tools.get('clock')).toBeDefined()
  })
})
