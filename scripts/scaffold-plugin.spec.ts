import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { discoverPluginRecords, verifyPluginRecords } from './plugin-manifests.ts'
import { scaffoldPlugin } from './scaffold-plugin.ts'

const tempDirs: string[] = []

function fixtureRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-plugin-scaffold-'))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function verifyScaffolded(root: string): string[] {
  const { records, violations, packageNames } = discoverPluginRecords(root)
  return [...violations, ...verifyPluginRecords(records, root, packageNames)]
    .map(violation => `${violation.path}: ${violation.message}`)
}

describe('scaffoldPlugin', () => {
  it('generates a host plugin that passes the manifest gate', () => {
    const root = fixtureRoot()
    const written = scaffoldPlugin(root, 'demo-clock', 'host')
    expect(written).toContain('package.json')
    expect(written).toContain('src/index.ts')
    expect(written).toContain('tests/index.spec.ts')
    expect(written).toContain('cordis.yml')
    expect(written).toContain('README.md')
    expect(written).toContain('README.zh.md')
    expect(verifyScaffolded(root)).toEqual([])
    const source = readFileSync(join(root, 'packages/plugins/demo-clock/src/index.ts'), 'utf8')
    expect(source).toContain("export const name = 'plugin-demo-clock'")
    expect(source).toContain('export const Config = z.object({})')
    expect(source).toContain('ctx.provide(name, Object.freeze({ scaffolded: true }))')
    expect(source).not.toContain('export default')
  })

  it('generates a dual-half plugin with a browser half and web client declaration', () => {
    const root = fixtureRoot()
    scaffoldPlugin(root, 'demo-panel', 'dual-half')
    expect(existsSync(join(root, 'packages/plugins/demo-panel/src/client.ts'))).toBe(true)
    const packageJson = JSON.parse(
      readFileSync(join(root, 'packages/plugins/demo-panel/package.json'), 'utf8'),
    ) as { dsh: { client: { platform: string }; plugin: { type: string } } }
    expect(packageJson.dsh.client.platform).toBe('web')
    expect(packageJson.dsh.plugin.type).toBe('dual-half')
    expect(verifyScaffolded(root)).toEqual([])
  })

  it('generates an mcp plugin with a launch command and no source files', () => {
    const root = fixtureRoot()
    scaffoldPlugin(root, 'demo-mcp', 'mcp')
    expect(existsSync(join(root, 'packages/plugins/demo-mcp/src'))).toBe(false)
    expect(existsSync(join(root, 'packages/plugins/demo-mcp/tsconfig.json'))).toBe(false)
    const packageJson = JSON.parse(
      readFileSync(join(root, 'packages/plugins/demo-mcp/package.json'), 'utf8'),
    ) as { dsh: { plugin: { mcp: { command: string[] } } } }
    expect(packageJson.dsh.plugin.mcp.command.length).toBeGreaterThan(0)
    expect(verifyScaffolded(root)).toEqual([])
  })

  it('writes a cordis fragment and a README with the required sections', () => {
    const root = fixtureRoot()
    scaffoldPlugin(root, 'demo-notes', 'host')
    const fragment = readFileSync(join(root, 'packages/plugins/demo-notes/cordis.yml'), 'utf8')
    expect(fragment).toContain("name: '@deepseek-ai/dsh-demo-notes'")
    const readme = readFileSync(join(root, 'packages/plugins/demo-notes/README.md'), 'utf8')
    expect(readme).toContain('## Model Experience')
    expect(readme).toContain('## Known Limitations and Deferred Work')
  })

  it('refuses to overwrite an existing package', () => {
    const root = fixtureRoot()
    scaffoldPlugin(root, 'demo-once', 'host')
    expect(() => scaffoldPlugin(root, 'demo-once', 'host')).toThrow(/refusing to overwrite/)
  })

  it('rejects invalid names and unknown types', () => {
    const root = fixtureRoot()
    expect(() => scaffoldPlugin(root, 'Bad_Name', 'host')).toThrow(/invalid plugin name/)
    expect(() => scaffoldPlugin(root, 'demo', 'service' as never)).toThrow(/invalid plugin type/)
  })
})
