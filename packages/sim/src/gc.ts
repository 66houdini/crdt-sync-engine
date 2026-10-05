import type { FugueHeartbeat, FugueMax, FugueOp, SequenceCrdt } from "@crdt/core";
import type { Maintenance } from "./simulator";

/**
 * Runs FugueMax tombstone collection inside the simulator: heartbeats travel
 * over the same faulty network as ops, and every replica collects whenever it
 * hears one. Two settle rounds are enough for all replicas to reach the same
 * fully collected structure (one to learn what everyone applied, one to learn
 * that everyone knows).
 */
export function fugueGc(weight = 1.5): Maintenance<FugueOp> {
  const asFugue = (doc: SequenceCrdt<FugueOp>): FugueMax => doc as FugueMax;
  return {
    weight,
    settleRounds: 2,
    setup(replicas) {
      const members = replicas.map((doc) => doc.replicaId);
      for (const doc of replicas) asFugue(doc).enableGc(members);
    },
    emit: (doc) => asFugue(doc).heartbeat(),
    receive(doc, payload) {
      asFugue(doc).receiveHeartbeat(payload as FugueHeartbeat);
      asFugue(doc).collectGarbage();
    },
  };
}
