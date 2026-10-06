# Building a CRDT sync engine: what the tests taught

This repository is a collaborative-text engine built from scratch: a FugueMax sequence CRDT,
a Cloudflare Durable Object that relays it over WebSockets, and a deterministic simulator
that stands in for the network. It was built against a written brief, with Claude Code doing
the implementation. The code is in the README's tour; this note is about the five places
where the plan turned out to be wrong, and how each was caught.

The common thread: every one of them was found by a test that could fail, and none by
reading the code.

## 1. The brief was wrong about the one rule it said to get exactly right

The brief described FugueMax's defining rule as: when two characters are inserted
concurrently at the same place, the one with the *maximum* id goes first, and added that
this is "the part people get subtly wrong".

It is, and the brief had it wrong too. In the paper (Weidner, Gentle and Kleppmann, *The Art
of the Fugue*), siblings with the same origins are ordered by the *lower* id. "Max" stands
for *maximally non-interleaving*. What actually distinguishes FugueMax from plain Fugue is a
second rule: right-side siblings are ordered by the reverse order of their right origins.

Reading the paper is what found this, but tests are what made it safe to act on. The
implementation is checked against a deliberately naive transcription of the paper's
pseudocode: both must produce identical operations and identical text at every step,
including in concurrent states. With that in place, the brief's rule could be tried as a
one-line change. Seven tests failed, among them the paper's own Figures 6 and 7.

Plain Fugue, the other tempting simplification, was harder to catch. Uniformly random
histories almost never produce siblings whose right origins differ, so the random tests
passed. It took a generator built specifically to create that situation.

## 2. The textbook anomaly only happens in one direction

The plan was to show the classic interleaving anomaly: two people type "the" and "fox" at
the same spot, the RGA baseline garbles them, FugueMax does not.

RGA does not garble them. Typed left to right, each word forms its own chain and stays
intact. RGA interleaves only when text is typed right to left, every character inserted at
the same position, which gives all six characters the same origin: `>ftohxe`. That is what
the original anomaly paper says, on a careful reading.

The test now asserts all four cells: RGA garbles backward typing, FugueMax does not, and
both leave forward typing alone. A demo that only showed the failing cell would have been
true but misleading about when the problem occurs.

## 3. "Wait until everyone has seen the delete" is not enough

Deleted characters stay in the structure as tombstones. The standard rule for removing one
is causal stability: wait until every replica has applied the delete, so no concurrent
operation can still refer to the character.

In Fugue that is insufficient. An insert attaches to the next element *including
tombstones*, so a replica that has already seen the delete keeps creating references to the
tombstone for as long as it holds it. Replicas learn about stability at different times, so
one can remove a tombstone that another is about to attach something to.

The fix is two phases: stop referencing a tombstone once its delete is stable, and remove it
only once every replica is known to have stopped. Tombstones that still have something
attached stay as structure.

The simple rule was kept as a planted bug. The test that catches it runs random schedules
against shadow replicas that never collect anything, and requires identical text at every
step.

## 4. The property tests were running on toy inputs

The garbage-collection property passed with the unsafe rule planted. The cause was not the
property. `fast-check` caps generated arrays at roughly ten elements by default, whatever
`maxLength` says. Every property test in the project, written to explore scenarios of 80 to
150 steps, had been exploring scenarios of about ten.

The earlier tests had passed their mutation checks on those short inputs, which is why
nothing looked wrong. Garbage collection needs a delete, full delivery, and two rounds of
gossip before anything happens, and ten steps never got there. After setting the size
explicitly, the same property caught four of five planted bugs; the fifth needed a
hand-built three-way race.

This is the argument for mutation-checking tests rather than trusting that they pass. A
property that cannot fail looks exactly like one that holds.

## 5. The performance problem that was not there

Rebuilding the 182,000-element benchmark document took 250 to 400 ms on a laptop. The brief
gave a CPU budget of about 10 ms per invocation. On paper that limits a document to a few
thousand characters, and the obvious response was to redesign the relay so that waking up
never rebuilds the document.

Before doing that, the relay was deployed and measured using Cloudflare's own CPU figures.
Waking a 100,000-element document cost 176 ms of CPU and succeeded. So did a 203 ms
compaction. Nothing was terminated. The cost is linear, about 1.7 µs per element, and at
these sizes it is simply not a problem.

A cheaper version of the redesign was built afterwards anyway: connecting and reading are
now served straight from the stored snapshot and log, and only the first write after a wake
rebuilds the document. But it was built knowing what it was worth, not on a guess.

## What held up

- **Determinism as a rule, enforced.** The core and the simulator never read a clock or use
  ambient randomness, and a test scans the source to keep it that way. Every simulated
  failure is a seed, and a seed replays byte for byte.
- **Acknowledge only what is durable.** The relay batches writes, so it tells a client its
  edit is safe only after the batch is on disk. Clients resend the rest. A relay that dies
  with edits in memory leaves its flush alarm behind, which the next instance treats as
  evidence of loss and announces.
- **Size.** On 259,778 real keystrokes the saved document is 193 kB for 105 kB of text. The
  tree metadata is 60% of the text size, matching the paper. A further 24% is the ids of
  delete operations, kept because garbage collection needs them.

## Limits worth stating

The relay is open and unauthenticated, protected by rate limits and size caps rather than
identity. A relay crash can lose up to two seconds of edits whose author is no longer
connected. Garbage collection assumes a fixed set of replicas. Text is one operation per
character, with no formatting and no undo.
