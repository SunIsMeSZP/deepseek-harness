/**
 * Promote one `cordis_define` dynamic package into a static plugin package.
 * Extracts the define call's host/client halves from a session log, scaffolds
 * the package, and preserves the raw halves under `dynamic-source/` for the
 * port. The port itself (dynamic object form → function-plugin form, Config
 * schema, refusals, invariant, README) is agent work; this script automates
 * the extraction and scaffolding only.
 *
 * Usage: `tsx scripts/promote-plugin.ts <session-jsonl> <plugin-id-or-name> [--package <name>] [--type host|dual-half]`
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { PLUGIN_NAME_PATTERN } from './plugin-manifests.ts'
import { scaffoldPlugin } from './scaffold-plugin.ts'

const root = resolve(import.meta.dirname, '..')

/** One extracted dynamic package definition. */
export interface DefineRecord {
  /** The define call's `name` argument. */
  name: string
  /** The submitted host-half source, when present. */
  host?: string
  /** The submitted browser-half source, when present. */
  client?: string
}

/** One tolerated line from the session log. */
interface SessionLine {
  type?: unknown
  data?: { name?: unknown; arguments?: unknown }
}

/**
 * Find every `cordis_define` tool call in one session log, newest last.
 * @param events - parsed JSONL lines of the session log.
 * @returns define calls whose `name` argument matched, plus the full call list
 *   for diagnostics when nothing matches.
 */
export function collectDefineCalls(lines: readonly SessionLine[]): DefineRecord[] {
  const calls: DefineRecord[] = []
  for (const line of [...lines].reverse()) {
    if (line.type !== 'tool/call') continue
    const data = line.data
    if (data?.name !== 'cordis_define') continue
    const args = data.arguments as { name?: unknown; code?: unknown } | undefined
    if (args === undefined || typeof args.name !== 'string') continue
    const code = typeof args.code === 'object' && args.code !== null
      ? args.code as { host?: unknown; client?: unknown }
      : undefined
    const record: DefineRecord = { name: args.name }
    if (typeof code?.host === 'string' && code.host.length > 0) record.host = code.host
    if (typeof code?.client === 'string' && code.client.length > 0) record.client = code.client
    calls.push(record)
  }
  return calls
}

/**
 * Parse one session JSONL file into tolerated line objects.
 * @param jsonlPath - path to the session log.
 * @returns every line that parses to an object.
 * @throws when the file is missing or a line is not valid JSON.
 */
export function readSessionLines(jsonlPath: string): SessionLine[] {
  const raw = readFileSync(jsonlPath, 'utf8')
  const lines: SessionLine[] = []
  for (const [index, line] of raw.trimEnd().split('\n').entries()) {
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch (error) {
      throw new Error(
        `session line ${index + 1} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      lines.push(parsed)
    }
  }
  return lines
}

/**
 * Promote one dynamic definition into `packages/plugins/<name>`.
 * @param repoRoot - repository root the package is created under.
 * @param record - the extracted define call.
 * @param packageName - kebab-case registry id for the static package.
 * @param type - host or dual-half, matching the extracted halves.
 * @returns paths written, package-relative to the new package directory.
 * @throws when the package name is invalid or no host half was extracted.
 */
export function promoteRecord(
  repoRoot: string,
  record: DefineRecord,
  packageName: string,
  type: 'host' | 'dual-half',
): string[] {
  if (!PLUGIN_NAME_PATTERN.test(packageName)) {
    throw new Error(`invalid plugin name "${packageName}": use lowercase letters, digits, and hyphens`)
  }
  if (record.host === undefined) {
    throw new Error(`define call "${record.name}" submitted no host half; nothing to promote`)
  }
  if (type === 'dual-half' && record.client === undefined) {
    throw new Error(`define call "${record.name}" has no browser half; use --type host or redefine with a client half`)
  }
  const written = scaffoldPlugin(repoRoot, packageName, type)
  const pluginDir = join(repoRoot, 'packages', 'plugins', packageName)
  mkdirSync(join(pluginDir, 'dynamic-source'), { recursive: true })
  writeFileSync(join(pluginDir, 'dynamic-source/host.js'), `${record.host.trimEnd()}\n`)
  written.push('dynamic-source/host.js')
  if (record.client !== undefined) {
    writeFileSync(join(pluginDir, 'dynamic-source/client.js'), `${record.client.trimEnd()}\n`)
    written.push('dynamic-source/client.js')
  }
  return written
}

const invokedPath = process.argv[1]
const isMain = invokedPath !== undefined
  && import.meta.url === pathToFileURL(resolve(invokedPath)).href
if (isMain) {
  const argv = process.argv.slice(2)
  const typeIndex = argv.indexOf('--type')
  const type = (typeIndex >= 0 && argv[typeIndex + 1] !== undefined
    ? argv[typeIndex + 1]
    : 'host') as 'host' | 'dual-half'
  const packageIndex = argv.indexOf('--package')
  const positional = argv.filter((_arg, index) =>
    index !== typeIndex && index !== typeIndex + 1
    && index !== packageIndex && index !== packageIndex + 1)
  const jsonlPath = positional[0]
  const pluginTarget = positional[1]
  const packageName = packageIndex >= 0 && argv[packageIndex + 1] !== undefined
    ? argv[packageIndex + 1]
    : undefined
  if (jsonlPath === undefined || pluginTarget === undefined) {
    console.error('promote-plugin: usage: tsx scripts/promote-plugin.ts <session-jsonl> <plugin-id-or-name> [--package <name>] [--type host|dual-half]')
    process.exit(1)
  }
  try {
    const calls = collectDefineCalls(readSessionLines(jsonlPath))
    const record = calls.find(call => call.name === pluginTarget)
    if (record === undefined) {
      const known = calls.map(call => call.name).join(', ')
      throw new Error(
        `no cordis_define call named "${pluginTarget}" in ${jsonlPath}`
        + (known === '' ? ' (the log holds no cordis_define calls at all)' : `; known defines: ${known}`),
      )
    }
    const finalName = packageName ?? pluginTarget
    const written = promoteRecord(root, record, finalName, type)
    for (const rel of written) console.log(`  packages/plugins/${finalName}/${rel}`)
    console.log(`promote-plugin: promoted "${pluginTarget}" into packages/plugins/${finalName} (${type}). Port dynamic-source/ into the function-plugin form next.`)
  } catch (error) {
    console.error(`promote-plugin: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  }
}
