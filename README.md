# Celo Agent Feedback Audit

Measures how much of the ERC-8004 agent reputation on Celo mainnet is backed by
anything verifiable — and how much is a bare assertion.

ERC-8004 gives agents an on-chain reputation registry, and the standard leaves a
slot for evidence: an optional `proofOfPayment` object, carried in the off-chain
feedback file, naming the transaction that the review is about. The standard does
not require it and nothing checks it. The spec says so plainly, and puts sybil
resistance out of scope, *"expecting many players to build reputation systems"*.

This tool measures what that has produced on Celo.

The question matters here more than elsewhere, because Celo is the one chain
where the missing evidence is actually sitting next door: the Celo Core Co. x402
facilitator has settled hundreds of thousands of stablecoin payments between
agents. So rather than trusting what a review declares, this audit reconstructs
the relationship from chain state — **did this reviewer actually pay this agent
before rating it?** That question can be answered for every feedback record ever
written, including the ones that declared nothing at all.

A [June 2026 study][arxiv] measured the same registry on Ethereum, BSC and Base
through 13 May 2026 and found 59.2–90.6% of reviewers showing coordinated sybil
behaviour, with the median cost of fabricating or destroying a reputation at
\$0.055 / \$0.0042 / \$0.0027 across the three chains. It did not cover Celo.

**This audit is not a Celo replication of it, and this README used to imply it
was.** That study's sybil figure comes from a shared-first-funder funding graph
— tracing each reviewer to the address that first sent it native tokens and
clustering reviewers under a common root. Nothing here implements that, and no
sybil figure is published. Its Gini measures agents owned per wallet; the Gini
here measures reviews written per reviewer. The two are close in magnitude and
measure different things, which is worse than being far apart.

What this audit does instead is the question that study identifies and leaves
open — feedback "rarely grounded in verifiable interactions" — by reconstructing
the payment relationship from chain state for every record, including the ones
that declare nothing.

## What it reports

- **Evidence rate** — how many feedback records carry an off-chain evidence
  pointer at all, how many of those files are retrievable, hash-match what was
  attested on-chain, and contain a `proofOfPayment` that resolves to a real
  settled transfer. Each step is reported separately, because the interesting
  result is *where* the chain of evidence breaks.
- **Payment attribution** — whether a settled payment was made *by this reviewer
  to this agent*, and **how much of it actually reached the agent**. The amount
  is bounded at both ends — never more than the reviewer sent, never more than
  the agent owner received — so a transaction that moves 500 USDC between two of
  the reviewer's own addresses and one millionth of a dollar to the agent is
  reported as backing 0.000001, not 500. This is a strictly stronger fact than
  the payment merely existing. Anyone can cite any real transfer on the chain, so "verified" is a
  floor and only "attributed" is a filter. Settlements whose parties contradict
  the file that names them are reported separately again, as accusations rather
  than as confirmations.
- **Reconstructed payment backing** — for every review, whether a stablecoin
  settlement from the reviewer to the agent's owner exists, and whether it
  landed *before* the review. Payments arriving afterwards are counted
  separately: they cannot have motivated the review, and review-first-pay-later
  is what a reciprocal-rating ring looks like.
- **Concentration** — Gini over reviews per reviewer, top-10 share, share of
  addresses that reviewed exactly once.
- **Temporal clustering** — reviews arriving in tight windows from addresses
  that never appear again.
- **Identity** — how many reviewers hold a Self Agent ID, the zero-knowledge
  passport credential that makes one human worth one agent on Celo.

## Run it

```bash
npm install
npm run audit
```

Configuration is read from the environment, either inline or from an optional
`.env` file (`cp .env.example .env`). Inline wins:

```bash
AUDIT_WINDOW=30 npm run audit
CELO_RPC_URL=https://your-endpoint npm run audit
```

Writes `out/audit.md` and `out/audit.json`. Running it from a phone? See [TERMUX.md](TERMUX.md).

Defaults to full history from the registry's deployment. `AUDIT_WINDOW=30` in
`.env` scans the last 30 days instead, which finishes in a few minutes on the
free public RPC.

```bash
npm test         # analysis unit tests, no network needed (needs tsx)
npm run typecheck
```

## Published runs

**Latest:** [blocks 58,396,729–76,199,590](docs/audit-58396729-76199590-r8-ssrf-cid-datauri-c938a5c3008b50a2.md)
— 27,520 feedback records, February to August 2026, every declared evidence file
opened. Published with the rows it was found from:
[`.json`](docs/audit-58396729-76199590-r8-ssrf-cid-datauri-c938a5c3008b50a2.json) (the same
figures, machine-readable),
[`.evidence.csv`](docs/audit-58396729-76199590-r8-ssrf-cid-datauri-c938a5c3008b50a2.evidence.csv)
(20,097 rows, one per record that declares a URI or a hash — this is what the
attestation ledger is written from),
[`.claims.csv`](docs/audit-58396729-76199590-r8-ssrf-cid-datauri-c938a5c3008b50a2.claims.csv)
(the 94 payment claims) and
[`.sweep.json`](docs/audit-58396729-76199590-r8-ssrf-cid-datauri-c938a5c3008b50a2.sweep.json)
(the coverage manifest `commitSweep` publishes).

**These verdicts are now on chain.** 10,469 of those 20,097 rows were written to
[`0x86931Ae7…78a7`](https://celo.blockscout.com/address/0x86931Ae74F5cE9AA8bf818808e47102516CE78a7)
on 31 August 2026, followed by the coverage claim in
[one transaction](https://celo.blockscout.com/tx/0xff627c82a7d1ac793b7fed198966634cebd6ebd5d6189acc5baf4bb35e02ad00)
carrying `observed 27520`, `attested 10469` and the manifest's root.

The gap between those two figures is the point rather than an omission to
notice later. 9,628 rows were deliberately not written: every one of them is
`EvidenceAbsent`, which is a bijection with a predicate over the registry event
itself — `feedbackURI == "" && feedbackHash != 0`, 9,628 of 9,628 in both
directions — so a reader reconstructs the entire set from the registry with no
attester input at all. Writing them was measured at 622,994,080 gas, 50.25% of
the full backfill, to publish what anyone can already derive.

Those 9,628 records — and the 7,423 in range that declare neither a URI nor a
hash, and so never reached the export — therefore read `None` on chain, which
the contract's own documentation calls the attester saying nothing about a
record it says it looked at. The sweep is what keeps that honest: it publishes
what the indexer *saw* beside what the attester *wrote*, so the silence is
measurable rather than invisible.

Cost, verification and the one interruption are recorded in
[`deployments/backfill-celo.json`](https://github.com/BacBacta/provenance-attestations)
in the attestation repository, including the 24 records read back from the
contract and compared field by field against the `.evidence.csv` above.

Completed runs are snapshotted under [`docs/`](docs/) as
`audit-<fromBlock>-<toBlock>-<rules>-<fingerprint>.md`, with the
machine-readable result beside it.

Every part of that name is load-bearing. Two runs over different block ranges
are different measurements and must not share a filename — including a windowed
run and a full-history run that happen to end at the same head, which is why
both endpoints are there. Two runs over the same range under different retrieval
rules are also different measurements, because what counts as a dead file is a
property of how it was asked for; the rules *name* says which semantics decided
the verdicts and the *fingerprint* digests every setting that could change one.

The export travels with the report because publishing one without the other
makes the aggregate checkable only by re-running the whole audit — and `out/` is
gitignored, so it existed on exactly one machine. That was not theoretical: a
backfill on a second machine read that machine's own months-old export, which
predated the `feedbackIndex` and `observedAt` columns, and every one of its
20,097 rows was rejected.

`npm run publish-report` writes the snapshot and refuses in three cases: an
output missing its provenance fields, an `audit.md` that does not mention the
coverage root and block range its `audit.json` records — which is how a pair
from two different runs is caught — and an existing snapshot whose content
differs, because the same range under the same rules producing two different
reports is a finding about this tool, not a file to replace. A refusal writes
nothing at all.

## Checking the audit's own answers

Three of the objections this tool's counter-analysis raised are answerable from
the export alone, with no network and no key:

```bash
npm run counter-checks    # reads out/evidence.csv
```

It decomposes the negative verdicts by cause — separating files a host called
gone from files this audit merely failed to reach — counts how many reviews
lean on the same payment transaction, and lists which networks the unfound
payments actually name. It exits non-zero when a payment underwrites more than
one review.

```bash
npm run verify-parties    # needs an RPC
```

Re-reads every verified payment from a node, re-derives the agent's owner from
the Identity Registry, and prints who actually paid whom. Exits non-zero if a
published `PaymentVerified` turns out to be a settlement between parties
unrelated to the review.

```bash
CROSSCHECK_RPC=https://a-different-provider npm run crosscheck
```

Recounts the indexed events against a **second provider**. Without
`CROSSCHECK_RPC` set to a different endpoint it re-asks the audit's own node and
says so: agreement with yourself is not corroboration, and the script prints the
independence it actually achieved before printing any number.

## What a negative verdict does and does not mean

A file this audit could not retrieve is not the same as a file that is gone, and
the distinction is the difference between a finding and a failure to measure:

| Outcome | Meaning | Is it a finding? |
|---|---|---|
| `EvidenceUnreachable` | a host answered **404 or 410** — it asserts the file is absent | yes |
| `EvidenceUnreachable` | bytes came back and were **not a JSON document** — an HTML landing page, a soft-404, plain text | yes — there is no evidence file at that pointer |
| `EvidenceUnreachable` | the URI itself is unusable: unknown scheme, malformed, or pointing into private address space | yes — decided locally, no network involved |
| `EvidenceInconclusive` | rate limit, timeout, 403, 5xx, every gateway busy, oversize body, or beyond the sampling cap | **no** |
| `EvidenceUnhashed` | the file resolved and does not match its attested digest | yes, but see below |

One rung, three different failures, and they are not interchangeable. On the
full-history run they split 3,305 / 1,410 / 193 — so reading
`EvidenceUnreachable` as "404" attributes to absent hosts a third of a count
that is mostly about hosts answering with the wrong thing. `out/evidence.csv`
carries the reason per record in its `note` column; the published report prints
the split.

Of the HTTP statuses, only 404 and 410 are read as absence. A 403 from a WAF, a
401 from a gateway wanting a key, a 451 block — those mean "I will not serve you
this", not "there is nothing here", and counting them as dead links would
fabricate findings about files that are alive. A body above the cap is inconclusive for the same reason:
something is served there, we simply declined to read all of it, and a
mendacious `Content-Length` must not be able to manufacture a verdict.

`EvidenceUnhashed` says the bytes served today do not hash to what was attested.
It does **not** date the divergence and does not prove tampering: a publisher who
hashed with sha256, or whose server re-serialises the JSON or adds a BOM, fails
the check from the first day. The export therefore carries `contentSha256`
alongside the keccak digest, so a publisher can see which of the two their file
actually matches.

**A known limit:** the SSRF guard resolves the hostname and then `fetch`
resolves it again, so a DNS record with a short TTL can change between the two.
Closing that window needs a dispatcher that connects to the address the guard
approved, which Node's built-in `fetch` does not expose. The guard stops a URI
that points inside; it does not stop an adversary who controls a nameserver.

Evidence retrieval is bounded and re-tried rather than taken on one attempt:
each URI is tried across independent IPFS/Arweave gateways, twice, with the
deadline covering the body and not just the response headers. Responses are
capped at 1 MB (`EVIDENCE_MAX_BYTES`) and any URI resolving into private address
space is refused unfetched — `feedbackURI` is written by the party being
audited, and is treated as hostile input throughout.

## The coverage manifest

A completed run writes `out/sweep.json`: the block range examined, how many
feedback records the **indexer** saw in it, and how many rows were exported. The
attestation service publishes those numbers on chain so that omission becomes
falsifiable — re-index the same range, count, and compare.

`observed` deliberately comes from the indexer rather than from the export. A
coverage claim counted from the rows it is about to attest would agree with
itself by construction and prove nothing.

## The evidence corpus

Every file the audit actually reads is stored under `out/evidence-corpus/`,
keyed by the keccak-256 of its bytes, with a manifest recording which URI served
it and when. Without it the audit's verdicts decay into the thing they accuse:
an assertion whose proof is a dead link. Set `ARCHIVE_EVIDENCE=0` to skip it.

## Choosing an RPC source — read this before a full-history run

**The audit refuses to run on an endpoint that cannot answer the same immutable
question twice.** Before indexing anything it asks for the logs of one long-mined
block range, twice, and stops if the answers differ.

That check exists because the default used to fail it. Measured on 2026-08-29
over blocks 72,200,000–72,260,000 — mined months earlier, so there is exactly
one correct answer:

| source | events returned |
|---|---|
| `forno.celo.org`, first pass | 46 |
| `forno.celo.org`, second pass | 40 |
| `forno.celo.org`, third pass | 37 |
| `celo.blockscout.com/api/eth-rpc` | **77** |

Between 40% and 52% of the history silently absent, differently every time, with
no error raised anywhere. forno is a load-balanced cluster whose nodes hold
divergent log indexes; a full-history run through it reports a clean number that
is missing half its input, and the shortfall gets published as a finding about
the registry rather than about the endpoint.

So the default is now a database-backed indexer, and batching is switched off
automatically for `/api/eth-rpc` endpoints, which speak single-request JSON-RPC:

```bash
npm run audit                                    # uses the indexer by default
CELO_RPC_URL=https://your-node npm run audit     # anything else must pass the check
```

The check cannot prove an endpoint complete — an indexer that is consistently
wrong passes it — which is why `npm run crosscheck` against a second provider
still matters. It only catches the endpoint that disagrees with itself, and that
turned out to be the one everybody reaches for first.

`SKIP_DETERMINISM_CHECK=1` exists solely to reproduce a known-bad run on purpose.


## Method

**Indexing is inverted.** The obvious approach — index every stablecoin transfer
on Celo, then look for matches — is not runnable on a laptop, because USDT alone
moves millions of transfers. But the feedback side is small: tens of thousands of
records written by a few thousand distinct addresses. So the tool collects those
addresses first and asks the node only for transfers whose indexed `from` is one
of them. `eth_getLogs` accepts an array of values per indexed topic, so this
costs a few hundred requests instead of a chain-wide scan — and the result is
exact rather than sampled.

**Event signatures are read, not guessed.** `NewFeedback` is decoded from the
signature published by the verified implementation contract. Agent ownership
comes from ERC-721 mints and transfers on the Identity Registry rather than a
custom event, which keeps it working across registry upgrades.

**Block ranges self-tune.** Public RPCs cap `eth_getLogs` differently and rarely
document it, so the indexer halves its range on rejection and creeps back up on
success, converging on whatever the endpoint allows.

## Contracts

Verified live on Celo mainnet (chainId 42220) on 2026-08-25:

| Contract | Address |
|---|---|
| ERC-8004 Reputation Registry | [`0x8004BAa1…9b63`](https://celo.blockscout.com/address/0x8004BAa17C55a88189AE136b182e5fdA19dE9b63) |
| ERC-8004 Identity Registry | [`0x8004A169…a432`](https://celo.blockscout.com/address/0x8004A169FB4a3325136EB29fA0ceB6D2e539a432) |
| Self Agent ID Registry | [`0xaC3DF9AB…5944`](https://celo.blockscout.com/address/0xaC3DF9ABf80d0F5c020C06B04Cced27763355944) |
| x402 facilitator signer | [`0x0d74D5Ce…FB48`](https://celo.blockscout.com/address/0x0d74D5Cefd2e7F24E623330ebE3d8D4cB45fFB48) |
| Provenance attestations (this audit's verdicts, v5.0.0) | [`0x86931Ae7…78a7`](https://celo.blockscout.com/address/0x86931Ae74F5cE9AA8bf818808e47102516CE78a7) |
| USDC / USDT / USAT | settlement assets, all EIP-3009 |

## Limits

Stated plainly, because a measurement whose limits are hidden is not a
measurement.

- Payment detection covers USDC, USDT and USAT — the assets the Celo facilitator
  settles. Payments in other assets, or routed through a contract rather than
  sent directly to the owner, are not counted. **The payment-backed rate is
  therefore a lower bound.**
- Agent ownership is the Identity Registry NFT holder. An agent that receives
  funds at a different address than its NFT owner will not match.
- Fetching evidence files is capped (`MAX_FILE_FETCHES`) and depends on those
  files still being hosted. A file that 404s today may have existed when the
  review was written.
- Temporal clustering flags patterns, it does not prove intent. A genuinely busy
  hour looks the same. Clusters are reported for inspection, never labelled
  fraudulent.
- **Correlation is not endorsement.** A payment preceding a review does not make
  the review honest. It only means something was at stake — which is precisely
  what is absent today.

## Licence

MIT.

[arxiv]: https://arxiv.org/abs/2606.26028
