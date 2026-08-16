/**
 * Gate: every `dsh.plugin` manifest in the repository is valid, and every
 * package in the plugins group declares one. Part of `hygiene`.
 */

import { resolve } from 'node:path'
import {
  discoverPluginRecords,
  formatManifestViolations,
  verifyPluginRecords,
} from './plugin-manifests.ts'

const root = resolve(import.meta.dirname, '..')
const { records, violations, packageNames } = discoverPluginRecords(root)
const all = [...violations, ...verifyPluginRecords(records, root, packageNames)]

if (all.length > 0) {
  console.error('verify-plugin-manifests: violations found:')
  console.error(formatManifestViolations(all))
  process.exit(1)
}

console.log(`verify-plugin-manifests: ${records.length} plugin manifest(s) conform.`)
