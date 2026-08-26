# Running the audit on Termux (Android)

It works. The whole tool is pure JavaScript once built — `viem` and `typescript`
have no native dependencies — so nothing needs to compile against Android.

## Setup

```bash
pkg update && pkg upgrade
pkg install nodejs git
node --version        # want v20 or newer
```

Then get the code and install:

```bash
git clone <your-repo-url> celo-agent-feedback-audit
cd celo-agent-feedback-audit
npm install
```

If you copied a zip onto the phone instead of cloning:

```bash
pkg install unzip
termux-setup-storage                     # grants access to /sdcard, one-time
unzip ~/storage/downloads/celo-agent-feedback-audit.zip
cd celo-agent-feedback-audit && npm install
```

## Run

```bash
AUDIT_WINDOW=7 npm run audit
```

`npm run audit` compiles to plain JS with `tsc`, then runs `node dist/main.js`.
It does **not** need `tsx` — that's listed as an optional dependency precisely so
that if esbuild has no binary for your device, `npm install` still succeeds and
the audit still runs.

Results land in `out/audit.md` and `out/audit.json`.

```bash
cat out/audit.md
cp out/audit.* ~/storage/downloads/    # to reach them from the Files app
```

## Start small, then widen

Do a 7-day window first. It finishes in a few minutes and proves the RPC,
the decoding and the report all work on your device before you commit to a
long run.

```bash
AUDIT_WINDOW=7 npm run audit      # minutes
AUDIT_WINDOW=30 npm run audit     # tens of minutes
AUDIT_WINDOW=all npm run audit    # hours on the public RPC
```

The full-history run is the one worth publishing, but do it last.

## Surviving a long run

Android aggressively suspends background apps, and a throttled CPU will stall
the run rather than kill it — which looks like a hang.

```bash
pkg install termux-api tmux
termux-wake-lock          # keeps the CPU awake
tmux new -s audit         # detach with Ctrl-b then d, reattach with: tmux attach -t audit
AUDIT_WINDOW=all npm run audit
```

Also: disable battery optimisation for Termux in Android settings, and keep the
phone on a charger. Run it on Wi-Fi — a full-history audit is tens of thousands
of RPC requests.

When you're done: `termux-wake-unlock`.

## Use your own RPC endpoint

The public `forno.celo.org` is rate-limited, which is the single biggest reason
a long run drags. A free Alchemy, Ankr or QuickNode key makes a large difference:

```bash
cp .env.example .env
nano .env      # set CELO_RPC_URL=https://...
```

The indexer already backs off and halves its block range when an endpoint pushes
back, so throttling slows the run down rather than breaking it — but a dedicated
endpoint is worth the two minutes it takes to get one.

## If memory gets tight

A full-history run holds the feedback set and the matched settlements in memory.
On a phone with limited RAM:

```bash
node --max-old-space-size=1536 dist/main.js
```

Or just run it in windows — `AUDIT_WINDOW=30` at a time — and combine the JSON
outputs afterwards.

## Known Termux quirks

- `npm test` needs `tsx`, which needs an esbuild binary for your architecture.
  If it isn't available, skip it — the tests are for CI and desktop; the audit
  itself doesn't use tsx.
- If `npm install` fails on a native optional dependency, `npm install
  --omit=optional` gets you a working install.
- Termux's Node comes from its own repos, not nvm. Don't install nvm here.
