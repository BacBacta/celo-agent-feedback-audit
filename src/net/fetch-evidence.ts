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
  /**
   * The URI itself is unusable — a scheme with no transport, or one pointing
   * into private address space. Decided locally, with no network involved, so
   * it is a fact about the record and not a failure to reach anything: a
   * publisher who declares `magnet:?xt=…` has declared evidence nobody can
   * retrieve, and treating that as "we could not check" would make a junk URI
   * strictly safer to publish than an honest dead link.
   */
  | { kind: 'unusable'; note: string }

/**
 * The only statuses in which a server asserts the resource is not there.
 *
 * 400, 401, 403 and 451 were in this set and should never have been: they mean
 * "I will not serve you this", not "there is nothing here". A WAF answering 403
 * to an unfamiliar user agent, a gateway requiring a key, a jurisdictional
 * block — each fabricated a published `EvidenceUnreachable` for a file that was
 * alive and would have hashed correctly. That is the misclassification this
 * audit exists to expose, committed by the audit.
 */
const DEAD_STATUSES = new Set([404, 410])
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
    if (v6 === '::1' || v6 === '::') return true
    if (/^f[cd]/.test(v6)) return true // fc00::/7 unique-local
    if (/^fe[89ab]/.test(v6)) return true // fe80::/10 link-local — not only fe80::/16
    /**
     * IPv4-mapped addresses smuggle the whole v4 problem into v6, and the
     * dotted form is the one they are almost never written in by the time this
     * function sees them: `new URL()` normalises ::ffff:127.0.0.1 to
     * ::ffff:7f00:1, so a check that only matched the dotted spelling could
     * never fire on a hostname taken from a parsed URL. That left
     * http://[::ffff:a9fe:a9fe]/ — the cloud metadata endpoint — passing the
     * guard untouched.
     */
    const dotted = /^(?:0*:)*ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v6)
    if (dotted) return isPrivateAddress(dotted[1]!)
    const hexed = /^(?:0*:)*ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(v6)
    if (hexed) {
      const hi = parseInt(hexed[1]!, 16)
      const lo = parseInt(hexed[2]!, 16)
      return isPrivateAddress([hi >> 8, hi & 255, lo >> 8, lo & 255].join('.'))
    }
    // NAT64 (64:ff9b::/96) reaches v4 space through a translator.
    if (/^64:ff9b:/.test(v6)) return true
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

/**
 * KNOWN LIMIT: this resolves the name, and then `fetch` resolves it again.
 *
 * Between the two lookups a record with a short TTL can change, so a host that
 * answered with a public address at check time can answer with a private one at
 * connect time. Closing that window needs a dispatcher that connects to the
 * address this function actually approved, which Node's built-in fetch does not
 * expose. The guard therefore stops a URI that simply points inside, and does
 * not stop an adversary who controls a nameserver. Said plainly here rather
 * than left to be discovered.
 */
type Refusal = { kind: 'unusable' | 'inconclusive'; note: string }

async function guardHost(url: URL): Promise<Refusal | null> {
  // `url.hostname` already excludes any userinfo and port, so the credentials
  // form (http://real-host@127.0.0.1/) is checked against 127.0.0.1, which is
  // the host that will actually be contacted.
  const host = url.hostname.replace(/^\[|\]$/g, '')
  if (/^(localhost|.*\.localhost|.*\.local|.*\.internal)$/i.test(host)) {
    return { kind: 'unusable', note: `refused private host ${host}` }
  }
  if (isIP(host)) {
    return isPrivateAddress(host) ? { kind: 'unusable', note: `refused private address ${host}` } : null
  }
  let addrs
  try {
    addrs = await lookup(host, { all: true })
  } catch {
    /**
     * A name that does not resolve says nothing about the evidence.
     *
     * It was classed alongside the SSRF refusals — as a fact about the URI —
     * and that is wrong twice over. A nameserver can be down, and more to the
     * point the host being resolved is often OUR gateway rather than anything
     * the publisher chose: cloudflare-ipfs.com was shipped in the default
     * gateway list and has since been shut down, so every content-addressed
     * file was one dead gateway away from being written off as a dead link.
     */
    return { kind: 'inconclusive', note: `cannot resolve ${host}` }
  }
  if (!addrs.length) return { kind: 'inconclusive', note: `cannot resolve ${host}` }
  const bad = addrs.find((a) => isPrivateAddress(a.address))
  return bad ? { kind: 'unusable', note: `refused private address ${bad.address} for ${host}` } : null
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
      try { parsed = new URL(url) } catch { return { kind: 'unusable', note: 'malformed URL' } }
      if (!/^https?:$/i.test(parsed.protocol)) {
        return { kind: 'unusable', note: `refused redirect to ${parsed.protocol.replace(':', '')}` }
      }
      const refusal = await guardHost(parsed)
      if (refusal) return refusal.kind === 'unusable'
        ? { kind: 'unusable', note: refusal.note }
        : { kind: 'inconclusive', note: refusal.note, url }

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
        // Refused, rate limited, broken — all of them mean the file was never
        // tested, and none of them is evidence about the file.
        return { kind: 'inconclusive', note: `HTTP ${res.status}`, url }
      }

      const body = await readCapped(res, maxBytes)
      if (body === 'too-large') {
        /**
         * Something is served here; we declined to read all of it. Calling that
         * "the file does not exist" let a single mendacious Content-Length
         * header manufacture a dead-link verdict without sending a byte — and
         * it is not what we observed in any case.
         */
        return { kind: 'inconclusive', note: `oversize body (over ${maxBytes} bytes)`, url }
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
  if (!m) return { kind: 'unusable', note: 'malformed data: URI' }
  const meta = m[1] ?? ''
  const payload = m[2] ?? ''
  try {
    const bytes = /;base64$/i.test(meta)
      ? new Uint8Array(Buffer.from(payload, 'base64'))
      : new TextEncoder().encode(decodeURIComponent(payload))
    if (bytes.byteLength > maxBytes) {
      return { kind: 'inconclusive', note: `oversize body (over ${maxBytes} bytes)`, url: 'data:' }
    }
    return {
      kind: 'ok', bytes, text: new TextDecoder('utf-8').decode(bytes),
      url: 'data:', status: 200, via: 'data:',
    }
  } catch {
    return { kind: 'unusable', note: 'undecodable data: URI' }
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
    return { kind: 'unusable', note: scheme ? `unresolvable URI scheme: ${scheme}` : 'empty URI' }
  }
  if (scheme === 'data') return readDataUri(targets[0]!, maxBytes)

  /**
   * Per target, not per grid.
   *
   * Tracking one "was anything inconclusive anywhere" flag across every target
   * and every pass meant a single stalled gateway permanently outvoted a
   * different gateway that answered 404 on every pass it was asked — the
   * evidence for death got stronger while the verdict stayed inconclusive.
   * A target is dead when its LAST word was 404 and it never once stalled.
   */
  const lastByTarget = new Map<string, FetchOutcome>()
  const stalledByTarget = new Set<string>()

  for (let attempt = 0; attempt < attempts; attempt++) {
    for (const target of targets) {
      const out = await fetchOnce(target, timeoutMs, maxBytes)
      if (out.kind === 'ok') return out
      /**
       * An unusable TARGET condemns the URI only when the target IS the URI.
       *
       * For a content-addressed file the targets are our own gateways, and one
       * of them being unusable is a fact about that gateway. Returning here
       * regardless meant a single bad entry in the gateway list could write off
       * every ipfs:// record in the registry as a dead link without asking
       * anybody else — the exact misclassification this module exists to prevent.
       */
      if (out.kind === 'unusable' && targets.length === 1) return out
      lastByTarget.set(target, out)
      if (out.kind !== 'dead' && out.kind !== 'unusable') stalledByTarget.add(target)
      // A gateway that rate-limited us tells us nothing; try the next one now.
    }
    // Every target failed. Only wait if something might still change.
    if (attempt < attempts - 1) await sleep(EVIDENCE_RETRY_DELAY_MS * (attempt + 1))
  }

  /**
   * One host asserting absence is enough when that host was answering
   * consistently — but for a content-addressed file spread over several
   * gateways, a 404 from one that also stalled says nothing: the CID may be
   * alive on a peer nobody asked.
   */
  for (const target of targets) {
    const last = lastByTarget.get(target)
    if (last?.kind === 'dead' && !stalledByTarget.has(target)) return last
  }
  const anyOther = targets.map((t) => lastByTarget.get(t)).find((o) => o && o.kind !== 'dead')
  if (anyOther) return anyOther
  const anyDead = targets.map((t) => lastByTarget.get(t)).find((o) => o?.kind === 'dead')
  return anyDead ?? { kind: 'inconclusive', note: 'no attempt completed', url: targets[0] ?? null }
}

export { isRateLimited }
