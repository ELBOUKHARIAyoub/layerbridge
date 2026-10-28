// Runs the shared panel UI against a fake page and a fake socket.
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { build } from "../scripts/sync-ui.mjs";

const src = fs.readFileSync(new URL("../plugins/adobe-cep/panel-ui.js", import.meta.url), "utf8");
const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));

function load() {
  const root = { innerHTML: "", handlers: {}, addEventListener(t, fn) { this.handlers[t] = fn; } };
  const sockets = [];
  class FakeWS {
    constructor() { this.readyState = 1; this.sent = []; sockets.push(this); }
    send(s) { this.sent.push(JSON.parse(s)); }
  }
  const ctx = {
    document: { getElementById: () => root, createElement: () => ({}), head: { appendChild() {} } },
    WebSocket: FakeWS, localStorage: { getItem: () => null, setItem() {} },
    setInterval() {}, setTimeout() {}, JSON, Promise, console,
  };
  ctx.window = ctx;
  vm.runInNewContext(src, ctx);
  return { ctx, root, sockets };
}
const click = (root, act, id) => {
  const btn = { getAttribute: (k) => ({ "data-act": act, "data-id": id })[k], disabled: false, parentNode: root };
  root.handlers.click({ target: btn });
};
const text = (html) => html.replace(/<[^>]+>/g, " ").replace(/&gt;/g, ">").replace(/&lt;/g, "<").replace(/&amp;/g, "&").replace(/\s+/g, " ");

// ---- the selection summary text
const { ctx: c0 } = load();
const d = c0.LBPanel._describe;
assert.equal(d({ count: 0 }), "Nothing selected");
assert.equal(d({ count: 0, hint: "Open a composition" }), "Open a composition");
assert.equal(d({ count: 1, kinds: { shapes: 1 } }), "1 layer selected (1 shape)");
assert.equal(d({ count: 3, kinds: { shapes: 2, text: 1, groups: 0 }, where: "Comp 1" }), "3 layers selected (2 shapes, 1 text) in Comp 1");

// ---- full panel flow
const { ctx, root, sockets } = load();
let selection = { count: 2, kinds: { shapes: 1, text: 1 }, where: "Comp 1" };
const layers = [{ type: "rect", name: "A", x: 0, y: 0, width: 10, height: 10 }];
const applied = [];
ctx.LBPanel.mount({
  host: "AEFT",
  getSummary: async () => selection,
  getLayers: async () => layers,
  applyLayers: async (l, from) => { applied.push([l, from]); return "ok"; },
  activate: () => applied.push("activated"),
});
await tick();
const ws = sockets[0];
ws.onopen();
assert.deepEqual(ws.sent[0], { type: "hello", host: "AEFT" });

await ws.onmessage({ data: JSON.stringify({ type: "welcome", id: "AEFT-1" }) });
await ws.onmessage({ data: JSON.stringify({ type: "hosts", hosts: [{ id: "AEFT-1", host: "AEFT" }, { id: "FIGMA-2", host: "FIGMA" }, { id: "BLENDER-3", host: "BLENDER" }] }) });
let t = text(root.innerHTML);
assert.match(t, /After Effects connected/);
assert.match(t, /2 layers selected \(1 shape, 1 text\) in Comp 1/, "selection summary shown");
assert.match(t, /Figma connected/, "live destination listed");
assert.match(t, /Illustrator not connected\. Open Window > Extensions > LayerBridge/, "offline destination explains how to connect");
assert.match(t, /FigCraft not connected\. Start FigCraft with --control 7979/);
assert.ok(!/After Effects not connected/.test(t), "never offers itself as a destination");
assert.ok(!/data-act="push" data-id="FIGMA-2" disabled/.test(root.innerHTML), "push enabled with a selection");

click(root, "push", "FIGMA-2");
await tick();
assert.deepEqual(ws.sent.at(-1), { type: "push", to: "FIGMA-2", layers, ref: ws.sent.at(-1).ref, activate: false });
assert.match(text(root.innerHTML), /Sending 1 layer to Figma/);

await ws.onmessage({ data: JSON.stringify({ type: "ack", ref: "x", created: 5, warnings: ["gradient approximated"] }) });
assert.match(text(root.innerHTML), /Sent \(5 created\) gradient approximated/);

// nothing selected -> push disabled, hint shown
selection = { count: 0, hint: "Select layers in After Effects to send them" };
// the host list message re-renders; emulate the poll's effect by re-mounting state through a hosts message
const fresh = load();
fresh.ctx.LBPanel.mount({ host: "AEFT", getSummary: async () => selection, getLayers: async () => [], applyLayers: async () => "", });
await tick();
const ws2 = fresh.sockets[0];
await ws2.onmessage({ data: JSON.stringify({ type: "welcome", id: "AEFT-1" }) });
await ws2.onmessage({ data: JSON.stringify({ type: "hosts", hosts: [{ id: "FIGMA-2", host: "FIGMA" }] }) });
assert.match(fresh.root.innerHTML, /data-act="push" data-id="FIGMA-2" disabled/, "push disabled without a selection");
assert.match(text(fresh.root.innerHTML), /Select layers in After Effects to send them/);
click(fresh.root, "push", "FIGMA-2");
await tick();
assert.ok(!ws2.sent.some((m) => m.type === "push"), "a disabled push button sends nothing");

// incoming push: applied, status shows the source, app switch honoured
await ws.onmessage({ data: JSON.stringify({ type: "push", from: "FIGMA-2", layers, activate: true }) });
assert.deepEqual(applied[0], [layers, "FIGMA-2"]);
assert.equal(applied[1], "activated");
assert.match(text(root.innerHTML), /Received 1 layer from Figma/);

// incoming pull: answered with our selection
await ws.onmessage({ data: JSON.stringify({ type: "pull", from: "FIGMA-2", ref: "r1" }) });
assert.deepEqual(ws.sent.at(-1), { type: "pullResult", to: "FIGMA-2", ref: "r1", layers });

// hub errors are shown
await ws.onmessage({ data: JSON.stringify({ type: "error", message: "no connected host matches: X" }) });
assert.match(root.innerHTML, /lb-status err/);

// two documents of the same app are told apart
await ws.onmessage({ data: JSON.stringify({ type: "hosts", hosts: [{ id: "FIGMA-2", host: "FIGMA" }, { id: "FIGMA-7", host: "FIGMA" }] }) });
t = text(root.innerHTML);
assert.match(t, /Figma \(2\)/);
assert.match(t, /Figma \(7\)/);

// ---- the generated plugin files match the shared source (run `npm run sync-ui` if this fails)
for (const [rel, content] of Object.entries(build())) {
  const onDisk = fs.readFileSync(new URL("../" + rel.replace(/\\/g, "/"), import.meta.url), "utf8");
  assert.equal(onDisk, content, `${rel} is out of date: run npm run sync-ui`);
}

console.log("panel-ui: all checks passed");
