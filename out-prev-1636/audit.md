# Celo Agent Feedback Audit

**Scope.** ERC-8004 Reputation Registry on Celo mainnet, blocks 58396729–76096620 (2026-02-08 → 2026-08-25).

## Headline

| Measure | Value |
|---|---|
| Feedback records written | **27,520** |
| …declaring an evidence file | **10,469 (38.0%)** |
| …carrying only an attested hash, no file | 9,628 (35.0%) |
| …claiming a specific payment transaction | 94 (0.3%) |
| …whose claimed transaction exists on chain | 18 (0.1%) |
| …whose payment actually verifies | **17 (0.1%)** |
| …whose payment is also *attributable* to this reviewer and agent | **0 (0.0%)** |
| …where the reviewer demonstrably paid the agent | **0 (0.0%)** |
| …written by a Self Agent ID holder | **3,357 (12.2%)** |
| Stablecoin settlements observed between these parties | 0 |

## What the registry contains

- Feedback records: **27,520** (0 later revoked)
- Distinct agents rated: **7,743** of 9,787 registered
- Distinct reviewer addresses: **4,252**

## Evidence chain

ERC-8004 stores the evidence off-chain: the event carries a `feedbackURI` and a
`feedbackHash`, and the optional `proofOfPayment` object lives inside the file.
Each step below can fail independently, so the interesting result is where the
chain breaks.

| Step | Records | Share of all feedback |
|---|---|---|
| Declares a `feedbackURI` | 10,469 | 38.0% |
| …of which the file actually resolved | 3,710 | 13.5% |
| Declares a non-zero `feedbackHash` | 16,533 | 60.1% |
| Hash attested but no file published | 9,628 | 35.0% |
| File retrievable | 3,710 | 13.5% |
| File matches the attested hash | 1,404 | 5.1% |
| Contains a payment claim | 94 | 0.3% |
| Claimed transaction exists on chain | 18 | 0.1% |
| Payment verified — exists, succeeded, moved value | **17** | **0.1%** |
| Payment attributed — …and paid by this reviewer to this agent | **0** | **0.0%** |
| Payment cited but its parties contradict the claim | 17 | 0.1% |
| Payment declared on a chain this audit does not query | 0 | 0.0% |

> **Not a finding:** 3,240 records could not be retrieved for
> reasons that prove nothing — rate limits, timeouts, gateway outages. They are
> excluded from the dead-link count above rather than folded into it. A file
> this audit failed to reach is a question it failed to ask, not an answer.
> 3,710 retrieved files were archived content-addressed under
> `out/evidence-corpus/`, so every verdict above stays checkable after the
> originals go offline.


## Payment backing, reconstructed — not run

> The settlement sweep did not run for this window, so every figure in this section reads zero. It is not a finding. The headline above — whether a declared payment exists on chain — is verified per transaction hash and does not depend on it.

Independently of what a record declares, did this reviewer actually pay this
agent's owner, in a stablecoin, before rating it?

| | Records | Share |
|---|---|---|
| Paid the agent before reviewing it | **0** | **0.0%** |
| Paid only *after* reviewing | 0 | 0.0% |
| No payment relationship found | 27,520 | 100.0% |
| Reviewer owns the agent it reviewed | 0 | 0.0% |
| Paid **and** human-backed | 0 | 0.0% |

## Concentration

Same measures as the arXiv ERC-8004 study (2606.26028, June 2026), which covered
Ethereum, BSC and Base but not Celo — so these numbers are directly comparable
to the published ones.

- Gini over reviews per reviewer: **0.843**
- Top 10 reviewers wrote: **77.5%** of all feedback
- Reviewers who reviewed exactly once: **94.0%**
- Most feedback from a single address: **4,649**

## Temporal clustering

1925 clusters of ≥5 reviews within a 5-minute window, totalling
**19,655 records (71.4% of all feedback)** and
2,132 reviewers that never reviewed anything again.

A genuinely busy hour looks like this too. These are reported for inspection,
not labelled fraudulent.

## Method and limits

- Every figure is reproducible: `npm run audit` against any Celo RPC.
- Payment detection covers USDC, USDT and USAT — the assets the Celo x402
  facilitator settles. Payments in other assets, or routed through a contract
  rather than sent directly, are not counted, so the payment-backed rate is a
  **lower bound**.
- Agent ownership comes from ERC-721 mints and transfers on the Identity
  Registry. An agent paid at an address other than its NFT owner will not match.
- Correlation is not endorsement: a payment before a review does not prove the
  review is honest. It proves only that something was at stake, which is exactly
  what is missing today.
- **Verified is not attributed.** `PaymentVerified` says a cited transaction
  settled; it does not say the payer was the reviewer or the payee the agent.
  Anyone may cite any real transfer, so that rung is a floor, not a filter. Only
  `PaymentAttributed` — both ends confirmed — carries the strong claim, and
  only `PaymentPartyMismatch` is an accusation.
- A payment is attributed against the agent's *registered NFT owner*. An agent
  paid at an operator address it controls but does not hold the token for reads
  as unattributed, so the attributed count is a **lower bound**.
- Amounts are reported unthresholded. A verified settlement of one millionth of
  a dollar and one of five hundred dollars reach the same rung; the amount is
  published alongside so a consumer can set its own floor.
