import tsconfigPaths from 'vite-tsconfig-paths'
import { defineConfig } from 'vitest/config'
import { standardDecoratorPlugin, vitestExecArgv } from './vitest.shared.ts'

// Per-plugin coverage lane: scopes the per-file 100% gate to one plugin
// package, so a plugin PR proves its own coverage without re-running the
// whole repository suite. PLUGIN names the package directory.
const plugin = process.env.PLUGIN
if (plugin === undefined || !/^packages\/plugins\/[a-z][a-z0-9-]*$/.test(plugin)) {
  throw new Error('vitest.plugin.config.ts: PLUGIN must be a packages/plugins/<name> path')
}

export default defineConfig({
  plugins: [tsconfigPaths({ projects: ['./tsconfig.base.json'] }), standardDecoratorPlugin()],
  test: {
    execArgv: vitestExecArgv,
    setupFiles: ['./scripts/test-invariants.ts'],
    include: [`${plugin}/tests/**/*.spec.{ts,tsx}`],
    coverage: {
      provider: 'v8',
      include: [`${plugin}/src/**/*.{ts,tsx}`],
      exclude: ['**/types.ts'],
      thresholds: {
        perFile: true,
        statements: 100,
        branches: 100,
        functions: 100,
        lines: 100,
      },
    },
  },
})
