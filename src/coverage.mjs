/**
 * Record keys and the coverage tree, shared by the audit and the attestation
 * service.
 *
 * This file exists in two repositories and must stay byte-for-byte identical:
 * the audit computes the root over the records it OBSERVED, the attestation
 * service publishes it on chain, and a third party rebuilds it from the
 * registry. Three parties computing the same root from three implementations is
 * how a coverage claim quietly stops meaning anything.
 */
import { keccak256, encodeAbiParameters } from 'viem'

/**
 * The contract's own storage key for a record, computed off chain.
 *
 * Identical to `key(...)` in Solidity — keccak256 of the abi-encoded tuple — so
 * a leaf in the coverage tree is the same value the ledger indexes by, and a
 * proof needs no translation.
 */
export function recordKey(agentId, clientAddress, feedbackIndex) {
  const addr = String(clientAddress).trim().toLowerCase()
  if (!/^0x[0-9a-f]{40}$/.test(addr)) {
    throw new Error(`recordKey: not an address: ${JSON.stringify(clientAddress)}`)
  }
  // Lowercased on the way in. The key is a function of the address BYTES, and
  // viem rejects a mixed-case address whose checksum does not match — so a
  // correctly-spelled uppercase address would throw here while the identical
  // account in lowercase sailed through, making the leaf depend on spelling.
  return keccak256(encodeAbiParameters(
    [{ type: 'uint256' }, { type: 'address' }, { type: 'uint64' }],
    [BigInt(agentId), addr, BigInt(feedbackIndex)],
  ))
}

/**
 * Merkle root over the records a sweep covered.
 *
 * Leaves are the contract's keys, sorted, and each pair is hashed in sorted
 * order — the layout OpenZeppelin's MerkleProof verifies, so a third party
 * needs no bespoke verifier to prove a record was in scope. Sorting makes the
 * root depend on the SET rather than on the order the attester happened to
 * process it in, which is the only thing that should determine it.
 *
 * An odd node is carried up unchanged rather than duplicated: duplicating a
 * leaf lets one record masquerade as two in a proof.
 */
export function merkleRoot(keys) {
  const ZERO = '0x' + '00'.repeat(32)
  if (!keys.length) return ZERO
  let level = [...new Set(keys)].sort()
  while (level.length > 1) {
    const next = []
    for (let i = 0; i < level.length; i += 2) {
      if (i + 1 === level.length) { next.push(level[i]); continue }
      const [a, b] = level[i] < level[i + 1] ? [level[i], level[i + 1]] : [level[i + 1], level[i]]
      next.push(keccak256('0x' + a.slice(2) + b.slice(2)))
    }
    level = next
  }
  return level[0]
}
