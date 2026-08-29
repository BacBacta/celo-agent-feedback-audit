import { networkInterfaces } from 'node:os'
import { Resolver } from 'node:dns/promises'
import { Agent, EnvHttpProxyAgent, fetch as undiciFetch } from 'undici'
import { isIP } from 'node:net'
import {
  EVIDENCE_MAX_BYTES,
  EVIDENCE_TIMEOUT_MS,
  EVIDENCE_ATTEMPTS,
  EVIDENCE_RETRY_DELAY_MS,
  EVIDENCE_BUDGET_MS,
  IPFS_GATEWAYS,
  ARWEAVE_GATEWAYS,
  MAX_REDIRECTS,
  DNS_TIMEOUT_MS,
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
  /**
   * The rest of RFC 6890's special-purpose blocks. None of them is a place a
   * publisher's evidence can legitimately live, and several are reachable
   * from inside a datacentre: 192.0.0.0/24 is IETF protocol assignments,
   * 198.18.0.0/15 is benchmarking — a range some networks route internally —
   * and the three documentation blocks are frequently squatted on by lab and
   * staging environments.
   */
  if (a === 192 && b === 0 && p[2] === 0) return true // 192.0.0.0/24
  if (a === 192 && b === 0 && p[2] === 2) return true // TEST-NET-1
  if (a === 198 && b >= 18 && b <= 19) return true // benchmarking
  if (a === 198 && b === 51 && p[2] === 100) return true // TEST-NET-2
  if (a === 203 && b === 0 && p[2] === 113) return true // TEST-NET-3
  if (a >= 224) return true // multicast and reserved
  /**
   * And the machine running the audit.
   *
   * Its own non-loopback address is ordinary public space to every rule above,
   * so a feedbackURI naming it reached whatever this host serves — a dev
   * server, a metrics endpoint, an admin panel — and the bytes came back and
   * were hashed and published as somebody's evidence. It is refused, and the
   * list is read once because interfaces do not move mid-run.
   */
  if (OWN_ADDRESSES.has(ip)) return true
  return false
}

/** Every address this machine answers on, so a URI cannot name us. */
const OWN_ADDRESSES = new Set<string>(
  Object.values(networkInterfaces())
    .flatMap((ifaces) => ifaces ?? [])
    .map((i) => i.address),
)

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
type Approved = { address: string; family: number }
type GuardResult = Refusal | Approved

const isRefusal = (g: GuardResult): g is Refusal => 'kind' in g

/**
 * Resolve a name in a way the deadline can actually stop.
 *
 * `dns.lookup` runs getaddrinfo on the libuv threadpool — four threads by
 * default — and takes no AbortSignal. Racing it against the deadline returned
 * control to us on time and left the syscall running: the thread stayed
 * occupied for as long as the resolver took. Eight records naming hosts with
 * slow nameservers were enough to hold every thread in the pool, and every
 * lookup after them queued behind those, so a handful of hostile records
 * poisoned the rest of the run and each victim was published as
 * `inconclusive`. The attacker bought the audit's time and paid nothing.
 *
 * `Resolver` is c-ares: it does its own socket I/O, never touches the
 * threadpool, carries its own timeout, and `cancel()` really cancels. The one
 * behavioural difference is that it does not consult /etc/hosts, which for a
 * list of public gateways is no loss and is stated here rather than discovered.
 */
async function resolveAddresses(
  host: string,
  signal?: AbortSignal,
): Promise<{ address: string; family: number }[]> {
  const resolver = new Resolver({ timeout: DNS_TIMEOUT_MS, tries: 1 })
  const onAbort = () => { try { resolver.cancel() } catch { /* already done */ } }
  if (signal?.aborted) throw new Error('aborted')
  signal?.addEventListener('abort', onAbort, { once: true })
  try {
    const [v4, v6] = await Promise.allSettled([resolver.resolve4(host), resolver.resolve6(host)])
    const out: { address: string; family: number }[] = []
    if (v4.status === 'fulfilled') for (const a of v4.value) out.push({ address: a, family: 4 })
    if (v6.status === 'fulfilled') for (const a of v6.value) out.push({ address: a, family: 6 })
    if (!out.length) throw new Error('no address')
    return out
  } finally {
    signal?.removeEventListener('abort', onAbort)
  }
}

async function guardHost(url: URL, signal?: AbortSignal): Promise<GuardResult> {
  // `url.hostname` already excludes any userinfo and port, so the credentials
  // form (http://real-host@127.0.0.1/) is checked against 127.0.0.1, which is
  // the host that will actually be contacted.
  const host = url.hostname.replace(/^\[|\]$/g, '')
  if (/^(localhost|.*\.localhost|.*\.local|.*\.internal)$/i.test(host)) {
    return { kind: 'unusable', note: `refused private host ${host}` }
  }
  if (isIP(host)) {
    if (isPrivateAddress(host)) return { kind: 'unusable', note: `refused private address ${host}` }
    return { address: host, family: isIP(host) }
  }
  let addrs
  try {
    addrs = await resolveAddresses(host, signal)
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
  if (bad) return { kind: 'unusable', note: `refused private address ${bad.address} for ${host}` }
  // Hand back the address that was checked, so the connection can be pinned to
  // it. Returning only "allowed" left the socket free to resolve the name a
  // second time, which is the whole of the rebinding window.
  const first = addrs[0]!
  return { address: first.address, family: first.family }
}

/**
 * Connect to the address the guard approved, not to whatever the name resolves
 * to a moment later.
 *
 * The guard used to resolve a hostname, approve it, and then hand the URL to
 * `fetch`, which resolved it again. Between those two lookups a record with a
 * short TTL can change, so a host answering with a public address at check time
 * could answer with 127.0.0.1 at connect time — the classic rebinding window,
 * and the guard was decorative against anyone who ran a nameserver.
 *
 * Pinning closes it: the socket is given the exact address that was inspected.
 * TLS still negotiates against the HOSTNAME, so SNI and certificate validation
 * are untouched — an attacker gains nothing by pointing the name somewhere they
 * hold no certificate for.
 */
const dispatchers = new Map<string, Agent>()

/**
 * Pinning is only meaningful on a direct connection.
 *
 * Behind an HTTP proxy the socket goes to the PROXY, and the proxy resolves the
 * hostname itself — so there is no local address to pin, and the guard's own
 * lookup is a pre-filter rather than the boundary. Saying that out loud matters
 * more than the code: a deployment that believes rebinding is closed when the
 * proxy is deciding where to connect holds a guarantee nobody gave it.
 */
/**
 * Whether THIS request will be proxied — not whether a variable exists.
 *
 * Pinning used to be switched off globally by the first non-null of four
 * environment variables, and that was wrong twice. `??` only skips null and
 * undefined, so an exported-but-empty `HTTPS_PROXY=""` disarmed pinning while
 * proxying nothing: the request went out direct, resolving the name a second
 * time, which is exactly the rebinding window this module exists to close.
 * And a proxy is per-scheme: with only HTTPS_PROXY set, an `http://` URL is
 * never proxied, yet it lost its pinning all the same. NO_PROXY is the third
 * spelling of the same hole.
 */
const envProxy = (...names: string[]): string | null => {
  for (const n of names) {
    const v = (process.env[n] ?? '').trim()
    if (v) return v
  }
  return null
}
const HTTPS_PROXY = envProxy('HTTPS_PROXY', 'https_proxy')
const HTTP_PROXY = envProxy('HTTP_PROXY', 'http_proxy')
const NO_PROXY = (envProxy('NO_PROXY', 'no_proxy') ?? '')
  .split(',').map((x) => x.trim().toLowerCase()).filter(Boolean)

/** Does NO_PROXY exempt this host, so the request goes out direct after all? */
function noProxyCovers(host: string): boolean {
  const h = host.toLowerCase()
  return NO_PROXY.some((e) => e === '*' || h === e || h === e.replace(/^\./, '') || h.endsWith(e.startsWith('.') ? e : `.${e}`))
}

/** The proxy this exact URL would go through, or null if it goes out direct. */
export function proxyFor(url: URL): string | null {
  if (noProxyCovers(url.hostname)) return null
  return url.protocol === 'https:' ? HTTPS_PROXY : HTTP_PROXY
}

/** Is any proxy configured at all? Reporting only — never a per-request test. */
export const PINNING_ACTIVE = !HTTPS_PROXY && !HTTP_PROXY

/**
 * When a proxy is configured, route through it explicitly.
 *
 * Falling back to the GLOBAL fetch was worse than useless: Node's built-in
 * fetch does not read HTTPS_PROXY at all, so that branch was neither pinned nor
 * proxied — a direct connection resolving the name a second time, which is
 * precisely the rebinding window this module claims to close. Every request now
 * carries an explicit dispatcher: the proxy's, or the pinned one.
 */
const proxyDispatcher = HTTPS_PROXY || HTTP_PROXY ? new EnvHttpProxyAgent() : null

export function pinningStatus(): string {
  return PINNING_ACTIVE
    ? 'address pinning: active — connections go to the address the guard checked'
    : `address pinning: UNAVAILABLE — traffic goes through ${HTTPS_PROXY ?? HTTP_PROXY}, which resolves hostnames itself.` +
      ' The SSRF guard is a local pre-filter here, not the boundary; the proxy is.'
}

/**
 * Enough for the concurrency in flight, many times over. The map is keyed by an
 * address the party being audited chooses, so without a ceiling a registry full
 * of distinct hosts holds a connection pool per host for the whole run.
 */
const MAX_PINNED_DISPATCHERS = 64

function pinnedDispatcher(address: string, family: number): Agent {
  const key = `${address}/${family}`
  const hit = dispatchers.get(key)
  if (hit) {
    // Refresh recency: a Map keeps insertion order, so re-inserting makes the
    // eviction below least-recently-used rather than first-created.
    dispatchers.delete(key)
    dispatchers.set(key, hit)
    return hit
  }
  while (dispatchers.size >= MAX_PINNED_DISPATCHERS) {
    const oldest = dispatchers.keys().next().value as string | undefined
    if (oldest === undefined) break
    const evicted = dispatchers.get(oldest)
    dispatchers.delete(oldest)
    void evicted?.close().catch(() => {})
  }
  const agent = new Agent({
    connect: {
      lookup(_hostname: string, options: { all?: boolean }, cb: Function) {
        if (options && options.all) cb(null, [{ address, family }])
        else cb(null, address, family)
      },
    },
  })
  dispatchers.set(key, agent)
  return agent
}

/** Release pooled sockets once a run is finished. */
export async function closeDispatchers(): Promise<void> {
  await Promise.all([...dispatchers.values()].map((a) => a.close().catch(() => {})))
  dispatchers.clear()
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
  if (Number.isFinite(declared) && declared > maxBytes) {
    // The body was never read, so it must be released here. Without this the
    // socket is held past the deadline — fetchOnce's `finally` has already
    // disarmed the AbortController — and a few hundred lying headers exhaust
    // the file descriptors, after which every remaining record in the registry
    // is published as "inconclusive" for a reason that is entirely ours.
    await res.body?.cancel().catch(() => {})
    return 'too-large'
  }
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
      const guard = await guardHost(parsed, ctrl.signal)
      if (isRefusal(guard)) {
        return guard.kind === 'unusable'
          ? { kind: 'unusable', note: guard.note }
          : { kind: 'inconclusive', note: guard.note, url }
      }

      /**
       * undici's own fetch, not the global one, when pinning: a dispatcher from
       * the userland package is rejected by Node's built-in fetch, which
       * validates it against its own bundled copy of the class.
       */
      const init = {
        signal: ctrl.signal,
        redirect: 'manual' as const,
        headers: { accept: 'application/json, text/plain;q=0.9, */*;q=0.5' },
      }
      const res = (await undiciFetch(url, {
        ...init,
        // Per URL, never globally: a request nothing will proxy must still be
        // pinned to the address the guard approved.
        dispatcher: proxyFor(parsed) && proxyDispatcher
          ? proxyDispatcher
          : pinnedDispatcher(guard.address, guard.family),
      })) as unknown as Response

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

/**
 * Percent-decode to raw bytes; `%zz` and a trailing `%` are left as written.
 *
 * `+` is a literal 0x2B here, not a space. That substitution is
 * application/x-www-form-urlencoded, a form-submission convention that has
 * nothing to do with RFC 2397 — and applying it to a `data:` URI silently
 * rewrote the publisher's bytes before they were hashed and archived, so the
 * digest published on chain was of a document nobody wrote.
 */
function percentDecodeToBytes(s: string): Uint8Array {
  const out: number[] = []
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!
    if (c === '%' && /^[0-9a-fA-F]{2}$/.test(s.slice(i + 1, i + 3))) {
      out.push(parseInt(s.slice(i + 1, i + 3), 16))
      i += 2
    } else {
      for (const b of new TextEncoder().encode(c)) out.push(b)
    }
  }
  return new Uint8Array(out)
}

/**
 * Base64 that refuses what it cannot read.
 *
 * `Buffer.from(x, 'base64')` never throws: it silently drops anything outside
 * the alphabet, so a corrupt payload came back as short bytes and was published
 * as evidence that was successfully retrieved — hashed and archived under a
 * digest of something nobody wrote.
 */
function decodeBase64Strict(payload: string): Uint8Array | null {
  const clean = payload.replace(/\s/g, '')
  if (!/^[A-Za-z0-9+/_-]*={0,2}$/.test(clean)) return null
  const bytes = new Uint8Array(Buffer.from(clean, 'base64'))
  // A round trip catches the silent truncation the decoder will not report.
  const back = Buffer.from(bytes).toString('base64').replace(/=+$/, '')
  if (back !== clean.replace(/[-_]/g, (m) => (m === '-' ? '+' : '/')).replace(/=+$/, '')) return null
  return bytes
}

/** Percent/base64 payloads carried in the URI itself — no network, always live. */
function readDataUri(uri: string, maxBytes: number): FetchOutcome {
  const m = /^data:([^,]*),([\s\S]*)$/i.exec(uri)
  if (!m) return { kind: 'unusable', note: 'malformed data: URI' }
  const meta = m[1] ?? ''
  const payload = m[2] ?? ''
  try {
    /**
     * Percent-decoding to BYTES, not through `decodeURIComponent`.
     *
     * That function is a text decoder: it throws on any percent sequence that
     * is not valid UTF-8, so a `data:` URI carrying binary — an image, a
     * compressed payload — was reported as an unusable URI, an accusation
     * about a document that was sitting right there in the string.
     */
    /**
     * Percent-decode first, then base64 — the order RFC 2397 and the WHATWG
     * data-URL processor both specify. Feeding the RAW payload to a strict
     * base64 test rejected any producer that had percent-encoded '=' (a
     * reserved character it is entitled to escape) or '+' or '/', and the
     * record was published as EvidenceUnreachable: an accusation built on our
     * own decoder taking the steps in the wrong order.
     */
    const bytes = /;base64$/i.test(meta)
      ? decodeBase64Strict(new TextDecoder('utf-8').decode(percentDecodeToBytes(payload)))
      : percentDecodeToBytes(payload)
    if (bytes === null) return { kind: 'unusable', note: 'malformed base64 in data: URI' }
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
 * Is this string a content identifier?
 *
 * CIDv0 is `Qm` followed by 44 base58 characters; CIDv1 in base32 is `b`
 * followed by base32 lowercase. Anything else under an `ipfs://` scheme cannot
 * resolve anywhere, for anyone — `ipfs://feedback-126-1771338626265` appears
 * eleven times in this registry and is not a locator, it is a filename someone
 * invented. Recognising that costs nothing and turns six pointless requests and
 * an "inconclusive" into what it actually is: a finding about the record.
 */
/**
 * A CIDv1 carrying an identity multihash holds its data inline, so it is far
 * shorter than the 32-byte-digest forms the length floors were calibrated for:
 * `bafkqablimvwgy3y` is sixteen characters and resolves on every gateway.
 * Refusing it published a valid, retrievable pointer as an invented filename.
 */
const IDENTITY_CIDV1 = /^(b[a-z2-7]{8,}|B[A-Z2-7]{8,}|f[0-9a-f]{16,}|F[0-9A-F]{16,})$/

export function isCid(s: string): boolean {
  const v = s.trim()
  if (/^Qm[1-9A-HJ-NP-Za-km-z]{44}$/.test(v)) return true
  if (/^b[a-z2-7]{58,}$/.test(v)) return true // CIDv1, base32 lower
  if (/^B[A-Z2-7]{58,}$/.test(v)) return true // CIDv1, base32 upper
  if (/^[zZ][1-9A-HJ-NP-Za-km-z]{40,}$/.test(v)) return true // CIDv1, base58btc
  if (/^k[0-9a-z]{50,}$/.test(v)) return true // CIDv1, base36 — the usual IPNS spelling
  if (/^K[0-9A-Z]{50,}$/.test(v)) return true // …and its uppercase form
  if (/^f[0-9a-f]{60,}$/.test(v)) return true // CIDv1, base16
  if (/^F[0-9A-F]{60,}$/.test(v)) return true
  // Inline data instead of a 32-byte digest, so much shorter than the above.
  if (IDENTITY_CIDV1.test(v) && !/^(feedback|file|doc|test)/i.test(v)) return true
  return false
}

/**
 * Pull a content identifier out of a URL that has a gateway baked into it.
 *
 * A publisher who wrote `http://ipfs.io/ipfs/<cid>` instead of `ipfs://<cid>`
 * described the same immutable bytes and, until now, got a single attempt at a
 * single host for it while the native form got three. The bytes are the same
 * wherever they come from — that is what content addressing means — so the hash
 * check stays valid no matter which gateway answers.
 */
export function cidFromGatewayUrl(url: string): { cid: string; ns: 'ipfs' | 'ipns' } | null {
  let u: URL
  try { u = new URL(url) } catch { return null }
  if (!/^https?:$/i.test(u.protocol)) return null

  // Subdomain gateways: https://<cid>.ipfs.dweb.link/
  const sub = /^([a-z2-7]{58,})\.(ipfs|ipns)\./i.exec(u.hostname)
  if (sub && isCid(sub[1]!)) {
    // The path is part of what was asked for. Dropping it — which the path
    // branch below never did — sent the fan-out after the CID's root instead of
    // the file, and whatever came back would have been hashed and published as
    // this record's evidence.
    const rest = u.pathname === '/' ? '' : u.pathname
    if (hasDotSegments(rest)) return null
    return { cid: sub[1]! + rest, ns: sub[2]!.toLowerCase() as 'ipfs' | 'ipns' }
  }

  // Path gateways: https://ipfs.io/ipfs/<cid>[/...]
  const path = /^\/(ipfs|ipns)\/([^/?#]+)(\/.*)?$/i.exec(u.pathname)
  if (path && isCid(path[2]!)) {
    const rest = path[3] ?? ''
    // `u.pathname` is already normalised by the URL parser, but the CID must
    // still be the thing being asked for: a rest that climbs back out means the
    // resource is not the one the identifier names.
    if (hasDotSegments(rest)) return null
    return { cid: path[2]! + rest, ns: path[1]!.toLowerCase() as 'ipfs' | 'ipns' }
  }
  return null
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
/**
 * Segments a URL parser will collapse before the request is sent.
 *
 * `ipfs://<valid cid>/../../../admin` passes a CID check applied to the first
 * segment and then asks four gateways for `/admin`: the bytes returned are not
 * the ones the identifier names, and they are hashed, archived and published as
 * that record's evidence. Verified at the wire: WHATWG-URL reduces the dot
 * segments before the request line is emitted, and decodes percent-encoding one
 * level, so both spellings must be refused here.
 */
/**
 * Exactly the URL spec's single- and double-dot path segments.
 *
 * `decodeURIComponent` was both too weak and too strong. Too weak: the URL
 * parser strips TAB, LF and CR from the whole input BEFORE it reduces dot
 * segments, so a segment written ".<LF>." was never equal to ".." here and
 * reached the gateway as one — a traversal that substituted the CID outright.
 * Too strong: an ordinary filename carrying a malformed escape made it throw,
 * and the `catch` published that record as an attempted path traversal against
 * its own publisher.
 *
 * The spec names the four spellings, so match them and decode nothing.
 */
const SINGLE_DOT = /^(?:\.|%2e)$/i
const DOUBLE_DOT = /^(?:\.\.|\.%2e|%2e\.|%2e%2e)$/i

function hasDotSegments(path: string): boolean {
  const stripped = path.replace(/[\t\n\r]/g, '').replace(/\\/g, '/')
  return stripped.split('/').some((seg) => SINGLE_DOT.test(seg) || DOUBLE_DOT.test(seg))
}

export function resolveTargets(uri: string): { targets: string[]; scheme: string } {
  const u = uri.trim()
  const lower = u.toLowerCase()
  if (!u) return { targets: [], scheme: '' }

  if (lower.startsWith('ipfs://')) {
    const path = u.slice('ipfs://'.length).replace(/^ipfs\//i, '')
    // Split on the query and fragment too: they are not part of the identifier,
    // and leaving them in made a perfectly valid `ipfs://<cid>?filename=x` read
    // as "not a CID" — an accusation, produced by our own parsing.
    const cid = path.split(/[/?#]/)[0] ?? ''
    // A scheme that promises content addressing, over something that is not a
    // content identifier, resolves nowhere for anybody.
    if (!isCid(cid)) return { targets: [], scheme: 'ipfs (not a CID)' }
    // The CID is validated on the first segment but the WHOLE path is what gets
    // appended to a gateway, so a traversal after it reaches another resource.
    if (hasDotSegments(path)) return { targets: [], scheme: 'ipfs (path traversal)' }
    return { targets: IPFS_GATEWAYS.map((g) => `${g}${path}`), scheme: 'ipfs' }
  }
  if (lower.startsWith('ipns://')) {
    const path = u.slice('ipns://'.length)
    if (!path) return { targets: [], scheme: 'ipns (empty)' }
    if (hasDotSegments(path)) return { targets: [], scheme: 'ipns (path traversal)' }
    return { targets: IPFS_GATEWAYS.map((g) => `${g.replace('/ipfs/', '/ipns/')}${path}`), scheme: 'ipns' }
  }
  if (lower.startsWith('ar://')) {
    const path = u.slice('ar://'.length)
    const id = path.split(/[/?#]/)[0] ?? ''
    // An Arweave transaction id is 43 base64url characters. Without this,
    // `ar://` alone fetched each gateway's own home page and published it as
    // the publisher's evidence — bytes hashed, archived and attributed to a
    // record whose author never served them.
    if (!/^[A-Za-z0-9_-]{43}$/.test(id)) return { targets: [], scheme: 'ar (not a transaction id)' }
    if (hasDotSegments(path)) return { targets: [], scheme: 'ar (path traversal)' }
    return { targets: ARWEAVE_GATEWAYS.map((g) => `${g}${path}`), scheme: 'ar' }
  }
  if (lower.startsWith('data:')) return { targets: [u], scheme: 'data' }
  if (lower.startsWith('http://') || lower.startsWith('https://')) {
    /**
     * A gateway baked into an http(s) URL still names immutable bytes. Try the
     * publisher's own host first — it is the one they vouched for — then the
     * same CID through ours, because a busy gateway is a fact about that
     * gateway and never about the file.
     */
    const baked = cidFromGatewayUrl(u)
    if (baked) {
      const prefix = baked.ns === 'ipns' ? (g: string) => g.replace('/ipfs/', '/ipns/') : (g: string) => g
      const fanned = IPFS_GATEWAYS.map((g) => `${prefix(g)}${baked.cid}`)
      return { targets: [u, ...fanned.filter((t) => t !== u)], scheme: 'http+cid' }
    }
    return { targets: [u], scheme: 'http' }
  }
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
  opts: { timeoutMs?: number; maxBytes?: number; attempts?: number; budgetMs?: number } = {},
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

  /**
   * A ceiling on everything this record may cost.
   *
   * The per-attempt deadline bounds a request, not a record: attempts × targets,
   * plus the backoff between passes, let one stalling host hold a worker for
   * well over a minute — and the verdict was `inconclusive`, so the adversary
   * bought the audit's time and paid in nothing.
   */
  const deadline = Date.now() + (opts.budgetMs ?? EVIDENCE_BUDGET_MS)
  let exhausted = false

  for (let attempt = 0; attempt < attempts && !exhausted; attempt++) {
    for (const target of targets) {
      const left = deadline - Date.now()
      if (left <= 0) { exhausted = true; break }
      /**
       * The deadline bounds the request it is about to START, not merely the
       * decision to start it. A target entered with 1 ms of budget left was
       * still handed the full EVIDENCE_TIMEOUT_MS, so the "ceiling on
       * everything this record may cost" was routinely exceeded by a whole
       * timeout — per pass, per target.
       */
      const out = await fetchOnce(target, Math.min(timeoutMs, left), maxBytes)
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
      /**
       * With several targets an unusable one is a fact about that gateway, so
       * it must not survive as this URI's answer either. Refusing to RETURN it
       * was only half the guard: it was still stored as that target's last
       * word, and the final fallback could hand it back — condemning the record
       * on the strength of one bad gateway after all.
       */
      if (out.kind === 'unusable') {
        lastByTarget.set(target, { kind: 'inconclusive', note: `gateway unusable: ${out.note}`, url: target })
        stalledByTarget.add(target)
        continue
      }
      lastByTarget.set(target, out)
      // Only an answer of absence is not a stall; every unusable was handled
      // above, so what remains here is `dead` or `inconclusive`.
      if (out.kind !== 'dead') stalledByTarget.add(target)
      // A gateway that rate-limited us tells us nothing; try the next one now.
    }
    // Every target failed. Only wait if something might still change, and only
    // if the wait itself fits inside what this record is allowed to cost.
    const backoff = EVIDENCE_RETRY_DELAY_MS * (attempt + 1)
    if (attempt < attempts - 1 && Date.now() + backoff < deadline) await sleep(backoff)
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
