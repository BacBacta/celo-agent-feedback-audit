import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import {
  EVIDENCE_MAX_BYTES,
  EVIDENCE_TIMEOUT_MS,
  EVIDENCE_ATTEMPTS,
  EVIDENCE_RETRY_DELAY_MS,
  IPFS_GATEWAYS,
  ARWEAVE_GATEWAYS,
  MAX_REDIRECTS,
} from '../config.js'

/**
 * Retrieving an evidence file is the one place where this audit executes
 * attacker-controlled input: `feedbackURI` is a free string written on chain by
 * whoever left the review. Three properties matter, and the first version of
 * this code had none of them.
 *
 *  1. A failure must not be silently promoted to a finding. "The gateway rate
 *     limited us" and "the file is gone" are different facts, and only the
 *     second one is evidence of anything. `payment.ts` has always refused to
 *     record a 429 as "transaction not found"; this module extends the same
 *     rule to files, which is where the audit used to contradict itself.
 *  2. A hostile host must not be able to steer or stall the auditor. Size is
 *     capped while streaming, the deadline covers the body and not just the
 *     headers, redirects are followed by hand, and every hop is re-checked
 *     against private address space before a connection is made.
 *  3. One transport failure must not become a verdict. Files are retried, and
 *     content-addressed schemes are tried across independent gateways, because
 *     "ipfs.io was busy" says nothing about whether a CID still resolves.
 */
export type FetchOutcome =
  /** Bytes in hand. `via` names the gateway that served them. */
  | { kind: 'ok'; bytes: Uint8Array; text: string; url: string; status: number; via: string }
  /** The host answered, definitively, that there is nothing here. A real finding. */
  | { kind: 'dead'; status: number; note: string; url: string }
  /** We could not get an answer we trust. NOT evidence that the file is gone. */
  | { kind: 'inconclusive'; note: string; url: string | null }
  /** No transport exists for this scheme, so absence was never testable. */
  | { kind: 'unresolvable'; note: string }
  /** The URI pointed inside our own infrastructure and was refused unfetched. */
  | { kind: 'refused'; note: string }

/** 404/410 are the only statuses a server uses to assert "this does not exist". */
const DEAD_STATUSES = new Set([400, 401, 403, 404, 410, 451])
/** Everything else that is not 2xx is the network having a bad day, not a finding. */
const isRateLimited = (s: number) => s === 429 || s === 408 || s >= 500

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * Reject anything that resolves into address space only reachable from inside
 * the machine running the audit. Checked against the RESOLVED addresses rather
 * than the hostname text, because `evil.example` can simply have an A record
 * pointing at 127.0.0.1 — and again after every redirect, because a public
 * first hop can bounce to a private second one.
 */
export function isPrivateAddress(ip: string): boolean {
  if (isIP(ip) === 6) {
    const v6 = ip.toLowerCase()
    if (v6 === '::1' || v6 === '::' ) return true
    if (v6.startsWith('fe80') || v6.startsWith('fc') || v6.startsWith('fd')) return true
    // IPv4-mapped (::ffff:127.0.0.1) smuggles the whole v4 problem into v6.
    const mapped = v6.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/)
    if (mapped) return isPrivateAddress(mapped[1]!)
    return false
  }
  const p = ip.split('.').map(Number)
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true
  const [a, b] = p as [number, number, number, number]
  if (a === 0 || a === 10 || a === 127) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a === 169 && b === 254) return true // link-local, and the cloud metadata endpoint
  if (a === 100 && b >= 64 && b <= 127) return true // carrier-grade NAT
  if (a >= 224) return true // multicast and reserved
  return false
}

async function guardHost(url: URL): Promise<string | null> {
  const host = url.hostname.replace(/^\[|\]$/g, '')
  if (/^(localhost|.*\.localhost|.*\.local|.*\.internal)$/i.test(host)) {
    return `refused private host ${host}`
  }
  if (isIP(host)) {
    return isPrivateAddress(host) ? `refused private address ${host}` : null
  }
  let addrs
  try {
    addrs = await lookup(host, { all: true })
  } catch {
    return `cannot resolve ${host}`
  }
  if (!addrs.length) return `cannot resolve ${host}`
  const bad = addrs.find((a) => isPrivateAddress(a.address))
  return bad ? `refused private address ${bad.address} for ${host}` : null
}

/**
 * Read the body under a byte budget instead of calling `res.text()`.
 *
 * `res.text()` buffers whatever the peer sends, so a two-gigabyte response —
 * which costs the adversary nothing to serve — ends the audit with an
 * out-of-memory kill rather than a verdict. Streaming lets us stop at the cap
 * and record the oversize as its own observation.
 */
async function readCapped(res: Response, maxBytes: number): Promise<Uint8Array | 'too-large'> {
  const declared = Number(res.headers.get('content-length') ?? NaN)
  if (Number.isFinite(declared) && declared > maxBytes) return 'too-large'
  if (!res.body) return new Uint8Array()

  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      total += value.byteLength
      if (total > maxBytes) return 'too-large'
      chunks.push(value)
    }
  } finally {
    await reader.cancel().catch(() => {})
  }
  const out = new Uint8Array(total)
  let at = 0
  for (const c of chunks) { out.set(c, at); at += c.byteLength }
  return out
}

/**
 * One HTTP attempt, redirects followed by hand.
 *
 * The deadline is armed once and cleared only after the body has been read.
 * Arming it around `fetch` alone — which resolves as soon as the response
 * HEADERS arrive — bounds nothing: a host that answers instantly and then
 * dribbles the body one byte at a time holds the auditor open forever.
 */
async function fetchOnce(target: string, timeoutMs: number, maxBytes: number): Promise<FetchOutcome> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  let url = target
  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      let parsed: URL
      try { parsed = new URL(url) } catch { return { kind: 'unresolvable', note: 'malformed URL' } }
      if (!/^https?:$/i.test(parsed.protocol)) {
        return { kind: 'refused', note: `refused redirect to ${parsed.protocol.replace(':', '')}` }
      }
      const refusal = await guardHost(parsed)
      if (refusal) return { kind: 'refused', note: refusal }

      const res = await fetch(url, {
        signal: ctrl.signal,
        redirect: 'manual',
        headers: { accept: 'application/json, text/plain;q=0.9, */*;q=0.5' },
      })

      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get('location')
        if (!loc) return { kind: 'inconclusive', note: `HTTP ${res.status} without location`, url }
        await res.body?.cancel().catch(() => {})
        url = new URL(loc, url).toString()
        continue
      }
      if (!res.ok) {
        await res.body?.cancel().catch(() => {})
        if (DEAD_STATUSES.has(res.status)) {
          return { kind: 'dead', status: res.status, note: `HTTP ${res.status}`, url }
        }
        return { kind: 'inconclusive', note: `HTTP ${res.status}`, url }
      }

      const body = await readCapped(res, maxBytes)
      if (body === 'too-large') {
        return { kind: 'dead', status: res.status, note: `oversize body (> ${maxBytes} bytes)`, url }
      }
      return {
        kind: 'ok',
        bytes: body,
        text: new TextDecoder('utf-8').decode(body),
        url,
        status: res.status,
        via: new URL(url).host,
      }
    }
    return { kind: 'inconclusive', note: `more than ${MAX_REDIRECTS} redirects`, url }
  } catch (err) {
    const msg = (err as Error)?.name === 'AbortError' ? `timeout after ${timeoutMs}ms` : 'fetch failed'
    return { kind: 'inconclusive', note: msg, url }
  } finally {
    clearTimeout(timer)
  }
}

/** Percent/base64 payloads carried in the URI itself — no network, always live. */
function readDataUri(uri: string, maxBytes: number): FetchOutcome {
  const m = /^data:([^,]*),([\s\S]*)$/i.exec(uri)
  if (!m) return { kind: 'unresolvable', note: 'malformed data: URI' }
  const meta = m[1] ?? ''
  const payload = m[2] ?? ''
  try {
    const bytes = /;base64$/i.test(meta)
      ? new Uint8Array(Buffer.from(payload, 'base64'))
      : new TextEncoder().encode(decodeURIComponent(payload))
    if (bytes.byteLength > maxBytes) {
      return { kind: 'dead', status: 200, note: `oversize body (> ${maxBytes} bytes)`, url: 'data:' }
    }
    return {
      kind: 'ok', bytes, text: new TextDecoder('utf-8').decode(bytes),
      url: 'data:', status: 200, via: 'data:',
    }
  } catch {
    return { kind: 'unresolvable', note: 'undecodable data: URI' }
  }
}

/**
 * Every URL worth trying for one URI, best first.
 *
 * Content-addressed schemes get one entry per gateway: a CID is the same bytes
 * everywhere, so a single busy gateway is a fact about that gateway, never
 * about the file. Comparison is case-insensitive because `IPFS://` and
 * `HTTPS://` are valid and the first version of this code called them
 * unresolvable.
 */
export function resolveTargets(uri: string): { targets: string[]; scheme: string } {
  const u = uri.trim()
  const lower = u.toLowerCase()
  if (!u) return { targets: [], scheme: '' }

  if (lower.startsWith('ipfs://')) {
    const path = u.slice('ipfs://'.length).replace(/^ipfs\//i, '')
    return { targets: IPFS_GATEWAYS.map((g) => `${g}${path}`), scheme: 'ipfs' }
  }
  if (lower.startsWith('ipns://')) {
    const path = u.slice('ipns://'.length)
    return { targets: IPFS_GATEWAYS.map((g) => `${g.replace('/ipfs/', '/ipns/')}${path}`), scheme: 'ipns' }
  }
  if (lower.startsWith('ar://')) {
    const path = u.slice('ar://'.length)
    return { targets: ARWEAVE_GATEWAYS.map((g) => `${g}${path}`), scheme: 'ar' }
  }
  if (lower.startsWith('data:')) return { targets: [u], scheme: 'data' }
  if (lower.startsWith('http://') || lower.startsWith('https://')) return { targets: [u], scheme: 'http' }
  return { targets: [], scheme: lower.split(':')[0] ?? 'unknown' }
}

/**
 * Follow one feedback record's URI to bytes, or to a reasoned failure.
 *
 * Retries and gateway fan-out exist to make a negative mean something. A single
 * GET through one gateway cannot distinguish a dead file from a busy afternoon,
 * and the audit published 9,409 "unreachable" verdicts on exactly that basis.
 * A `dead` answer here means some host asserted absence; `inconclusive` means
 * we still do not know, and callers must not round it down to a finding.
 */
export async function fetchEvidence(
  uri: string,
  opts: { timeoutMs?: number; maxBytes?: number; attempts?: number } = {},
): Promise<FetchOutcome> {
  const timeoutMs = opts.timeoutMs ?? EVIDENCE_TIMEOUT_MS
  const maxBytes = opts.maxBytes ?? EVIDENCE_MAX_BYTES
  const attempts = opts.attempts ?? EVIDENCE_ATTEMPTS

  const { targets, scheme } = resolveTargets(uri)
  if (!targets.length) {
    return { kind: 'unresolvable', note: scheme ? `unresolvable URI scheme: ${scheme}` : 'empty URI' }
  }
  if (scheme === 'data') return readDataUri(targets[0]!, maxBytes)

  let lastDead: FetchOutcome | null = null
  let lastOther: FetchOutcome | null = null

  for (let attempt = 0; attempt < attempts; attempt++) {
    for (const target of targets) {
      const out = await fetchOnce(target, timeoutMs, maxBytes)
      if (out.kind === 'ok') return out
      if (out.kind === 'dead') lastDead = out
      else lastOther = out
      // A gateway that rate-limited us tells us nothing; try the next one now.
    }
    // Every target failed. Only wait if something might still change.
    if (attempt < attempts - 1) await sleep(EVIDENCE_RETRY_DELAY_MS * (attempt + 1))
  }

  /**
   * A single gateway asserting 404 while others merely stalled is not proof of
   * death for a content-addressed file — the CID may be alive on a peer none of
   * our gateways asked. Only call it dead when nothing inconclusive happened.
   */
  if (lastDead && (!lastOther || targets.length === 1)) return lastDead
  if (lastOther) return lastOther
  return lastDead ?? { kind: 'inconclusive', note: 'no attempt completed', url: targets[0] ?? null }
}

export { isRateLimited }
