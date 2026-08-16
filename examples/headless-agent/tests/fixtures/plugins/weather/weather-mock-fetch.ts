import type { Context } from '@deepseek-ai/cordis'
import type { WebFetchProvider } from '@deepseek-ai/dsh-web'

/** Keyless fetch provider: one canned Open-Meteo-shaped answer for the weather fixture. */
const provider: WebFetchProvider = {
  id: 'weather-mock-fetch',
  available: () => true,
  async fetch(request) {
    return {
      url: request.url,
      statusCode: 200,
      body: {
        kind: 'text',
        content: JSON.stringify({ current: { temperature_2m: 21.5, weather_code: 1 } }),
      },
      truncated: false,
    }
  },
}

export const name = 'weather-mock-fetch'
export const inject = ['web']

/** Register the keyless `weather-mock-fetch` provider. */
export function apply(ctx: Context): void {
  ctx.web.registerFetchProvider(provider)
}
