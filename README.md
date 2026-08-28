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
and found 59–91% of reviewers showing coordinated sybil behaviour, with
manipulation costing fractions of a cent. It did not cover Celo. The measures
here are deliberately the same ones, so the results are directly comparable.

## What it reports

- **Evidence rate** — how many feedback records carry an off-chain evidence
  pointer at all, how many of those files are retrievable, hash-match what was
  attested on-chain, and contain a `proofOfPayment` that resolves to a real
  settled transfer. Each step is reported separately, because the interesting
  result is *where* the chain of evidence breaks.
- **Payment attribution** — whether a settled payment was made *by this reviewer
  to this agent*, which is a strictly stronger fact than the payment merely
  existing. Anyone can cite any real transfer on the chain, so "verified" is a
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
| `EvidenceUnreachable` | a host answered 404/410 — it asserts the file is absent | yes |
| `EvidenceInconclusive` | rate limit, timeout, every gateway busy, or beyond the sampling cap | **no** |
| `EvidenceUnhashed` | the file resolved and does not match its attested digest | yes, but see below |

`EvidenceUnhashed` says the bytes served today do not hash to what was attested.
It does **not** date the divergence and does not prove tampering: a publisher who
hashed with sha256, or whose server re-serialises the JSON or adds a BOM, fails
the check from the first day. The export therefore carries `contentSha256`
alongside the keccak digest, so a publisher can see which of the two their file
actually matches.

Evidence retrieval is bounded and re-tried rather than taken on one attempt:
each URI is tried across independent IPFS/Arweave gateways, twice, with the
deadline covering the body and not just the response headers. Responses are
capped at 1 MB (`EVIDENCE_MAX_BYTES`) and any URI resolving into private address
space is refused unfetched — `feedbackURI` is written by the party being
audited, and is treated as hostile input throughout.

## The evidence corpus

Every file the audit actually reads is stored under `out/evidence-corpus/`,
keyed by the keccak-256 of its bytes, with a manifest recording which URI served
it and when. Without it the audit's verdicts decay into the thing they accuse:
an assertion whose proof is a dead link. Set `ARCHIVE_EVIDENCE=0` to skip it.

## Choosing an RPC source — read this before a full-history run

The counter-analysis of this tool's own first full run found that
`forno.celo.org` — a load-balanced cluster — returns **inconsistent
`eth_getLogs` results for identical, immutable block ranges**: two scans of the
same dense bucket disagreed in both directions. Any single pass through it
under-counts unpredictably, with no error raised.

For anything you intend to publish, scan against an indexer-backed source
instead, which answers from a database and is deterministic:

```bash
CELO_RPC_URL=https://celo.blockscout.com/api/eth-rpc \
RPC_BATCH=0 \
CACHE_DIR=data-bs \
MAX_FILE_FETCHES=20000 \
AUDIT_WINDOW=all npm run audit
```

`RPC_BATCH=0` because that endpoint speaks single-request JSON-RPC only, and a
fresh `CACHE_DIR` so the forno-tainted cache is kept aside for comparison
rather than merged. `crosscheck.mjs` then measures the gap between the two.

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
