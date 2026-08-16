/**
 * On-disk format helpers for the JSONL session-persistence backend: path
 * sanitization (a {@link SessionId} is an unvalidated branded string, so it
 * MUST be encoded before use in a path — no traversal, no collision), the
 * per-project/session directory layout, header-line (de)serialization, and the
 * truncation-repair offset computation.
 *
 * @module dsh-session-persistence-jsonl/format
 */

import { join } from 'node:path'
import { decodeStorageRecord, packChunkRuns, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader, SessionId, StorageRecord } from '@deepseek-ai/dsh-session'
import { SessionFormatUnsupportedError, sessionFormatVersionRefusal } from '@deepseek-ai/dsh-session-persistence'

/** Physical encoding selected for JSONL session artifacts. */
export type JsonlCompression = 'zstd' | 'none'

/**
 * Return the artifact suffix for one physical encoding.
 * @param compression - configured JSONL artifact encoding.
 * @returns `.jsonl.zstd` for Zstandard or `.jsonl` for plaintext.
 */
export function logSuffix(compression: JsonlCompression): '.jsonl.zstd' | '.jsonl' {
  return compression === 'zstd' ? '.jsonl.zstd' : '.jsonl'
}

/**
 * The first JSONL record of a session artifact: the immutable
 * {@link SessionHeader} tagged as a `session` record so a reader can tell it
 * apart from an event line.
 */
export interface HeaderLine {
  type: 'session'
  version: number
  id: SessionId
  createdAt: number
  cwd?: string
  parentSession?: SessionId
  seedLength?: number
  origin?: 'subagent'
  delegationDepth: number
  agentPreset?: string
}

/**
 * Build the header line object from a {@link SessionHeader}.
 * @param header - the immutable session metadata to serialize.
 * @returns the `type: 'session'`-tagged line object, absent optional fields omitted (never null).
 */
export function toHeaderLine(header: SessionHeader): HeaderLine {
  return {
    type: 'session',
    version: header.version,
    id: header.id,
    createdAt: header.createdAt,
    ...header.cwd !== undefined ? { cwd: header.cwd } : {},
    ...header.parentSession !== undefined ? { parentSession: header.parentSession } : {},
    ...header.seedLength !== undefined ? { seedLength: header.seedLength } : {},
    ...header.origin !== undefined ? { origin: header.origin } : {},
    delegationDepth: header.delegationDepth ?? 0,
    ...header.agentPreset !== undefined ? { agentPreset: header.agentPreset } : {},
  }
}

/**
 * Parse a header line back into a {@link SessionHeader}.
 * @param line - the shape-checked first line of a log (see the `isHeaderLine` guard).
 * @returns the header, absent optional fields omitted.
 */
export function fromHeaderLine(line: HeaderLine): SessionHeader {
  if (Object.hasOwn(line, 'sandboxMode') || Object.hasOwn(line, 'approvalPolicy')) {
    throw new Error('session header uses retired policy baseline fields')
  }
  return {
    version: line.version,
    id: line.id,
    createdAt: line.createdAt,
    ...line.cwd !== undefined ? { cwd: line.cwd } : {},
    ...line.parentSession !== undefined ? { parentSession: line.parentSession } : {},
    ...line.seedLength !== undefined ? { seedLength: line.seedLength } : {},
    ...line.origin !== undefined ? { origin: line.origin } : {},
    delegationDepth: line.delegationDepth,
    ...line.agentPreset !== undefined ? { agentPreset: line.agentPreset } : {},
  }
}

/** Type guard: a parsed first line is a well-formed session header. */
function isHeaderLine(value: unknown): value is HeaderLine {
  return (
    typeof value === 'object' && value !== null
    && (value as { type?: unknown }).type === 'session'
    && typeof (value as { version?: unknown }).version === 'number'
    && typeof (value as { id?: unknown }).id === 'string'
    && typeof (value as { createdAt?: unknown }).createdAt === 'number'
    && Number.isSafeInteger((value as { createdAt: number }).createdAt)
    && (value as { createdAt: number }).createdAt >= 0
    && !Object.is((value as { createdAt: number }).createdAt, -0)
    && typeof (value as { delegationDepth?: unknown }).delegationDepth === 'number'
    && Number.isSafeInteger((value as { delegationDepth: number }).delegationDepth)
    && (value as { delegationDepth: number }).delegationDepth >= 0
    && !Object.is((value as { delegationDepth: number }).delegationDepth, -0)
    && ((value as { origin?: unknown }).origin === undefined
      || (value as { origin?: unknown }).origin === 'subagent')
    && ((value as { agentPreset?: unknown }).agentPreset === undefined
      || typeof (value as { agentPreset?: unknown }).agentPreset === 'string')
  )
}

/**
 * Encode an arbitrary string as a single safe path segment, injectively over ALL JS (UTF-16)
 * strings — including lone surrogates. A {@link SessionId} is an unvalidated branded string,
 * so this neutralizes `../`, absolute paths, NUL, and separators before any filesystem use.
 * Safe code units remain literal; every other unit, including `~`, becomes
 * `~XXXX`. Operating on code units preserves lone surrogates, while special-
 * casing `.` and `..` prevents traversal by an otherwise safe whole segment.
 *
 * @param raw - the string to encode; must be non-empty (throws on `''`).
 * @returns the escaped single path segment, decodable back to `raw`.
 */
export function encodeSegment(raw: string): string {
  if (raw.length === 0) throw new Error('cannot encode an empty path segment')
  if (raw === '.') return '~002E'
  if (raw === '..') return '~002E~002E'
  let out = ''
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      out += ch
    } else {
      out += '~' + code.toString(16).toUpperCase().padStart(4, '0')
    }
  }
  return out
}

/**
 * Build the readable directory key for a project path.
 * Filesystem separators and drive separators become `-`; unsafe code units use
 * the same `~XXXX` escape as session ids. The key is bounded for filesystem
 * component limits. Separator replacement and truncation are intentionally
 * lossy, following the common human-navigable project-directory convention.
 * @param cwd - the session's project directory.
 * @returns a single filesystem-safe project directory name.
 */
export function projectKey(cwd: string): string {
  if (cwd.length === 0) throw new Error('cannot encode an empty project path')
  let readable = ''
  let separatorRun = false
  for (let i = 0; i < cwd.length; i++) {
    const code = cwd.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-'
      separatorRun = true
    } else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch
      separatorRun = false
    } else {
      readable += '~' + code.toString(16).toUpperCase().padStart(4, '0')
      separatorRun = false
    }
  }
  const slug = readable.replace(/^-+/, '') || 'root'
  return `--${slug.slice(0, 251)}--`
}

/**
 * The configured root's human-navigable project directory. A configured root
 * may be local or shared; this grouping does not prescribe its deployment.
 * @param root - the backend's session root directory.
 * @param cwd - the session's project directory; `undefined` selects `_no-cwd`.
 * @returns the project directory path under `root`.
 */
export function projectDir(root: string, cwd: string | undefined): string {
  if (cwd === undefined) return join(root, '_no-cwd')
  return join(root, projectKey(cwd))
}

/**
 * The directory owned by one session and available for future session-local
 * artifacts.
 * @param root - the backend's session root directory.
 * @param cwd - the session's project directory.
 * @param id - the session id, encoded to one safe path segment.
 * @returns the session directory beneath its project directory.
 */
export function sessionDir(root: string, cwd: string | undefined, id: SessionId): string {
  return join(projectDir(root, cwd), encodeSegment(id))
}

/**
 * The append-only event-log file path for a session.
 * @param root - the backend's session root directory.
 * @param cwd - the session's project directory (`undefined` → `_no-cwd`).
 * @param id - the session id, path-encoded via {@link encodeSegment} before filesystem use.
 * @param compression - physical artifact encoding and filename suffix.
 * @returns the session's configured JSONL artifact path.
 */
export function logPath(
  root: string,
  cwd: string | undefined,
  id: SessionId,
  compression: JsonlCompression,
): string {
  return join(sessionDir(root, cwd, id), `session${logSuffix(compression)}`)
}

/**
 * Serialize an event batch as JSONL lines (no trailing newline). With
 * `packChunks` on, delta-chunk runs pack into `text-chunks` /
 * `reasoning-chunks` / `tool-call-chunks` storage rows; off writes one event
 * per line, byte-identical to the pre-packing layout. Reading is layout-blind
 * either way ({@link scanLog} always decodes rows), so the switch changes only
 * newly written bytes.
 * @param events - the batch to serialize, in log order.
 * @param packChunks - whether to pack delta runs into storage rows.
 * @returns the batch's JSONL text; the writer adds the final newline.
 */
export function eventLines(events: readonly SessionEvent[], packChunks: boolean): string {
  const records: readonly StorageRecord[] = packChunks ? packChunkRuns(events) : events
  return records.map(record => JSON.stringify(record)).join('\n')
}

interface SessionLogScan {
  meta: SessionHeader
  events: SessionEvent[]
  committedBytes: number
}

/** Parse one complete header record supplied independently from event rows. */
/**
 * Refuse a header carrying a format version this build does not read BEFORE
 * validating the current header shape or decoding any event row: a future
 * format need not satisfy today's structural checks at all, and its user must
 * see "upgrade the harness", never "corrupt session log".
 * @param parsed - the JSON-parsed first line of a session artifact.
 */
function refuseForeignFormatVersion(parsed: unknown): void {
  if (typeof parsed !== 'object' || parsed === null) return
  const { version, id } = parsed as { version?: unknown; id?: unknown }
  if (typeof version !== 'number' || version === SESSION_FORMAT_VERSION) return
  throw new SessionFormatUnsupportedError(
    sessionFormatVersionRefusal(typeof id === 'string' ? id : String(id), version),
  )
}

function parseHeaderRecord(record: Buffer): SessionHeader {
  if (record.length === 0 || record.at(-1) !== 0x0A || record.indexOf(0x0A) !== record.length - 1) {
    throw new Error('empty or header-less session log')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(record.subarray(0, -1).toString('utf8'))
  } catch {
    throw new Error('corrupt session log: header line is not valid JSON')
  }
  refuseForeignFormatVersion(parsed)
  if (!isHeaderLine(parsed)) {
    throw new Error('corrupt session log: first line is not a session header')
  }
  return fromHeaderLine(parsed)
}

/**
 * Incrementally scan complete JSONL event records after an independently
 * supplied header record. Newline search and byte offsets stay on raw buffers;
 * only complete records are decoded to UTF-8. A fragment crossing writes is
 * copied because a decoder may reuse its output buffer after `write()` returns.
 */
export class SessionLogScanner {
  private readonly meta: SessionHeader
  private readonly events: SessionEvent[] = []
  private fragments: Buffer[] = []
  private fragmentBytes = 0
  private inputBytes: number
  private committedBytes: number
  private eventLine = 0
  private issue: Error | undefined
  private finished = false

  /**
   * Create an event scanner from exactly one newline-terminated header record.
   * @param headerRecord - the complete first JSONL record, including its newline.
   */
  constructor(headerRecord: Buffer) {
    this.meta = parseHeaderRecord(headerRecord)
    this.inputBytes = headerRecord.length
    this.committedBytes = headerRecord.length
  }

  /**
   * Consume the next raw plaintext chunk, retaining only an incomplete final record.
   * @param chunk - bytes immediately following all previously supplied bytes.
   */
  write(chunk: Buffer): void {
    if (this.finished) throw new Error('cannot write to a finished session log scanner')
    const chunkStart = this.inputBytes
    this.inputBytes += chunk.length
    let lineStart = 0
    for (
      let newline = chunk.indexOf(0x0A);
      newline !== -1;
      newline = chunk.indexOf(0x0A, lineStart)
    ) {
      const fragment = chunk.subarray(lineStart, newline)
      let line = fragment
      if (this.fragments.length > 0) {
        if (fragment.length > 0) this.fragments.push(fragment)
        line = Buffer.concat(this.fragments, this.fragmentBytes + fragment.length)
        this.fragments = []
        this.fragmentBytes = 0
      }
      this.consumeEventLine(line, chunkStart + newline + 1)
      lineStart = newline + 1
    }
    if (lineStart < chunk.length) {
      const fragment = Buffer.from(chunk.subarray(lineStart))
      this.fragments.push(fragment)
      this.fragmentBytes += fragment.length
    }
  }

  /**
   * Snapshot progress before appending a recoverable torn-frame prefix.
   * @returns byte, committed-prefix, and expanded-event cursors.
   */
  checkpoint(): { inputBytes: number; committedBytes: number; eventCount: number } {
    return {
      inputBytes: this.inputBytes,
      committedBytes: this.committedBytes,
      eventCount: this.events.length,
    }
  }

  /**
   * Finish scanning, ignoring a final record without a newline as a torn tail.
   * @returns the header, contiguous event prefix, and safe truncation offset.
   */
  finish(): SessionLogScan {
    this.finished = true
    return { meta: this.meta, events: this.events, committedBytes: this.committedBytes }
  }

  /** Decode one complete event row and update the contiguous prefix. */
  private consumeEventLine(line: Buffer, endByte: number): void {
    this.eventLine += 1
    let decoded: SessionEvent[]
    try {
      decoded = decodeStorageRecord(JSON.parse(line.toString('utf8')))
    } catch {
      this.issue ??= new Error(`corrupt session log: unparsable committed event at line ${this.eventLine}`)
      return
    }

    if (this.issue !== undefined) {
      if (decoded.some(event => event.type === 'turn/end')) throw this.issue
      return
    }

    const rowStart = this.events.length
    for (const event of decoded) {
      if (event.seq !== this.events.length) {
        const expected = this.events.length
        this.events.length = rowStart
        this.issue = new Error(
          `corrupt session log: seq gap in committed region at line ${this.eventLine} `
          + `(expected ${expected}, got ${event.seq})`,
        )
        if (decoded.some(candidate => candidate.type === 'turn/end')) throw this.issue
        return
      }
      this.events.push(event)
    }
    this.committedBytes = endByte
  }
}

/**
 * Parse a complete or torn JSONL buffer into its preserved event prefix. This
 * compatibility wrapper supplies the first record separately, then delegates
 * event rows to {@link SessionLogScanner}.
 *
 * @param buffer - the raw bytes of the log file (header line first).
 * @returns the header, preserved event prefix, and byte offset safe to append at.
 */
export function scanLog(buffer: Buffer): SessionLogScan {
  const headerEnd = buffer.indexOf(0x0A)
  if (headerEnd === -1) throw new Error('empty or header-less session log')
  const scanner = new SessionLogScanner(buffer.subarray(0, headerEnd + 1))
  scanner.write(buffer.subarray(headerEnd + 1))
  return scanner.finish()
}

/**
 * The repair target of the resume-race overlap corruption: a committed prefix
 * whose tail seqs were replayed by a longer, fully contiguous continuation.
 * `fromByte`/`toByte` bound the spurious island (whole lines) in plaintext
 * byte offsets; `events` is the reconstructed log (prefix before the island,
 * then the whole continuation).
 */
export interface OverlapSplice {
  /** Plaintext byte offset of the island's first line (inclusive). */
  fromByte: number
  /** Plaintext byte offset of the continuation's first line (exclusive). */
  toByte: number
  /** The spliced event log: committed events before the island, then the continuation. */
  events: SessionEvent[]
}

/**
 * Recover the resume-race overlap corruption from a log's full plaintext.
 *
 * The corruption shape (see the JSONL backend README): a process resumes a
 * session whose turn was interrupted mid-stream, its repair appends synthetic
 * closers plus an end-seed, and a still-running original loop then streams the
 * continuation from its own pre-repair cursor — so the log contains a small
 * island of events whose seqs are replayed by the following contiguous run.
 * The later run is authoritative: the session that produced it kept running,
 * so the island (the earlier repair artifacts) must be dropped.
 *
 * Returns the splice when the log has EXACTLY this shape — a single seq drop
 * to an already-committed value, an island whose first line starts at the
 * dropped seq and whose last line ends at the committed prefix's last seq, and
 * a fully contiguous, strictly longer suffix. Every other corruption (a
 * forward gap, an unparsable row, a misaligned island, a broken suffix) is not
 * this recoverable pattern and returns `undefined`, so callers keep the loud
 * refusal.
 *
 * @param plaintext - the log's decoded JSONL text (header line first).
 * @returns the splice repair target, or `undefined` when the pattern does not apply.
 */
export function findOverlapSplice(plaintext: string): OverlapSplice | undefined {
  const lines = plaintext.split('\n')
  if (lines.length < 3) return undefined
  // Byte offset of every line start (line 0 is the header). Byte lengths, not
  // UTF-16 code-unit lengths: a non-ASCII record would skew every later offset.
  const starts: number[] = [0]
  let offset = 0
  for (let i = 0; i < lines.length - 1; i++) {
    offset += Buffer.byteLength(lines[i] ?? '', 'utf8') + 1
    starts.push(offset)
  }

  const prefix: SessionEvent[] = []
  // Contiguous seq range of every committed event line, for island location.
  const ranges: Array<{ from: number; to: number; line: number }> = []
  let expected = 0

  const decodeRow = (line: string): SessionEvent[] | undefined => {
    if (line.length === 0) return undefined
    try {
      const row = decodeStorageRecord(JSON.parse(line))
      return row.length === 0 ? undefined : row
    } catch {
      return undefined
    }
  }
  const rowContiguous = (row: readonly SessionEvent[]): boolean => {
    for (let k = 1; k < row.length; k++) {
      const prev = row[k - 1]
      const cur = row[k]
      if (prev === undefined || cur === undefined || cur.seq !== prev.seq + 1) return false
    }
    return true
  }

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]
    if (line === undefined || line.length === 0) continue // the split's trailing empty element is not a record
    const row = decodeRow(line)
    if (row === undefined || !rowContiguous(row)) return undefined
    const first = row[0]
    const last = row[row.length - 1]
    if (first === undefined || last === undefined) return undefined
    if (first.seq !== expected) {
      const dropped = first.seq
      if (dropped > expected || dropped < 1) return undefined // forward gap: missing data, not a replay
      if (dropped > prefix.length) return undefined // drop beyond the committed prefix: not this pattern
      // The suffix from this line must be fully contiguous to the end.
      let suffixExpected = last.seq + 1
      for (let j = i + 1; j < lines.length; j++) {
        const suffixLine = lines[j]
        if (suffixLine === undefined || suffixLine.length === 0) continue
        const suffixRow = decodeRow(suffixLine)
        if (suffixRow === undefined || !rowContiguous(suffixRow)) return undefined
        const suffixFirst = suffixRow[0]
        const suffixLast = suffixRow[suffixRow.length - 1]
        if (suffixFirst === undefined || suffixLast === undefined) return undefined
        if (suffixFirst.seq !== suffixExpected) return undefined
        suffixExpected = suffixLast.seq + 1
      }
      // The continuation must strictly outlive the committed prefix it replays;
      // an exact duplicate tail is an ambiguous re-append, not this repair.
      if (suffixExpected <= expected) return undefined
      // The island starts at the first committed line whose range covers the
      // dropped seq, and must align exactly with the replayed range.
      const islandIndex = ranges.findIndex(range => range.from <= dropped && dropped <= range.to)
      const island = islandIndex === -1 ? undefined : ranges[islandIndex]
      const lastRange = ranges.at(-1)
      if (island === undefined || lastRange === undefined) return undefined
      if (island.from !== dropped) return undefined
      if (lastRange.to !== expected - 1) return undefined
      if (island.line >= i) return undefined
      // All lines between the island's first line and the drop line must be
      // inside the replayed range (one contiguous island).
      for (let r = islandIndex + 1; r < ranges.length; r++) {
        const prev = ranges[r - 1]
        const cur = ranges[r]
        if (prev === undefined || cur === undefined) return undefined
        if (cur.line >= i) return undefined
        if (cur.from !== prev.to + 1) return undefined
      }
      const fromByte = starts[island.line]
      const toByte = starts[i]
      if (fromByte === undefined || toByte === undefined) return undefined
      return {
        fromByte,
        toByte,
        events: [
          ...prefix.slice(0, dropped),
          ...row,
          ...collectSuffix(lines, i + 1, decodeRow),
        ],
      }
    }
    for (const event of row) prefix.push(event)
    ranges.push({ from: first.seq, to: last.seq, line: i })
    expected = last.seq + 1
  }
  return undefined
}

/** Collect the decoded continuation rows after the drop line. */
function collectSuffix(
  lines: readonly string[],
  from: number,
  decodeRow: (line: string) => SessionEvent[] | undefined,
): SessionEvent[] {
  const events: SessionEvent[] = []
  for (let j = from; j < lines.length; j++) {
    const line = lines[j]
    if (line === undefined) continue
    const row = decodeRow(line)
    if (row !== undefined) for (const event of row) events.push(event)
  }
  return events
}

/**
 * Parse just the header line of a log into a {@link SessionHeader}, or
 * `undefined` if it is missing/not a header. Used by `list()` to read session
 * metadata WITHOUT parsing the whole log: a session picker scales with the
 * number of sessions, not the total size of every conversation.
 * @param firstLine - the first line of a log file (without its trailing newline).
 * @returns the parsed header, or `undefined` when the line is not a well-formed session header.
 */
export function parseHeaderMeta(firstLine: string): SessionHeader | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(firstLine)
  } catch {
    return undefined
  }
  if (!isHeaderLine(parsed)) return undefined
  return fromHeaderLine(parsed)
}
