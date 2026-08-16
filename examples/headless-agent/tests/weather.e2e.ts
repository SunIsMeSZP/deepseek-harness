import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { LOADER_SMOKE_TEST_TIMEOUT_MS, runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

const binScript = fileURLToPath(new URL('./fixtures/headless-driver.ts', import.meta.url))
const configPath = fileURLToPath(new URL('./fixtures/plugins/weather/cordis.yml', import.meta.url))
const tsconfigPath = fileURLToPath(new URL('../../../tsconfig.json', import.meta.url))

describe('weather plugin keyless smoke', () => {
  it('boots the real Loader tree and completes one weather tool round trip', async () => {
    const { stdout, stderr } = await runLoaderSmoke({
      label: 'weather',
      tempDirPrefix: 'weather-smoke-',
      binScript,
      libBinScript: binScript,
      configPath,
      binArgs: [configPath, 'prove the weather tool'],
      tsconfigPath,
    })
    const lines = stdout.trimEnd().split('\n').map(line => JSON.parse(line) as Record<string, unknown>)
    const events = lines.slice(0, -1).map(line => line['event'] as SessionEvent)
    const result = lines.at(-1)
    expect(stderr).toBe('')
    expect(events.some(event => event.type === 'tool/call' && event.data.name === 'weather')).toBe(true)
    const toolResult = events.find(event => event.type === 'tool/result')
    expect(JSON.stringify(toolResult)).toContain('21.5')
    expect(result).toMatchObject({ type: 'result' })
    expect(String(result?.['output'])).toContain('Weather tool round trip complete')
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)
})
