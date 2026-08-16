/**
 * Discovery and validation for the `dsh.plugin` package.json manifest — the
 * single declaration that feeds the verify gate, the registry assembler, and
 * the plugin scaffold. Validation is shape-level by design: cordis boot stays
 * the authoritative resolver for `consumes` service names.
 *
 * @module scripts/plugin-manifests
 */

import { existsSync, globSync, readFileSync } from 'node:fs'
import { dirname, join, sep } from 'node:path'

/** Valid `dsh.plugin.type` values. */
export const PLUGIN_TYPES = ['host', 'client', 'dual-half', 'mcp'] as const

/** Valid `dsh.plugin.mount` values. */
const PLUGIN_MOUNTS = ['static', 'dynamic'] as const

/** The `dsh.plugin` object read from a package.json, before validation. */
interface RawPluginManifest {
  type?: unknown
  mount?: unknown
  name?: unknown
  provides?: unknown
  consumes?: unknown
  configSchema?: unknown
  trust?: unknown
  mcp?: unknown
}

/** A discovered plugin package: its directory and both manifest halves. */
export interface PluginRecord {
  /** Repository-relative package directory with `/` separators. */
  dir: string
  /** The unvalidated `dsh.plugin` value. */
  manifest: RawPluginManifest
  /** The containing package.json value. */
  packageJson: { name?: string; dsh?: { client?: { platform?: string } } }
}

/** Every workspace package name mapped to its directory, for collision checks. */
export type PackageNameMap = Map<string, string>

/** One manifest problem, addressed by repository-relative path. */
export interface ManifestViolation {
  path: string
  message: string
}

/** Registry ids and service-shaped names: lowercase letters, digits, hyphens. */
export const PLUGIN_NAME_PATTERN = /^[a-z][a-z0-9-]*$/

/** Capability ids additionally allow `tool:` prefixes. */
const PROVIDES_PATTERN = /^[a-z][a-z0-9:-]*$/

/** Plugins live in this group; every group member must declare a manifest. */
export const PLUGIN_GROUP = 'packages/plugins'

function manifestPath(dir: string): string {
  return `${dir}/package.json`
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(entry => typeof entry === 'string' && entry.length > 0)
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return typeof value === 'object'
    && value !== null
    && !Array.isArray(value)
    && Object.values(value).every(entry => typeof entry === 'string')
}

/** Every `dsh.plugin` field is optional-unknown, so any plain object qualifies; field validation is the verifier's job. */
function isPluginManifestObject(value: unknown): value is RawPluginManifest {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Discover every plugin package under `packages/*&#47;*` that declares
 * `dsh.plugin`, plus plugins-group members that fail to. JSON problems and
 * missing declarations surface as discovery violations rather than records.
 * @param root - repository root the package globs resolve against.
 * @returns discovered records, discovery-level violations, and the full
 *   package-name map for collision checks.
 */
export function discoverPluginRecords(root: string): {
  records: PluginRecord[]
  violations: ManifestViolation[]
  packageNames: PackageNameMap
} {
  const records: PluginRecord[] = []
  const violations: ManifestViolation[] = []
  const packageNames: PackageNameMap = new Map()
  for (const pkgPath of [
    ...globSync('packages/*/*/package.json', { cwd: root }),
    ...globSync('apps/*/package.json', { cwd: root }),
  ].sort()) {
    const normalized = pkgPath.split(sep).join('/')
    const dir = dirname(normalized)
    let packageJson: PluginRecord['packageJson']
    try {
      packageJson = JSON.parse(readFileSync(join(root, pkgPath), 'utf8')) as PluginRecord['packageJson']
    } catch (error) {
      violations.push({
        path: normalized,
        message: `package.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      })
      continue
    }
    if (packageJson.name !== undefined && !packageNames.has(packageJson.name)) {
      packageNames.set(packageJson.name, dir)
    }
    const manifest = (packageJson as { dsh?: { plugin?: unknown } }).dsh?.plugin
    if (manifest === undefined) {
      if (dir.startsWith(`${PLUGIN_GROUP}/`)) {
        violations.push({
          path: manifestPath(dir),
          message: 'a package in the plugins group must declare dsh.plugin',
        })
      }
      continue
    }
    if (!isPluginManifestObject(manifest)) {
      violations.push({
        path: manifestPath(dir),
        message: 'dsh.plugin must be an object',
      })
      continue
    }
    records.push({ dir, manifest, packageJson })
  }
  return { records, violations, packageNames }
}

function verifyRecord(record: PluginRecord, root: string, violations: ManifestViolation[]): void {
  const { dir, manifest, packageJson } = record
  const at = (message: string): void => {
    violations.push({ path: manifestPath(dir), message })
  }

  if (typeof manifest.name !== 'string' || !PLUGIN_NAME_PATTERN.test(manifest.name)) {
    at('dsh.plugin.name must be a lowercase kebab-case string (letters, digits, hyphens)')
  } else if (packageJson.name !== `@deepseek-ai/dsh-${manifest.name}`) {
    at(`package.json name must be "@deepseek-ai/dsh-${manifest.name}" to match dsh.plugin.name`)
  }

  if (typeof manifest.type !== 'string' || !(PLUGIN_TYPES as readonly string[]).includes(manifest.type)) {
    at(`dsh.plugin.type must be one of: ${PLUGIN_TYPES.join(', ')}`)
    return
  }
  const type = manifest.type
  const mount = manifest.mount === undefined ? 'static' : manifest.mount
  if (typeof mount !== 'string' || !(PLUGIN_MOUNTS as readonly string[]).includes(mount)) {
    at(`dsh.plugin.mount must be one of: ${PLUGIN_MOUNTS.join(', ')}`)
    return
  }

  if (manifest.provides !== undefined
    && (!isStringArray(manifest.provides)
      || manifest.provides.some(value => !PROVIDES_PATTERN.test(value)))) {
    at('dsh.plugin.provides must be an array of lowercase capability ids (e.g. "tool:weather")')
  }
  if (manifest.consumes !== undefined
    && (!isStringArray(manifest.consumes)
      || manifest.consumes.some(value => !PLUGIN_NAME_PATTERN.test(value)))) {
    at('dsh.plugin.consumes must be an array of lowercase service names')
  }
  if (manifest.configSchema !== undefined) {
    if (typeof manifest.configSchema !== 'string' || manifest.configSchema.length === 0) {
      at('dsh.plugin.configSchema must be a non-empty path')
    } else if (!existsSync(join(root, dir, manifest.configSchema))) {
      at(`dsh.plugin.configSchema file does not exist: ${manifest.configSchema}`)
    }
  }

  if (manifest.trust !== undefined) {
    if (mount !== 'dynamic') {
      at('dsh.plugin.trust is only meaningful for mount: "dynamic"')
    } else if (typeof manifest.trust !== 'object' || manifest.trust === null || Array.isArray(manifest.trust)) {
      at('dsh.plugin.trust must be an object')
    } else {
      const approval = (manifest.trust as { approval?: unknown }).approval
      if (approval !== undefined && (typeof approval !== 'string' || approval.length === 0)) {
        at('dsh.plugin.trust.approval must be a non-empty string')
      }
    }
  }

  if (type === 'mcp') {
    const mcp = manifest.mcp
    if (typeof mcp !== 'object' || mcp === null || Array.isArray(mcp)) {
      at('dsh.plugin.mcp must be an object with a command array')
    } else {
      const block = mcp as { command?: unknown; env?: unknown }
      if (!isStringArray(block.command) || block.command.length === 0) {
        at('dsh.plugin.mcp.command must be a non-empty array of non-empty strings')
      }
      if (block.env !== undefined && !isStringRecord(block.env)) {
        at('dsh.plugin.mcp.env must be an object of string values')
      }
    }
  } else if (manifest.mcp !== undefined) {
    at('dsh.plugin.mcp is only valid on type "mcp" plugins')
  }

  if (type === 'client' || type === 'dual-half') {
    if (packageJson.dsh?.client?.platform !== 'web') {
      at('client/dual-half plugins must declare dsh.client with platform "web"')
    }
  }

  if (type !== 'mcp' && !existsSync(join(root, dir, 'src/index.ts'))) {
    violations.push({
      path: `${dir}/src/index.ts`,
      message: `type "${type}" requires a host half at src/index.ts`,
    })
  }
  if ((type === 'client' || type === 'dual-half') && !existsSync(join(root, dir, 'src/client.ts'))) {
    violations.push({
      path: `${dir}/src/client.ts`,
      message: `type "${type}" requires a browser half at src/client.ts`,
    })
  }
}

/**
 * Validate every discovered manifest. Name uniqueness is checked across the
 * full record set, and the derived npm name against every workspace package;
 * the rest of the rules are per record.
 * @param records - discovered plugin records.
 * @param root - repository root for source-file existence checks.
 * @param packageNames - every workspace package name mapped to its directory.
 * @returns one violation per broken rule, empty when every manifest conforms.
 */
export function verifyPluginRecords(
  records: readonly PluginRecord[],
  root: string,
  packageNames: ReadonlyMap<string, string>,
): ManifestViolation[] {
  const violations: ManifestViolation[] = []
  const seen = new Map<string, string>()
  const pluginDirs = new Set(records.map(record => record.dir))
  for (const record of records) {
    verifyRecord(record, root, violations)
    if (typeof record.manifest.name === 'string') {
      const prior = seen.get(record.manifest.name)
      if (prior !== undefined) {
        violations.push({
          path: manifestPath(record.dir),
          message: `dsh.plugin.name "${record.manifest.name}" duplicates the plugin at ${prior}`,
        })
      } else {
        seen.set(record.manifest.name, record.dir)
      }
      if (PLUGIN_NAME_PATTERN.test(record.manifest.name)) {
        const owner = packageNames.get(`@deepseek-ai/dsh-${record.manifest.name}`)
        // Duplicate plugin names already report above; the collision rule
        // guards the derived npm name against non-plugin packages only.
        if (owner !== undefined && owner !== record.dir && !pluginDirs.has(owner)) {
          violations.push({
            path: manifestPath(record.dir),
            message: `package name "@deepseek-ai/dsh-${record.manifest.name}" is already taken by ${owner}`,
          })
        }
      }
    }
  }
  return violations
}

/** One violation per line, addressed by repository-relative path. */
export function formatManifestViolations(violations: readonly ManifestViolation[]): string {
  return violations.map(violation => `  ${violation.path}: ${violation.message}`).join('\n')
}
