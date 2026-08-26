import { createPublicClient, http, parseAbiItem } from 'viem'
import { celo } from 'viem/chains'

const REG = '0x8004BAa17C55a88189AE136b182e5fdA19dE9b63'
const EV = parseAbiItem('event NewFeedback(uint256 indexed agentId, address indexed clientAddress, uint64 feedbackIndex, int128 value, uint8 valueDecimals, string indexed indexedTag1, string tag1, string tag2, string endpoint, string feedbackURI, bytes32 feedbackHash)')
const ZERO = '0x' + '0'.repeat(64)

const c = createPublicClient({ chain: celo, transport: http(process.env.CELO_RPC_URL || 'https://forno.celo.org') })
const head = await c.getBlockNumber()
const from = head - 604800n

const logs = []
for (let b = from; b <= head; b += 5000n) {
  const to = b + 4999n > head ? head : b + 4999n
  logs.push(...(await c.getLogs({ address: REG, event: EV, fromBlock: b, toBlock: to })))
  process.stdout.write(`\rscanning ${logs.length} records`)
}
console.log('\n')

const withURI = logs.filter((l) => (l.args.feedbackURI || '').trim().length > 0)
const withHash = logs.filter((l) => l.args.feedbackHash !== ZERO)

console.log(`records                    ${logs.length}`)
console.log(`with a feedbackURI         ${withURI.length}`)
console.log(`with non-zero feedbackHash ${withHash.length}`)
console.log(`hash but no URI            ${logs.filter((l) => l.args.feedbackHash !== ZERO && !(l.args.feedbackURI || '').trim()).length}`)
console.log('\nfirst 3 raw records:')
for (const l of logs.slice(0, 3)) {
  console.log(JSON.stringify({
    agent: String(l.args.agentId),
    reviewer: l.args.clientAddress,
    value: String(l.args.value),
    tag1: l.args.tag1,
    endpoint: l.args.endpoint,
    feedbackURI: l.args.feedbackURI,
    feedbackHash: l.args.feedbackHash,
  }, null, 2))
}
