# crdt-sync-engine

From-scratch CRDT sync engine in TypeScript: LWW register/map → RGA baseline → FugueMax sequence CRDT,
relayed through a Cloudflare Durable Object, verified with a deterministic seeded network simulator.

## Layout

| Path | Purpose |
| --- | --- |
| `packages/crdt-core` | Pure TS CRDTs. No DOM / Node / Cloudflare deps (enforced via `lib: ["ES2022"]`, `types: []`). |
| `packages/sim` | Deterministic, seeded, in-process network simulator. Depends only on `crdt-core`. |
| `apps/relay-worker` | Cloudflare Worker + SQLite-backed `DocumentDO` (WebSocket Hibernation API). |
| `apps/demo-client` | Minimal sanity-check client. |

## Commands

```bash
pnpm install
pnpm test        # vitest across all packages
pnpm typecheck   # tsc --noEmit across all packages
pnpm demo:lww -- --seed 42   # 3 replicas, random writes + gossip, asserts convergence
```

No global pnpm? `corepack pnpm <cmd>` works (the version is pinned via `packageManager`).

## Determinism rule

`crdt-core/src` and `sim/src` may not read clocks, use ambient randomness, or schedule timers.
All randomness goes through an explicitly passed `Prng` (mulberry32). `crdt-core/test/determinism-guard.test.ts`
scans both source trees and fails the build on `Math.random`, `Date.now`/`new Date`, `performance.now`,
`crypto.getRandomValues`/`randomUUID`, `process.hrtime`, or `setTimeout`/`setInterval`.
