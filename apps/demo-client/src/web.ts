/**
 * Bare browser client: one textarea bound to a FugueMax replica. Bundled into
 * apps/relay-worker/public/app.js and served by the relay as a static asset.
 * Open the page in two tabs (same ?doc=) to see them sync.
 */
import { ClientSession } from "@crdt/relay-worker/client";
import type { ServerMessage } from "@crdt/relay-worker/protocol";

const RECONNECT_MS = 1500;
/** At most this often is the caret position announced to the others. */
const PRESENCE_MS = 250;

const docId = new URLSearchParams(location.search).get("doc") ?? "demo";
const editor = document.querySelector<HTMLTextAreaElement>("#editor")!;
const statusLine = document.querySelector<HTMLElement>("#status")!;
const toggle = document.querySelector<HTMLButtonElement>("#toggle")!;
const mirror = document.querySelector<HTMLElement>("#mirror")!;
const peersLine = document.querySelector<HTMLElement>("#peers")!;
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
let lastError = "";
let presenceTimer: number | null = null;
let announcedCaret = -1;

/** A stable colour per replica id. */
function colourOf(id: string): string {
  let hash = 0;
  for (const ch of id) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return `hsl(${hash % 360} 70% 45%)`;
}

/**
 * Draws the other clients' carets. The mirror sits behind the (transparent)
 * textarea with identical metrics and holds the same text in invisible ink, so a
 * zero-width marker placed in it lands exactly where that caret is.
 */
function renderPeers(): void {
  const carets = session.peerCarets().sort((a, b) => a.index - b.index);
  mirror.replaceChildren();
  let from = 0;
  for (const { replicaId, index } of carets) {
    mirror.append(shown.slice(from, index).join(""));
    const marker = document.createElement("span");
    marker.className = "caret";
    marker.dataset.name = replicaId;
    marker.style.setProperty("--c", colourOf(replicaId));
    mirror.append(marker);
    from = index;
  }
  // The trailing space keeps a final newline from collapsing, as it does in the textarea.
  mirror.append(shown.slice(from).join("") + " ");
  mirror.scrollTop = editor.scrollTop;

  peersLine.replaceChildren();
  if (carets.length > 0) peersLine.append("Also here: ");
  for (const { replicaId } of carets) {
    const chip = document.createElement("span");
    chip.className = "chip";
    chip.textContent = replicaId;
    chip.style.setProperty("--c", colourOf(replicaId));
    peersLine.append(chip);
  }
}

/** Tells the others where this caret is, throttled, and only when it actually moved. */
function announceCaret(): void {
  if (presenceTimer !== null) return;
  presenceTimer = window.setTimeout(() => {
    presenceTimer = null;
    const caret = [...editor.value.slice(0, editor.selectionStart)].length;
    if (caret === announcedCaret || document.activeElement !== editor) return;
    announcedCaret = caret;
    send([session.presence(caret)]);
  }, PRESENCE_MS);
}

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
  const saved = pending === 0 ? "all changes saved" : `${pending} unsaved`;
  statusLine.textContent = `${session.replicaId} · ${online ? "connected" : "offline"} · ${saved}${lastError === "" ? "" : ` · ${lastError}`}`;
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
  renderPeers();
  announceCaret();
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
  renderPeers();
}

function connect(): void {
  const scheme = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${scheme}://${location.host}/doc/${encodeURIComponent(docId)}/ws?${session.connectQuery()}`);
  ws.binaryType = "arraybuffer";
  socket = ws;

  ws.addEventListener("open", () => {
    announcedCaret = -1;
    lastError = "";
    showStatus();
  });
  ws.addEventListener("message", (event) => {
    if (socket !== ws) return;
    const message: ServerMessage | Uint8Array =
      typeof event.data === "string" ? (JSON.parse(event.data) as ServerMessage) : new Uint8Array(event.data as ArrayBuffer);
    const result = session.receive(message);
    send(result.send);
    if (result.changed) render();
    else if (result.presenceChanged) renderPeers();
    if (result.error !== undefined) lastError = result.error;
    if (!(message instanceof Uint8Array) && message.type === "synced") announceCaret();
    if (result.reconnect) ws.close(1000, "resync");
    showStatus();
  });
  ws.addEventListener("close", () => {
    if (socket !== ws) return;
    socket = null;
    renderPeers();
    showStatus();
    if (wantOnline) setTimeout(() => wantOnline && socket === null && connect(), RECONNECT_MS);
  });
}

editor.addEventListener("input", onLocalInput);
editor.addEventListener("scroll", () => {
  mirror.scrollTop = editor.scrollTop;
});
for (const event of ["keyup", "click", "focus", "select"]) editor.addEventListener(event, announceCaret);
toggle.addEventListener("click", () => {
  wantOnline = !wantOnline;
  if (wantOnline) connect();
  else socket?.close(1000, "offline");
  showStatus();
});

connect();
showStatus();
