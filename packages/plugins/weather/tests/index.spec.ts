import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import WebRuntime from '@deepseek-ai/dsh-web'
import { CallId, HarnessError } from '@deepseek-ai/dsh-llm'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import type { WebFetchResult } from '@deepseek-ai/dsh-web'
import * as weather from '@deepseek-ai/dsh-weather'

const testToolSignal = new AbortController().signal

function cannedFetch(overrides: Partial<{ statusCode: number; body: string; kind: 'text' | 'html' }> = {}): () => Promise<WebFetchResult> {
  return async () => ({
    url: 'https://example.test/forecast',
    statusCode: overrides.statusCode ?? 200,
    body: {
      kind: overrides.kind ?? 'text',
      content: overrides.body ?? JSON.stringify({ current: { temperature_2m: 21.5, weather_code: 1 } }),
    },
    truncated: false,
  })
}

async function mountWeather(config: Parameters<typeof weather.apply>[1] = {}): Promise<Context> {
  const ctx = new Context()
  // The first wrapped mount carries the invariant host's pending-fork
  // semantics; mount SystemPrompt first so later services stay visible on ctx.
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(WebRuntime, { fetchProvider: 'test-fetch' })
  ctx.web.registerFetchProvider({ id: 'test-fetch', available: () => true, fetch: cannedFetch() })
  await ctx.plugin(weather, config)
  return ctx
}

async function executeWeather(ctx: Context, arguments_: object): Promise<ToolExecutionResult> {
  return ctx.tools.execute({
    signal: testToolSignal,
    callId: CallId('weather-call'),
    name: 'weather',
    arguments: arguments_,
  })
}

describe('@deepseek-ai/dsh-weather', () => {
  it('registers the weather tool and removes it on disposal', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(WebRuntime, { fetchProvider: 'test-fetch' })
    ctx.web.registerFetchProvider({ id: 'test-fetch', available: () => true, fetch: cannedFetch() })
    const fiber = await ctx.plugin(weather)
    expect(ctx.tools.get('weather')).toBeDefined()
    await fiber.dispose()
    expect(ctx.tools.get('weather')).toBeUndefined()
  })

  it('executes a call with explicit coordinates and renders the reading', async () => {
    const ctx = await mountWeather()
    const result = await executeWeather(ctx, { latitude: 31.2, longitude: 121.5 })
    expect(result.isError).toBe(false)
    expect(result.value).toMatchObject({
      latitude: 31.2,
      longitude: 121.5,
      temperatureCelsius: 21.5,
      weatherCode: 1,
    })
  })

  it('falls back to the configured defaultLocation', async () => {
    const ctx = await mountWeather({ defaultLocation: { latitude: 40, longitude: 116 } })
    const result = await executeWeather(ctx, {})
    expect(result.isError).toBe(false)
    expect(result.value).toMatchObject({ latitude: 40, longitude: 116 })
  })

  it('refuses with WEATHER_LOCATION_REQUIRED when neither source exists', async () => {
    const ctx = await mountWeather()
    const result = await executeWeather(ctx, {})
    expect(result.isError).toBe(true)
    expect(result.error?.info?.code).toBe('WEATHER_LOCATION_REQUIRED')
  })

  it('refuses with WEATHER_INVALID_COORDINATES for out-of-range coordinates', async () => {
    const ctx = await mountWeather()
    const result = await executeWeather(ctx, { latitude: 91, longitude: 0 })
    expect(result.isError).toBe(true)
    expect(result.error?.info?.code).toBe('WEATHER_INVALID_COORDINATES')
  })

  it('refuses non-2xx answers with WEATHER_API_STATUS through the helper', async () => {
    const ctx = new Context()
    ctx.provide('web', {
      fetch: async () => ({ statusCode: 404, body: { kind: 'text', content: 'x' }, truncated: false, url: 'u' }),
    })
    const location = weather.validateCoordinates(1, 2)
    await expect(weather.fetchWeather(ctx, 'https://x.test', location, undefined))
      .rejects.toMatchObject({ code: 'WEATHER_API_STATUS' })
  })

  it('refuses an html body with WEATHER_BAD_RESPONSE through the helper', async () => {
    const ctx = new Context()
    ctx.provide('web', {
      fetch: async () => ({ statusCode: 200, body: { kind: 'html', content: '<html>' }, truncated: false, url: 'u' }),
    })
    const location = weather.validateCoordinates(1, 2)
    await expect(weather.fetchWeather(ctx, 'https://x.test', location, undefined))
      .rejects.toMatchObject({ code: 'WEATHER_BAD_RESPONSE' })
  })

  it('refuses malformed bodies with WEATHER_BAD_RESPONSE', () => {
    expect(() => weather.parseCurrentConditions('not json')).toThrow(/not JSON/)
    expect(() => weather.parseCurrentConditions(JSON.stringify({ current: 'warm' })))
      .toThrow(/without a current/)
    expect(() => weather.parseCurrentConditions(JSON.stringify({ current: { temperature_2m: 'warm' } })))
      .toThrow(/without a current/)
    expect(() => weather.parseCurrentConditions(JSON.stringify({ current: { temperature_2m: 21, weather_code: 'sunny' } })))
      .toThrow(/without a current/)
  })

  it('validates coordinate bounds', () => {
    expect(weather.validateCoordinates(-90, 180)).toEqual({ latitude: -90, longitude: 180 })
    expect(() => weather.validateCoordinates(90.1, 0)).toThrow(HarnessError)
    expect(() => weather.validateCoordinates(0, -181)).toThrow(HarnessError)
  })

  it('resolves coordinates from args or fallback, failing loud when both are missing', () => {
    expect(weather.resolveLocation(1, 2, undefined)).toEqual({ latitude: 1, longitude: 2 })
    expect(weather.resolveLocation(undefined, undefined, { latitude: 3, longitude: 4 }))
      .toEqual({ latitude: 3, longitude: 4 })
    expect(() => weather.resolveLocation(undefined, undefined, undefined)).toThrow(/supply latitude and longitude/)
    expect(() => weather.resolveLocation(undefined, undefined, {} as never)).toThrow(/supply latitude and longitude/)
    expect(() => weather.resolveLocation(undefined, undefined, { latitude: 1, longitude: Number.NaN }))
      .toThrow(/supply latitude and longitude/)
  })

  it('falls back to the default API base URL when the resolved config omits it', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(WebRuntime, { fetchProvider: 'test-fetch' })
    ctx.web.registerFetchProvider({ id: 'test-fetch', available: () => true, fetch: cannedFetch() })
    weather.apply(ctx, {})
    expect(ctx.tools.get('weather')).toBeDefined()
  })

  it('renders the reading text and the generic card', async () => {
    expect(weather.renderWeather({ latitude: 31.2, longitude: 121.5 }, { temperature_2m: 21.5, weather_code: 1 }))
      .toEqual({
        latitude: 31.2,
        longitude: 121.5,
        temperatureCelsius: 21.5,
        weatherCode: 1,
        text: '21.5°C at (31.2, 121.5), weather code 1',
      })
    const ctx = await mountWeather()
    const definition = ctx.tools.get('weather')
    if (definition === undefined) throw new Error('weather tool missing after mount')
    expect(definition.presentCall!({})).toMatchObject({ card: 'generic', title: 'Read weather', kind: 'read' })
    expect(definition.presentCall!({ latitude: 1, longitude: 2 })).toMatchObject({ rawInput: '1, 2' })
  })
})
