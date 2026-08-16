/**
 * Model-facing `weather` tool: current conditions for one coordinate pair,
 * fetched through the web capability seam from a configurable forecast API.
 * @module @deepseek-ai/dsh-weather
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { GenericCallView } from '@deepseek-ai/dsh-tools'
// Loads the web seam's Context augmentation so `ctx.web` is typed.
import type {} from '@deepseek-ai/dsh-web'

export const name = 'plugin-weather'
export const inject = ['tools', 'web']

/** Plugin configuration. Invalid values fail plugin load. */
export interface Config {
  /** Forecast API base URL. Default: the keyless Open-Meteo endpoint. */
  apiBaseUrl?: string
  /** Fallback coordinates applied when a call omits both. */
  defaultLocation?: { latitude: number; longitude: number }
}

/** Schemastery validation for {@link Config}. */
export const Config: z<Config> = z.object({
  apiBaseUrl: z.string().default('https://api.open-meteo.com/v1/forecast'),
  defaultLocation: z.object({
    latitude: z.number().min(-90).max(90),
    longitude: z.number().min(-180).max(180),
  }),
})

const WEATHER_DESCRIPTION =
  'Return the current weather at one coordinate pair: the Celsius temperature and the '
  + 'numeric weather code. Coordinates are decimal degrees. Use it when the task needs '
  + 'present conditions for a specific place.'

/** Output value a weather call resolves to. */
export interface WeatherValue {
  latitude: number
  longitude: number
  temperatureCelsius: number
  weatherCode: number
  text: string
}

/** One resolved coordinate pair, validated before any fetch. */
export interface Coordinates {
  latitude: number
  longitude: number
}

/**
 * Validate one coordinate pair against geographic bounds.
 * @param latitude - decimal degrees, inclusive of the poles.
 * @param longitude - decimal degrees, inclusive of the antimeridian.
 * @returns the accepted pair.
 * @throws {@link HarnessError} WEATHER_INVALID_COORDINATES outside the bounds.
 */
export function validateCoordinates(latitude: number, longitude: number): Coordinates {
  if (!Number.isFinite(latitude) || Math.abs(latitude) > 90
    || !Number.isFinite(longitude) || Math.abs(longitude) > 180) {
    throw new HarnessError(
      `weather: latitude must be within [-90, 90] and longitude within [-180, 180]; got (${latitude}, ${longitude})`,
      'WEATHER_INVALID_COORDINATES',
    )
  }
  return { latitude, longitude }
}

/**
 * Resolve the coordinates a call runs against: explicit arguments first, then
 * the configured fallback.
 * @param latitude - per-call latitude, when supplied.
 * @param longitude - per-call longitude, when supplied.
 * @param defaultLocation - configured fallback pair.
 * @returns the pair to fetch.
 * @throws {@link HarnessError} WEATHER_LOCATION_REQUIRED when neither source exists.
 */
export function resolveLocation(
  latitude: number | undefined,
  longitude: number | undefined,
  defaultLocation: { latitude: number; longitude: number } | undefined,
): Coordinates {
  if (latitude !== undefined && longitude !== undefined) {
    return validateCoordinates(latitude, longitude)
  }
  // Schemastery fills an omitted nested-object config with `{}`; only a
  // fallback with finite numbers counts as present.
  if (defaultLocation !== undefined
    && Number.isFinite(defaultLocation.latitude)
    && Number.isFinite(defaultLocation.longitude)) {
    return validateCoordinates(defaultLocation.latitude, defaultLocation.longitude)
  }
  throw new HarnessError(
    'weather: supply latitude and longitude, or configure defaultLocation for this composition',
    'WEATHER_LOCATION_REQUIRED',
  )
}

/** One Open-Meteo-shaped current-conditions record, parsed from the response body. */
interface CurrentConditions {
  temperature_2m: number
  weather_code: number
}

/**
 * Parse and validate the API's current-conditions record.
 * @param body - decoded response text.
 * @returns the current conditions.
 * @throws {@link HarnessError} WEATHER_BAD_RESPONSE when the body is not the expected record.
 */
export function parseCurrentConditions(body: string): CurrentConditions {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    throw new HarnessError('weather: the forecast API answered with a body that is not JSON', 'WEATHER_BAD_RESPONSE')
  }
  const current = (parsed as { current?: unknown }).current
  const record = typeof current === 'object' && current !== null
    ? current as { temperature_2m?: unknown; weather_code?: unknown }
    : undefined
  if (record === undefined
    || typeof record.temperature_2m !== 'number'
    || typeof record.weather_code !== 'number') {
    throw new HarnessError(
      'weather: the forecast API answered without a current temperature_2m/weather_code record',
      'WEATHER_BAD_RESPONSE',
    )
  }
  return { temperature_2m: record.temperature_2m, weather_code: record.weather_code }
}

/**
 * Fetch and decode current conditions through the web seam.
 * @param ctx - plugin context carrying the web capability.
 * @param apiBaseUrl - configured forecast endpoint.
 * @param location - validated coordinate pair.
 * @param signal - cancellation forwarded to the fetch.
 * @returns the current conditions.
 */
export async function fetchWeather(
  ctx: Context,
  apiBaseUrl: string,
  location: Coordinates,
  signal: AbortSignal | undefined,
): Promise<CurrentConditions> {
  const url = `${apiBaseUrl}?latitude=${location.latitude}&longitude=${location.longitude}`
    + '&current=temperature_2m,weather_code'
  const result = await ctx.web.fetch({ url }, signal)
  if (result.statusCode < 200 || result.statusCode >= 300) {
    throw new HarnessError(
      `weather: the forecast API answered HTTP ${result.statusCode} for the current conditions`,
      'WEATHER_API_STATUS',
    )
  }
  if (result.body.kind !== 'text') {
    throw new HarnessError(
      'weather: the forecast API answered with an unexpected content kind; expected a JSON text body',
      'WEATHER_BAD_RESPONSE',
    )
  }
  return parseCurrentConditions(result.body.content)
}

/**
 * Render one weather reading.
 * @param location - the fetched coordinates.
 * @param conditions - the decoded current conditions.
 * @returns the resolved reading.
 */
export function renderWeather(location: Coordinates, conditions: CurrentConditions): WeatherValue {
  return {
    latitude: location.latitude,
    longitude: location.longitude,
    temperatureCelsius: conditions.temperature_2m,
    weatherCode: conditions.weather_code,
    text: `${conditions.temperature_2m}°C at (${location.latitude}, ${location.longitude}), `
      + `weather code ${conditions.weather_code}`,
  }
}

/** Generic, args-only pending presentation for the weather call. */
function present(title: string, rawInput?: unknown): GenericCallView {
  return { card: 'generic', title, kind: 'read', ...rawInput === undefined ? {} : { rawInput } }
}

/**
 * Register the `weather` tool for the lifetime of `ctx`.
 * @param ctx - plugin context carrying the tool registry and web seam.
 * @param config - plugin configuration.
 */
export function apply(ctx: Context, config: Config): void {
  const apiBaseUrl = config.apiBaseUrl ?? 'https://api.open-meteo.com/v1/forecast'
  ctx.tools.register(defineTool({
    name: 'weather',
    description: WEATHER_DESCRIPTION,
    parameters: {
      latitude: {
        type: 'number',
        description: 'Decimal degrees latitude. Omit to use the configured defaultLocation.',
      },
      longitude: {
        type: 'number',
        description: 'Decimal degrees longitude. Omit to use the configured defaultLocation.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          latitude: { type: 'number', required: true },
          longitude: { type: 'number', required: true },
          temperatureCelsius: { type: 'number', required: true },
          weatherCode: { type: 'number', required: true },
          text: { type: 'string', required: true },
        },
      },
      render: (_args: unknown, value: WeatherValue) => [{ type: 'text' as const, text: value.text }],
    },
    async execute(args, exec) {
      const location = resolveLocation(args.latitude, args.longitude, config.defaultLocation)
      const conditions = await fetchWeather(ctx, apiBaseUrl, location, exec.signal)
      return renderWeather(location, conditions)
    },
    presentCall: args => present(
      'Read weather',
      args.latitude !== undefined && args.longitude !== undefined
        ? `${args.latitude}, ${args.longitude}`
        : undefined,
    ),
  }))
}
