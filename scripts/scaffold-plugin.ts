/**
 * Scaffold a gate-shaped plugin package under `packages/plugins/<name>`.
 * The generated skeleton keeps the function-plugin form (`name` / `inject` /
 * `Config` / `apply`, no default export), declares the `dsh.plugin` manifest,
 * and carries a cordis.yml fragment plus bilingual README. Registering the
 * package in the aggregates and catalogs is a documented follow-up step, not
 * part of scaffolding.
 *
 * Usage: `tsx scripts/scaffold-plugin.ts <name> [--type host|client|dual-half|mcp]`
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { PLUGIN_NAME_PATTERN, PLUGIN_TYPES } from './plugin-manifests.ts'

/** Valid `dsh.plugin.type` values, mirrored for the CLI. */
export type PluginType = (typeof PLUGIN_TYPES)[number]

const root = resolve(import.meta.dirname, '..')

function write(pluginDir: string, rel: string, content: string, written: string[]): void {
  const path = join(pluginDir, rel)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
  written.push(rel)
}

function renderPackageJson(name: string, type: PluginType): object {
  const hasSource = type !== 'mcp'
  const hasClient = type === 'client' || type === 'dual-half'
  return {
    name: `@deepseek-ai/dsh-${name}`,
    description: `${name} — scaffold-generated DSH plugin; describe what it provides`,
    version: '0.1.0-rc.5',
    publishConfig: { access: 'public' },
    repository: {
      type: 'git',
      url: 'git+https://github.com/SunIsMeSZP/deepseek-harness.git',
      directory: `packages/plugins/${name}`,
    },
    type: 'module',
    ...(hasSource
      ? {
        main: 'lib/index.js',
        types: 'lib/types/index.d.ts',
        exports: {
          '.': { types: './lib/types/index.d.ts', default: './lib/index.js' },
          ...(hasClient
            ? { './client': { types: './lib/types/client.d.ts', default: './lib/client.js' } }
            : {}),
          './package.json': './package.json',
        },
        files: [
          'lib/index.js',
          ...(hasClient ? ['lib/client.js'] : []),
          'lib/types/**/*.d.ts',
        ],
      }
      : {}),
    license: 'MIT',
    ...(hasSource
      ? {
        dependencies: { '@deepseek-ai/schemastery': 'workspace:^' },
        ...(hasClient ? { scripts: { bundle: 'tsdown', watch: 'tsdown --watch' } } : {}),
        peerDependencies: { '@deepseek-ai/cordis': 'workspace:^' },
        devDependencies: { '@deepseek-ai/cordis': 'workspace:^' },
      }
      : {}),
    dsh: {
      ...(hasClient
        ? { client: { inject: ['@deepseek-ai/dsh-client-runtime'], platform: 'web' } }
        : {}),
      plugin: {
        type,
        mount: 'static',
        name,
        provides: [],
        consumes: [],
        ...(type === 'mcp'
          ? { mcp: { command: ['TODO: replace with the MCP server launch command'], env: {} } }
          : {}),
      },
    },
  }
}

function renderTsconfig(): string {
  return `${JSON.stringify({
    extends: '../../../tsconfig.base.json',
    compilerOptions: { rootDir: 'src', outDir: 'lib/types' },
    include: ['src'],
    references: [
      { path: '../../../vendor/cordis' },
      { path: '../../runtime-diagnostics/invariants' },
    ],
  }, null, 2)}\n`
}

function renderHostHalf(name: string): string {
  return `/**
 * Scaffold-generated host half. Replace the probe with the plugin's real
 * services, tools, and lifecycle effects; keep the function-plugin form.
 *
 * @module @deepseek-ai/dsh-${name}
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'plugin-${name}'

/** Declared cordis service injections. The probe needs none. */
export const inject: string[] = []

/** Plugin configuration. Invalid values fail plugin load. */
export interface Config {}

/** Schemastery validation for {@link Config}. */
export const Config = z.object({})

/**
 * Register the plugin's contributions for the lifetime of \`ctx\`.
 * @param ctx - plugin context; contributions are disposed with it.
 * @param _config - validated plugin configuration.
 */
export function apply(ctx: Context, _config: Config): void {
  ctx.provide(name, Object.freeze({ scaffolded: true }))
}
`
}

function renderClientHalf(name: string): string {
  return `/**
 * Scaffold-generated browser half evaluated by the client runner. Replace
 * this default export with the real client-side plugin object.
 *
 * @module @deepseek-ai/dsh-${name}/client
 */

export default {}
`
}

function renderSpec(name: string, type: PluginType): string {
  const hasClient = type === 'client' || type === 'dual-half'
  const probe = type === 'mcp'
    ? ''
    : `  it('loads and provides the scaffolded probe', async () => {
    const ctx = new Context()
    await ctx.plugin(plugin)
    let observed: unknown
    await ctx.plugin({
      name: 'probe',
      inject: [plugin.name],
      apply: (probeCtx: Context) => {
        observed = (probeCtx as unknown as Record<string, unknown>)[plugin.name]
      },
    })
    expect(observed).toEqual({ scaffolded: true })
  })
`
  const client = hasClient
    ? `  it('exports the scaffolded browser half', () => {
    expect(client).toEqual({})
  })
`
    : ''
  return `import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import * as plugin from '../src/index.ts'
${hasClient ? "import client from '../src/client.ts'\n" : ''}
describe('@deepseek-ai/dsh-${name}', () => {
${probe}${client}})
`
}

function renderFragment(name: string): string {
  return `# Fragment for @deepseek-ai/dsh-${name}.
# The generated packages/plugins/aggregate.cordis.yml includes this file once
# the plugin is listed in packages/plugins/registry.json. To mount it
# directly, add the entry below (plus config) to the app cordis.yml.
plugins:
  - name: '@deepseek-ai/dsh-${name}'
    config: {}
`
}

function renderReadme(name: string, type: PluginType): string {
  return `# @deepseek-ai/dsh-${name}

English | [中文](README.zh.md)

Scaffold-generated ${type} plugin. Describe here what the plugin provides, its
model-facing tools and their schemas, its configuration keys, and how to
activate it: publish to npm, then either list it in
packages/plugins/registry.json (the generated aggregate includes its
cordis.yml fragment) or add the fragment's entry directly to the app
cordis.yml.

## Model Experience

TODO(${name}): document prompt, tool-schema, and result effects for the model
once the real capability replaces the scaffold probe.

## Known Limitations and Deferred Work

- Scaffold probe, not a real capability: replace src/ and this section.
- Not registered in the tsconfig aggregates or the tool/config catalogs yet;
  aggregate registration and catalog regeneration are integration steps that
  run when this package enters the registry.
`
}

function renderReadmeZh(name: string, type: PluginType): string {
  return `# @deepseek-ai/dsh-${name}

[English](README.md) | 中文

脚手架生成的 ${type} 插件。在此描述该插件提供的能力、面向模型的工具及其
schema、配置键，以及激活方式：发布到 npm 后，将其列入
packages/plugins/registry.json（生成的聚合文件会 include 它的 cordis.yml
片段），或直接把片段中的条目加入应用的 cordis.yml。

## 模型体验

TODO(${name})：真实能力替换脚手架探针后，记录对模型的 prompt、工具 schema
与结果的影响。

## 已知限制与后续工作

- 当前为脚手架探针而非真实能力：请替换 src/ 与本节。
- 尚未注册进 tsconfig 聚合与工具/配置目录；聚合注册与目录再生成是进入
  注册表时执行的集成步骤。
`
}

/**
 * Generate one plugin package under `packages/plugins/<name>`.
 * @param repoRoot - repository root the package is created under.
 * @param name - kebab-case registry id, also the package directory name.
 * @param type - plugin type selecting the generated halves.
 * @returns package-relative paths written, in creation order.
 * @throws when the name or type is invalid, or the target directory exists.
 */
export function scaffoldPlugin(repoRoot: string, name: string, type: PluginType): string[] {
  if (!PLUGIN_NAME_PATTERN.test(name)) {
    throw new Error(`invalid plugin name "${name}": use lowercase letters, digits, and hyphens`)
  }
  if (!(PLUGIN_TYPES as readonly string[]).includes(type)) {
    throw new Error(`invalid plugin type "${type}": use one of ${PLUGIN_TYPES.join(', ')}`)
  }
  const pluginDir = join(repoRoot, 'packages', 'plugins', name)
  if (existsSync(pluginDir)) {
    throw new Error(`refusing to overwrite existing package at packages/plugins/${name}`)
  }
  const written: string[] = []
  write(pluginDir, 'package.json', `${JSON.stringify(renderPackageJson(name, type), null, 2)}\n`, written)
  if (type !== 'mcp') {
    write(pluginDir, 'tsconfig.json', renderTsconfig(), written)
    write(pluginDir, 'src/index.ts', renderHostHalf(name), written)
    write(pluginDir, 'tests/index.spec.ts', renderSpec(name, type), written)
  }
  if (type === 'client' || type === 'dual-half') {
    write(pluginDir, 'src/client.ts', renderClientHalf(name), written)
  }
  write(pluginDir, 'cordis.yml', renderFragment(name), written)
  write(pluginDir, 'README.md', renderReadme(name, type), written)
  write(pluginDir, 'README.zh.md', renderReadmeZh(name, type), written)
  return written
}

const invokedPath = process.argv[1]
const isMain = invokedPath !== undefined
  && import.meta.url === pathToFileURL(resolve(invokedPath)).href
if (isMain) {
  const argv = process.argv.slice(2)
  const typeIndex = argv.indexOf('--type')
  const type = typeIndex >= 0 && argv[typeIndex + 1] !== undefined ? argv[typeIndex + 1] : 'host'
  const name = typeIndex >= 0
    ? argv.find((_arg, index) => index !== typeIndex && index !== typeIndex + 1)
    : argv[0]
  if (name === undefined) {
    console.error('scaffold-plugin: usage: tsx scripts/scaffold-plugin.ts <name> [--type host|client|dual-half|mcp]')
    process.exit(1)
  }
  try {
    const written = scaffoldPlugin(root, name, type as PluginType)
    for (const rel of written) console.log(`  packages/plugins/${name}/${rel}`)
    console.log(`scaffold-plugin: created packages/plugins/${name} (${type}).`)
  } catch (error) {
    console.error(`scaffold-plugin: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  }
}
