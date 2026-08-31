/** Types for the shared coverage module; the implementation is plain JS so the
 *  attestation service and any third party can run it without a build step. */
export declare function recordKey(agentId: bigint | number | string, clientAddress: string, feedbackIndex: bigint | number | string): string
export declare function merkleRoot(keys: string[]): string
