/**
 * Bare browser client: one textarea bound to a FugueMax replica. Bundled into
 * apps/relay-worker/public/app.js and served by the relay as a static asset.
 * Open the page in two tabs (same ?doc=) to see them sync.
 */
import { ClientSession } from "@crdt/relay-worker/client";
import type { ServerMessage } from "@crdt/relay-worker/protocol";

const RECONNECT_MS = 1500;

const docId = new URLSearchParams(location.search).get("doc") ?? "demo";
const editor = document.querySelector<HTMLTextAreaElement>("#editor")!;
const statusLine = document.querySelector<HTMLElement>("#status")!;
const toggle = document.querySelector<HTMLButtonElement>("#toggle")!;
document.querySelector<HTMLElement>("#doc")!.textContent = docId;

/** One replica id per tab, kept across reloads of that tab. */
function replicaId(): string {
  const saved = sessionStorage.getItem("replica");
  if (saved !== null) return saved;
  const bytes = crypto.getRandomValues(new Uint8Array(4));
  const id = `web-${[...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
  sessionStorage.setItem("replica", id);
  return id;
}

const session = new ClientSession(replicaId());
let socket: WebSocket | null = null;
let wantOnline = true;
/** The document as code points, as last shown in the textarea. One code point is one CRDT element. */
let shown: string[] = [];

function commonEdges(a: readonly string[], b: readonly string[]): { prefix: number; suffix: number } {
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
  let suffix = 0;
  while (suffix < a.length - prefix && suffix < b.length - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix++;
  return { prefix, suffix };
}

function send(messages: readonly unknown[]): void {
  if (socket === null || socket.readyState !== WebSocket.OPEN) return;
  for (const message of messages) socket.send(JSON.stringify(message));
}

function showStatus(): void {
  const online = socket !== null && socket.readyState === WebSocket.OPEN;
  const pending = session.unackedCount;
  statusLine.textContent = `${session.replicaId} · ${online ? "connected" : "offline"} · ${pending === 0 ? "all changes saved" : `${pending} unsaved`}`;
  statusLine.dataset.state = online ? "online" : "offline";
  toggle.textContent = wantOnline ? "Go offline" : "Reconnect";
}

/** The user typed: turn the textarea's change into deletes and inserts on the replica. */
function onLocalInput(): void {
  const next = [...editor.value];
  const { prefix, suffix } = commonEdges(shown, next);
  const removed = shown.length - prefix - suffix;
  const inserted = next.slice(prefix, next.length - suffix).join("");
  if (removed > 0) send(session.delete(prefix, removed));
  if (inserted.length > 0) send(session.insert(prefix, inserted));
  shown = next;
  showStatus();
}

/** The replica changed because of remote ops: update the textarea and keep the caret where the user left it. */
function render(): void {
  const next = [...session.text];
  const { prefix, suffix } = commonEdges(shown, next);
  const shift = (utf16: number): number => {
    const at = [...editor.value.slice(0, utf16)].length;
    const moved = at <= prefix ? at : at >= shown.length - suffix ? at + next.length - shown.length : next.length - suffix;
    return next.slice(0, moved).join("").length;
  };
  const start = shift(editor.selectionStart);
  const end = shift(editor.selectionEnd);
  shown = next;
  editor.value = next.join("");
  editor.setSelectionRange(start, end);
}

function connect(): void {
  const scheme = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${scheme}://${location.host}/doc/${encodeURIComponent(docId)}/ws?${session.connectQuery()}`);
  ws.binaryType = "arraybuffer";
  socket = ws;

  ws.addEventListener("open", showStatus);
  ws.addEventListener("message", (event) => {
    if (socket !== ws) return;
    const message: ServerMessage | Uint8Array =
      typeof event.data === "string" ? (JSON.parse(event.data) as ServerMessage) : new Uint8Array(event.data as ArrayBuffer);
    const result = session.receive(message);
    send(result.send);
    if (result.changed) render();
    if (result.reconnect) ws.close(1000, "resync");
    showStatus();
  });
  ws.addEventListener("close", () => {
    if (socket !== ws) return;
    socket = null;
    showStatus();
    if (wantOnline) setTimeout(() => wantOnline && socket === null && connect(), RECONNECT_MS);
  });
}

editor.addEventListener("input", onLocalInput);
toggle.addEventListener("click", () => {
  wantOnline = !wantOnline;
  if (wantOnline) connect();
  else socket?.close(1000, "offline");
  showStatus();
});

connect();
showStatus();
