# crdt-sync-engine

A from-scratch CRDT sync engine in TypeScript: last-write-wins registers and maps, an RGA
baseline, and a FugueMax sequence CRDT for collaborative text, relayed through a Cloudflare
Durable Object over WebSockets. Correctness is established by property tests, differential
tests against the published algorithm, and a deterministic, seeded network simulator rather
than by manual testing.

This is an engine, not a product: no auth, no UI framework, one bare CLI client.

## Layout

| Path | What it is |
| --- | --- |
| `packages/crdt-core` | Pure TypeScript CRDTs: `LWWRegister`, `LWWMap`, `RGA`, `FugueMax`, plus a seeded PRNG and a compact binary codec. No DOM, Node or Cloudflare dependencies (its sources compile with `lib: ["ES2022"]`, `types: []`). |
| `packages/sim` | Deterministic in-process network simulator and convergence fuzzer. Depends only on `crdt-core`. |
| `apps/relay-worker` | Cloudflare Worker and `DocumentDO`, a SQLite-backed Durable Object using the WebSocket Hibernation API. |
| `apps/demo-client` | A small CLI client and a scripted end-to-end smoke test. |

## Commands

```bash
pnpm install
pnpm typecheck
pnpm test                      # unit, property and relay tests (the relay tests run inside workerd)
pnpm sim --seed 12345          # replay one simulation exactly; add --trace for every event
pnpm sim:fuzz                  # 2000 seeds; prints the failing seed and exits 1 on a violation
pnpm sim:fuzz --gc             # the same with tombstone garbage collection running
pnpm demo:lww --seed 42        # LWW acceptance demo
pnpm bench:fetch && pnpm bench # download the editing trace, then benchmark
```

No global pnpm? Use `corepack pnpm <cmd>`; the version is pinned through `packageManager`.
(Corepack 0.30, bundled with some Node 22 releases, fails a signature check; set
`COREPACK_INTEGRITY_KEYS=0` or update corepack.)

To try the relay by hand:

```bash
pnpm --filter @crdt/relay-worker dev                                   # terminal 1
pnpm --filter @crdt/demo-client start --doc demo --replica alice    # terminal 2
pnpm --filter @crdt/demo-client start --doc demo --replica bob      # terminal 3
pnpm --filter @crdt/demo-client smoke                                  # or the scripted check
```

In the CLI: `a <text>` appends, `i <index> <text>` inserts, `d <index> [count]` deletes,
`drop` kills the connection (edits continue offline), `connect` reconnects and reconciles.

## Determinism rule

`crdt-core/src` and `sim/src` never read a clock, use ambient randomness, or schedule a
timer. All randomness comes from one explicitly passed `Prng` (mulberry32), so a simulation
is a pure function of its seed. `crdt-core/test/determinism-guard.test.ts` scans both source
trees and fails on `Math.random`, `Date.now` / `new Date`, `performance.now`, `crypto`
randomness, `process.hrtime` and timers.

## The CRDTs

**LWW register and map.** A write is `(value, timestamp, replicaId)`; the higher timestamp
wins and ties go to the higher replica id, compared by code unit (never `localeCompare`,
which is locale-dependent). The map keeps one register per key; a delete is a stamped
tombstone, so it competes with concurrent writes by the same rule. Both are immutable and
serialize canonically. Property tests check commutativity, associativity, idempotence and
convergence to the highest-stamped write.

**RGA** (`rga.ts`) is the baseline: insert-after-origin with Lamport-stamped ids. It is
deliberately simple (a flat array) and exists to be the "before" in the interleaving tests.

**FugueMax** (`fugue.ts`) follows Weidner, Gentle and Kleppmann, *The Art of the Fugue:
Minimizing Interleaving in Collaborative Text Editing* (arXiv:2305.00583), Algorithm 1 with
the Section IV-C modifications:

- Each element is a left or right child of its parent; the text is the in-order walk.
- `insert(i, x)`: if the element at `i-1` has no right children, the new element becomes its
  right child; otherwise it becomes a left child of the next element (tombstones included).
- Left-side siblings are ordered by ascending id.
- Right-side siblings are ordered by the reverse list order of their right origins, with ties
  broken by ascending id. This is what distinguishes FugueMax from plain Fugue.

> **A correction to the original brief.** The brief described the FugueMax rule as "the
> maximum id appears first". The paper says otherwise: among siblings with the same origins
> the *lower* id comes first (Definition 4, condition 3), and "Max" stands for *maximally
> non-interleaving*. This implementation follows the paper. A test mutant implementing the
> "max id first" rule fails seven tests, including the paper's own Figures 6 and 7.

The paper assumes causal broadcast. `FugueMax` provides it itself: every op carries a dot
`(replicaId, counter)`, an op is applied only after its predecessor from the same replica
and every element it references, earlier arrivals are buffered and duplicates dropped. So
`applyRemoteOp` is safe under arbitrary reordering and duplication.

The list order is also kept as a linked list of chunks, so index lookups do not walk the
tree (which is a linear chain for ordinary typing). Nothing recurses.

### How FugueMax is tested

- **Differential tests against the paper.** `test/fugue-reference.ts` is a deliberately naive
  transcription of the pseudocode. The real implementation must generate identical ops and
  identical text at every step, including in concurrent states, and reach the same final order.
- **The paper's Figures 6 and 7** as explicit cases, plus randomized Figure-7-style histories
  built so that id order and right-origin order disagree.
- **Convergence** under random concurrent edits with reordering and duplication.
- **Non-interleaving** as an executable property: random concurrent multi-character runs at
  the same position, typed forward, backward or with the cursor jumping around, must each
  stay contiguous on every replica.
- **Mutation checks.** Each of these was confirmed to fail when a specific bug is planted
  (plain Fugue ordering, max-id-first, reversed origin order, misplaced subtrees, and so on).

## Interleaving anomaly: RGA versus FugueMax

`packages/sim/test/interleaving-anomaly.test.ts` reconstructs the scenario from Kleppmann,
Gomes, Mulligan and Beresford, *Interleaving anomalies in collaborative text editors* (PaPoC
2019): two replicas concurrently insert "the" and "fox" at the same position.

| Typing direction | RGA | FugueMax |
| --- | --- | --- |
| backward (every character inserted at the same index) | `>ftohxe` (garbled, asserted) | `>thefox` (intact, asserted) |
| forward (ordinary left-to-right typing) | `>foxthe` (intact) | `>thefox` (intact) |

> **A second correction to the brief.** The brief expected RGA to garble two words inserted
> at the same position. For ordinary forward typing it does not: each word forms its own
> chain of origins. RGA's anomaly is specific to backward insertion, which is what that
> paper shows. Both directions are asserted here, so the test proves the anomaly is present
> where it really occurs and that FugueMax removes it.

## Simulator

`runSimulation(factory, rng, options)` runs N replicas in-process against a simulated
network. One PRNG decides everything: who acts, what they type, which message is delivered
next, what is duplicated, who is partitioned and for how long.

- **Reordering:** the next delivery is a uniformly random in-flight message.
- **Duplication:** a message may be delivered and left in flight to arrive again.
- **Partition and heal:** a replica stops receiving for a random window, keeps editing, then
  catches up on everything queued, in random order.

`assertConverged` is the single strong-eventual-consistency assertion used everywhere: no
op left buffered, identical text, byte-identical serialized structure.

`pnpm sim --seed N` output is byte-for-byte reproducible. `pnpm sim:fuzz` runs 2000 seeds
(about 250,000 inserts and 800,000 deliveries, of which roughly 580,000 arrive out of order
and 59,000 are duplicates) and prints the failing seed on a violation. The simulator's own
tests confirm that it catches a non-convergent list and a non-idempotent CRDT, and planted
bugs in FugueMax were found within the first two seeds and reproduced from the printed seed.

CI (`.github/workflows/ci.yml`) runs typecheck, all tests, the FugueMax fuzz, the fuzz with
garbage collection, the RGA fuzz and a worker bundle check on every push.

## Relay (`DocumentDO`)

One Durable Object per document, addressed by `idFromName(documentId)`.

- **Hibernation.** Uses `ctx.acceptWebSocket` and the `webSocketMessage` / `webSocketClose` /
  `webSocketError` handlers. Each socket's replica id lives in its attachment, and the
  document is rebuilt from SQLite in the constructor inside `blockConcurrencyWhile`.
- **Batched persistence.** Ops are applied and broadcast immediately but written as one row
  per flush, driven by an alarm two seconds after the first buffered op. A burst of typing
  costs two row writes (the alarm and the batch), not one per keystroke.
- **Acks follow durability.** A client's op is acknowledged only once it is in SQLite.
  Clients keep unacknowledged ops and resend them after reconnecting; resends are harmless
  because ops are idempotent.
- **Reconnects.** Every accepted op gets a per-document sequence number. A returning client
  sends the last durable sequence number it saw and receives just the ops after it; a new
  client, or one that has fallen behind the retained log, receives a snapshot in the compact
  binary encoding.
- **Lost buffers are detected.** If an instance dies with ops still in memory, its flush
  alarm is left behind. The next instance sees an alarm it did not schedule, bumps the
  document epoch and tells every client to resync from the snapshot and resend. Ops that
  only ever existed in the lost buffer and on other clients are dropped on purpose, so no
  client keeps state the relay cannot reproduce.
- **Validation.** Op shape, ownership of the op id by the connection's replica,
  deliverability, and frame size are all checked before an op is applied.
- **Snapshots and compaction.** Every 5000 ops the log is folded into a binary snapshot and
  trimmed to a 1000-op tail, so storage grows with the document rather than its history. If
  an R2 bucket is bound as `SNAPSHOT_ARCHIVE`, the replaced snapshot and the dropped log rows
  are copied there first. The binding is commented out in `wrangler.toml` because R2 must be
  enabled on the account; without it, compacted data is discarded.

The relay tests run inside workerd through `@cloudflare/vitest-pool-workers` and force real
evictions with `evictDurableObject`, covering hibernation, the lost-buffer path, compaction,
R2 archival and both reconnect paths.

## Tombstone garbage collection

`FugueMax.enableGc(members)` turns on physical removal of tombstones for a fixed set of
replicas, driven by `heartbeat()` / `receiveHeartbeat()` / `collectGarbage()`.

A tombstone cannot be removed just because it was deleted. A replica that has not yet seen
the delete may be inserting next to that element right now, and its op can arrive
arbitrarily late; with the element gone there would be nowhere to put it. So nothing is
removed before the delete is causally stable, meaning every member is known to have applied
it. That is what the per-replica version vectors track.

In Fugue that is still not sufficient, and this was the main design finding of this
milestone: an insert takes the next element *including tombstones* as its right origin and
may become its left child, so a replica that has seen the delete keeps creating references
to the tombstone. Removal therefore takes two phases:

1. **Condemn.** Once a replica's own stable cut covers the delete, it stops referencing the
   tombstone in new inserts.
2. **Remove.** A replica removes the tombstone once it knows every member has condemned it
   and has applied every op that member issued before doing so. A tombstone that still has
   children, or is still some element's right origin, stays as structure until those go too.

The longer explanation is in the comment above the GC section of `fugue.ts`. Random-schedule
tests compare collecting replicas against shadow replicas that never collect, and removing
on causal stability alone (the simpler rule) is one of the planted bugs they catch.

Limits: membership is fixed and explicit, and a new replica must join by state transfer.
The relay does not use this (its clients come and go); it bounds storage by compaction instead.

## Benchmark

`pnpm bench` replays the real-world editing trace from Kevin Jahns's `crdt-benchmarks` (the
keystroke history of a LaTeX paper, © Martin Kleppmann, fetched on demand and not committed):
259,778 single-character ops (182,315 inserts, 77,463 deletes) producing a 104,852-character
document. The replay reproduces the trace's final text exactly.

Measured on one Windows 11 laptop, Node 22.13, median of 7 runs after 2 warm-ups:

| | This implementation | Paper: Fugue (optimized) | Paper: FugueMax Simple |
| --- | --- | --- | --- |
| Saved document | 193.0 kB | 168 kB | 1,237 kB |
| CRDT metadata relative to the 105 kB text | 84% (88.2 kB) | 60% | about 1080% |
| Local edits | about 320,000 ops/s | 94,000 ops/s | 16,000 ops/s |
| Remote ops applied | about 750,000 ops/s | not reported separately | not reported separately |

Paper figures are from its Tables II and III, measured on different hardware (a 4-core i7 at
1.9 GHz, Node 18), so only the sizes are directly comparable. One of four runs here measured
171,000 local ops/s while the machine was busy; treat the throughput as approximate.

**Does it land in the paper's range?** Yes for the tree itself, and slightly above overall,
for a specific reason. The 88.2 kB of metadata breaks down as:

| Section | Size |
| --- | --- |
| Tree structure (ids, parents, sides, right origins) in 10,824 runs | 58.6 kB |
| Tombstone flags | 3.8 kB |
| Ids of the delete operations | 25.7 kB |

Structure plus flags is 62.4 kB, which is 60% of the text and matches the paper's figure.
The remaining 25.7 kB is the id of each delete op, which the paper's implementation does not
store. This implementation keeps them because garbage collection needs to know which delete
made an element a tombstone in order to decide when that delete is stable. Without GC they
could be dropped and the saved size would be about 167 kB.

The encoding gets there by storing runs of ordinary typing once, encoding parent and right
origin references as positions relative to the run (the common cases take no bytes), and
keeping text, tombstone flags and delete ids in separate run-length-encoded streams. Deleted
characters are not stored at all. For comparison the JSON form of the same state is 22 MB.

## Known limits

- **Free-tier CPU.** Rebuilding the 182,000-element benchmark document from its snapshot
  takes 250 to 400 ms on the laptop above, roughly 1.5 to 2 µs per element (tombstones
  included). If the 10 ms per-invocation CPU budget applies to a cold start, that bounds a
  document at a few thousand elements. This has not been measured on Cloudflare, and local
  workerd does not enforce CPU limits. A lazily loaded or chunked document would lift it.
- **Not deployed.** Everything was verified locally and in CI: unit and property tests, the
  relay tests in workerd, the fuzzers, and (locally only) an end-to-end run of the demo
  client against `wrangler dev`. Nothing has been deployed to a Cloudflare account.
- **Hard relay crashes.** Ops that were broadcast but not yet flushed (at most two seconds'
  worth) survive only if their author is still connected to resend them. A local op that
  depended on such a lost op from someone else is dropped during resync.
- **One writer per replica id.** A second connection with the same replica id replaces the
  first. Two live processes sharing an id would issue conflicting op ids.
- **Characters, not rich text.** One op per character; no formatting, no cursors, no undo.
