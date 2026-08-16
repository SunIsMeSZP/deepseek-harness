import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { discoverPluginRecords, verifyPluginRecords } from './plugin-manifests.ts'
import {
  collectDefineCalls,
  promoteRecord,
  readSessionLines,
} from './promote-plugin.ts'

const tempDirs: string[] = []

function fixtureRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-promote-'))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function jsonl(events: unknown[]): string {
  return `${events.map(event => JSON.stringify(event)).join('\n')}\n`
}

function defineCall(name: string, code: { host?: string; client?: string }): unknown {
  return {
    type: 'tool/call',
    seq: 3,
    time: Date.now(),
    data: { name: 'cordis_define', arguments: { name, purpose: 'test', code } },
  }
}

function writeSession(root: string, events: unknown[]): string {
  const path = join(root, 'session.jsonl')
  writeFileSync(path, jsonl(events))
  return path
}

describe('promotePlugin extraction', () => {
  it('collects cordis_define calls newest-first and keeps both halves', () => {
    const root = fixtureRoot()
    const path = writeSession(root, [
      { type: 'turn/start' },
      defineCall('first', { host: 'export const a = 1' }),
      defineCall('second', { host: 'export const b = 2', client: 'export default {}' }),
    ])
    const calls = collectDefineCalls(readSessionLines(path))
    expect(calls.map(call => call.name)).toEqual(['second', 'first'])
    expect(calls[0]?.host).toContain('export const b = 2')
    expect(calls[0]?.client).toContain('export default {}')
    expect(calls[1]?.client).toBeUndefined()
  })

  it('tolerates lines that are not tool calls', () => {
    const root = fixtureRoot()
    const path = writeSession(root, [
      { type: 'session' },
      { type: 'tool/result', data: { name: 'other' } },
      defineCall('only', { host: 'h' }),
    ])
    const calls = collectDefineCalls(readSessionLines(path))
    expect(calls).toHaveLength(1)
  })

  it('rejects a log whose line is not valid JSON, naming the line', () => {
    const root = fixtureRoot()
    const path = join(root, 'bad.jsonl')
    writeFileSync(path, '{"type": "turn/start"}\n{nope\n')
    expect(() => readSessionLines(path)).toThrow(/session line 2 is not valid JSON/)
  })
})

describe('promotePlugin promoteRecord', () => {
  it('scaffolds the package and preserves the raw halves under dynamic-source/', () => {
    const root = fixtureRoot()
    const written = promoteRecord(root, { name: 'demo-gizmo', host: 'const probe = 1' }, 'demo-gizmo', 'host')
    expect(written).toContain('dynamic-source/host.js')
    const raw = readFileSync(join(root, 'packages/plugins/demo-gizmo/dynamic-source/host.js'), 'utf8')
    expect(raw).toBe('const probe = 1\n')
    const { records, violations, packageNames } = discoverPluginRecords(root)
    expect([...violations, ...verifyPluginRecords(records, root, packageNames)]).toEqual([])
  })

  it('rejects a promote without a host half', () => {
    const root = fixtureRoot()
    expect(() => promoteRecord(root, { name: 'demo-x' }, 'demo-x', 'host'))
      .toThrow(/submitted no host half/)
  })

  it('rejects a dual-half promote without a client half', () => {
    const root = fixtureRoot()
    expect(() => promoteRecord(root, { name: 'demo-y', host: 'h' }, 'demo-y', 'dual-half'))
      .toThrow(/no browser half/)
  })

  it('rejects an invalid package name', () => {
    const root = fixtureRoot()
    expect(() => promoteRecord(root, { name: 'x', host: 'h' }, 'Bad_Name', 'host'))
      .toThrow(/invalid plugin name/)
  })
})
