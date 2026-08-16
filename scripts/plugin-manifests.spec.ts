import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { discoverPluginRecords, verifyPluginRecords } from './plugin-manifests.ts'

const tempDirs: string[] = []

function fixtureRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-plugin-manifest-'))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function writePkg(root: string, name: string, content: object | string): string {
  const dir = join(root, 'packages', 'plugins', name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), typeof content === 'string' ? content : JSON.stringify(content))
  return dir
}

function writeFile(root: string, rel: string, content = ''): void {
  const path = join(root, rel)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
}

function verify(root: string): string[] {
  const { records, violations } = discoverPluginRecords(root)
  return [...violations, ...verifyPluginRecords(records, root)]
    .map(violation => `${violation.path}: ${violation.message}`)
}

function hostPackage(name: string): object {
  return {
    name: `@deepseek-ai/dsh-plugin-${name}`,
    dsh: { plugin: { type: 'host', mount: 'static', name } },
  }
}

describe('plugin manifest discovery', () => {
  it('accepts a conforming host plugin', () => {
    const root = fixtureRoot()
    writePkg(root, 'demo', hostPackage('demo'))
    writeFile(root, 'packages/plugins/demo/src/index.ts')
    expect(verify(root)).toEqual([])
  })

  it('flags a plugins-group package without a manifest', () => {
    const root = fixtureRoot()
    writePkg(root, 'demo', { name: '@deepseek-ai/dsh-plugin-demo' })
    expect(verify(root)).toEqual([
      'packages/plugins/demo/package.json: a package in the plugins group must declare dsh.plugin',
    ])
  })

  it('flags an unparsable package.json', () => {
    const root = fixtureRoot()
    writePkg(root, 'demo', '{ nope')
    const violations = verify(root)
    expect(violations).toHaveLength(1)
    expect(violations[0]).toContain('package.json is not valid JSON')
  })
})

describe('plugin manifest validation', () => {
  it('requires the host half for non-mcp types', () => {
    const root = fixtureRoot()
    writePkg(root, 'demo', hostPackage('demo'))
    expect(verify(root)).toEqual([
      'packages/plugins/demo/src/index.ts: type "host" requires a host half at src/index.ts',
    ])
  })

  it('requires dsh.client with platform web on client plugins', () => {
    const root = fixtureRoot()
    writePkg(root, 'demo', {
      name: '@deepseek-ai/dsh-plugin-demo',
      dsh: { plugin: { type: 'client', mount: 'static', name: 'demo' } },
    })
    writeFile(root, 'packages/plugins/demo/src/index.ts')
    writeFile(root, 'packages/plugins/demo/src/client.ts')
    expect(verify(root)).toEqual([
      'packages/plugins/demo/package.json: client/dual-half plugins must declare dsh.client with platform "web"',
    ])
  })

  it('requires an mcp block with a non-empty command on mcp plugins', () => {
    const root = fixtureRoot()
    writePkg(root, 'demo', {
      name: '@deepseek-ai/dsh-plugin-demo',
      dsh: { plugin: { type: 'mcp', mount: 'static', name: 'demo', mcp: { command: [] } } },
    })
    expect(verify(root)).toEqual([
      'packages/plugins/demo/package.json: dsh.plugin.mcp.command must be a non-empty array of non-empty strings',
    ])
    const root2 = fixtureRoot()
    writePkg(root2, 'demo', {
      name: '@deepseek-ai/dsh-plugin-demo',
      dsh: { plugin: { type: 'mcp', mount: 'static', name: 'demo' } },
    })
    expect(verify(root2)).toEqual([
      'packages/plugins/demo/package.json: dsh.plugin.mcp must be an object with a command array',
    ])
  })

  it('rejects trust on static mounts', () => {
    const root = fixtureRoot()
    writePkg(root, 'demo', {
      name: '@deepseek-ai/dsh-plugin-demo',
      dsh: { plugin: { type: 'host', mount: 'static', name: 'demo', trust: { approval: 'required' } } },
    })
    writeFile(root, 'packages/plugins/demo/src/index.ts')
    expect(verify(root)).toEqual([
      'packages/plugins/demo/package.json: dsh.plugin.trust is only meaningful for mount: "dynamic"',
    ])
  })

  it('rejects duplicate plugin names across packages', () => {
    const root = fixtureRoot()
    writePkg(root, 'one', hostPackage('demo'))
    writeFile(root, 'packages/plugins/one/src/index.ts')
    writePkg(root, 'two', hostPackage('demo'))
    writeFile(root, 'packages/plugins/two/src/index.ts')
    expect(verify(root)).toEqual([
      'packages/plugins/two/package.json: dsh.plugin.name "demo" duplicates the plugin at packages/plugins/one',
    ])
  })

  it('enforces the package name derived from dsh.plugin.name', () => {
    const root = fixtureRoot()
    writePkg(root, 'demo', {
      name: '@deepseek-ai/dsh-other',
      dsh: { plugin: { type: 'host', mount: 'static', name: 'demo' } },
    })
    writeFile(root, 'packages/plugins/demo/src/index.ts')
    expect(verify(root)).toEqual([
      'packages/plugins/demo/package.json: package.json name must be "@deepseek-ai/dsh-plugin-demo" to match dsh.plugin.name',
    ])
  })

  it('rejects invalid names, broken provides, and missing configSchema files', () => {
    const root = fixtureRoot()
    writePkg(root, 'demo', {
      name: '@deepseek-ai/dsh-plugin-Bad_Name',
      dsh: {
        plugin: {
          type: 'host',
          mount: 'static',
          name: 'Bad_Name',
          provides: ['Tool With Spaces'],
          configSchema: './src/missing-schema.ts',
        },
      },
    })
    writeFile(root, 'packages/plugins/demo/src/index.ts')
    expect(verify(root)).toEqual([
      'packages/plugins/demo/package.json: dsh.plugin.name must be a lowercase kebab-case string (letters, digits, hyphens)',
      'packages/plugins/demo/package.json: dsh.plugin.provides must be an array of lowercase capability ids (e.g. "tool:weather")',
      'packages/plugins/demo/package.json: dsh.plugin.configSchema file does not exist: ./src/missing-schema.ts',
    ])
  })

  it('accepts a conforming dual-half plugin', () => {
    const root = fixtureRoot()
    writePkg(root, 'demo', {
      name: '@deepseek-ai/dsh-plugin-demo',
      dsh: {
        client: { inject: ['@deepseek-ai/dsh-client-runtime'], platform: 'web' },
        plugin: { type: 'dual-half', mount: 'dynamic', name: 'demo', provides: ['tool:demo'] },
      },
    })
    writeFile(root, 'packages/plugins/demo/src/index.ts')
    writeFile(root, 'packages/plugins/demo/src/client.ts')
    expect(verify(root)).toEqual([])
  })

  it('ignores packages outside the plugins group that declare no manifest', () => {
    const root = fixtureRoot()
    const dir = join(root, 'packages', 'core', 'session')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-session' }))
    expect(verify(root)).toEqual([])
  })
})
