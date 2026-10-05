/**
 * Minimal interactive client for the relay. A sanity-check tool, not a product.
 *
 *   pnpm --filter @crdt/demo-client start --doc demo --replica alice [--url ws://127.0.0.1:8787]
 *
 * Run it twice with different --replica values, type in both, `drop` one
 * mid-edit, keep typing, then `connect` and watch the two reconcile.
 */
import { createInterface } from "node:readline";
import { Connection, parseArgs } from "./connection";

const HELP = `commands:
  a <text>            append text
  i <index> <text>    insert text at index
  d <index> [count]   delete count characters at index
  p                   print the document
  drop                kill the connection (edits continue offline)
  connect             reconnect and reconcile
  q                   quit`;

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2), {
    url: "ws://127.0.0.1:8787",
    doc: "demo",
    replica: `cli-${process.pid}`,
  });
  const conn = new Connection(args.url as string, args.doc as string, args.replica as string);
  const show = (): void => {
    const s = conn.session;
    console.log(`[${s.replicaId}${conn.connected ? "" : " offline"}, ${s.unackedCount} unacked] ${JSON.stringify(s.text)}`);
  };
  conn.onChange = show;
  conn.onStatus = (status) => console.log(`-- ${status}`);

  console.log(`doc "${args.doc}" as replica "${args.replica}" via ${args.url}\n${HELP}`);
  await conn.connect();
  show();

  const rl = createInterface({ input: process.stdin });
  for await (const line of rl) {
    const [cmd, ...rest] = line.trim().split(" ");
    try {
      if (cmd === "a") conn.insert(conn.session.doc.length, rest.join(" "));
      else if (cmd === "i") conn.insert(Number(rest[0]), rest.slice(1).join(" "));
      else if (cmd === "d") conn.delete(Number(rest[0]), rest[1] === undefined ? 1 : Number(rest[1]));
      else if (cmd === "p") show();
      else if (cmd === "drop") conn.drop();
      else if (cmd === "connect") await conn.connect();
      else if (cmd === "q") break;
      else if (cmd !== "") console.log(HELP);
    } catch (err) {
      console.log(`!! ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  conn.drop();
  process.exit(0);
}

void main();
