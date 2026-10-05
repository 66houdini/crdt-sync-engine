/**
 * Scripted end-to-end check against a running relay (`pnpm --filter @crdt/relay-worker dev`):
 * two clients type concurrently, one is cut off mid-edit and keeps typing, then
 * reconnects; both must converge with each other and with the relay.
 *
 *   pnpm --filter @crdt/demo-client smoke [-- --url ws://127.0.0.1:8787]
 */
import { Connection, parseArgs } from "./connection";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function until(condition: () => boolean | Promise<boolean>, label: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (await condition()) return;
    await sleep(50);
  }
  throw new Error(`timed out waiting for: ${label}`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2), { url: "ws://127.0.0.1:8787", doc: `smoke-${Date.now()}` });
  const url = args.url as string;
  const doc = args.doc as string;
  const relayText = async (): Promise<string> =>
    (await fetch(`${url.replace(/^ws/, "http")}/doc/${doc}/text`)).text();

  const alice = new Connection(url, doc, "alice");
  const bob = new Connection(url, doc, "bob");
  await Promise.all([alice.connect(), bob.connect()]);

  console.log("1. concurrent typing at the same position");
  alice.insert(0, "the quick ");
  bob.insert(0, "brown fox ");
  await until(() => alice.session.text.length === 20 && bob.session.text.length === 20, "both have 20 chars");
  console.log(`   alice: ${JSON.stringify(alice.session.text)}\n   bob:   ${JSON.stringify(bob.session.text)}`);
  if (alice.session.text !== bob.session.text) throw new Error("diverged after concurrent typing");
  if (!alice.session.text.includes("the quick ") || !alice.session.text.includes("brown fox ")) {
    throw new Error("concurrent words were interleaved");
  }

  console.log("2. bob's connection is killed mid-edit; both keep typing");
  bob.insert(bob.session.text.length, "jum");
  bob.drop();
  bob.insert(bob.session.text.length, "ps");
  alice.insert(0, ">> ");
  alice.delete(1);
  await sleep(300);
  console.log(`   alice: ${JSON.stringify(alice.session.text)}\n   bob:   ${JSON.stringify(bob.session.text)} (offline, ${bob.session.unackedCount} unacked)`);

  console.log("3. bob reconnects");
  await bob.connect();
  await until(() => alice.session.text === bob.session.text && bob.session.text.endsWith("jumps") && bob.session.text.startsWith("> "), "converged after reconnect");
  await until(() => alice.session.unackedCount === 0 && bob.session.unackedCount === 0, "all ops acked as durable");
  const server = await relayText();
  console.log(`   alice: ${JSON.stringify(alice.session.text)}\n   bob:   ${JSON.stringify(bob.session.text)}\n   relay: ${JSON.stringify(server)}`);
  if (server !== alice.session.text) throw new Error("relay text differs from clients");

  alice.drop();
  bob.drop();
  console.log("OK: clients and relay converged");
}

main().then(
  () => process.exit(0),
  (err: unknown) => {
    console.error(`FAIL: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  },
);
