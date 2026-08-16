# @deepseek-ai/dsh-weather

English | [中文](README.zh.md)

A model-facing weather tool: `weather(latitude?, longitude?)` returns the current Celsius temperature and numeric weather code for one coordinate pair, fetched through the [web capability seam](../../web/web/README.md) from a configurable forecast API. The default endpoint is the keyless Open-Meteo API.

## Tools

- `weather(latitude?, longitude?)` fetches current conditions. Omitted coordinates fall back to the configured `defaultLocation`; when neither exists the call fails with `WEATHER_LOCATION_REQUIRED`. Out-of-range coordinates fail with `WEATHER_INVALID_COORDINATES`; a non-2xx API answer with `WEATHER_API_STATUS`; a body that is not the expected JSON record with `WEATHER_BAD_RESPONSE`.

## Config

```yaml
- id: weather
  name: '@deepseek-ai/dsh-weather'
  config:
    apiBaseUrl: https://api.open-meteo.com/v1/forecast
    defaultLocation:
      latitude: 31.2
      longitude: 121.5
```

Both keys are optional. The composition must also mount the web seam (`@deepseek-ai/dsh-web`) and a fetch provider, e.g. `@deepseek-ai/dsh-web-fetch-http`.

## Model Experience

### Tool schemas and results

#### What the model sees

The generated [`weather` schema](../../../docs/tool-catalog.md#deepseek-aidsh-weather). A successful result is one short text block with the temperature, coordinates, and weather code; the canonical value carries the same fields structured.

#### Token effect

Fixed schema cost plus one short result per call.

#### KV Cache effect

Schema is prefix-stable while this tool view is unchanged. Calls and results append after the reusable request prefix without invalidating earlier entries.

## Known Limitations and Deferred Work

- **No per-city input** — the tool takes coordinates, not place names; geocoding belongs to the caller or a future sibling tool.
- **Weather-code semantics stay numeric** — mapping codes to human labels is deferred until a consumer needs it.
- **Provider selection follows the seam** — endpoint availability, redirects, and size limits are the web provider's policy, not this package's.
