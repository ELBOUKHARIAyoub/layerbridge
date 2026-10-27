import net from "node:net";
import assert from "node:assert/strict";
import { WebSocket } from "ws";
import { startHub } from "../hub/server.mjs";

const PORTS = { wsPort: 62804, tcpPort: 62805, figcraftPort: 62979 };

// Mock FigCraft control socket: records commands, answers like the docs describe.
const seen = [];
let nextNode = 10;
const mock = net.createServer((s) => {
  s.setEncoding("utf8");
  let buf = "";
  s.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const req = JSON.parse(buf.slice(0, i));
      buf = buf.slice(i + 1);
      seen.push(req);
      let result = { id: nextNode++ };
      if (req.method === "document.inspect") result = { selection: [5] };
      if (req.method === "node.get") result = { id: 5, type: "RECTANGLE", name: "Card", x: 1, y: 2, width: 30, height: 40, fills: [{ color: "#112233", type: "solid" }] };
      if (req.params?.command === "select.set") result = {};
      s.write(JSON.stringify({ id: req.id, ok: true, result }) + "\n");
    }
  });
});
await new Promise((r) => mock.listen(PORTS.figcraftPort, "127.0.0.1", r));

const hub = startHub(PORTS);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function wsClient(host) {
  const ws = new WebSocket(`ws://127.0.0.1:${PORTS.wsPort}`);
  const inbox = [];
  ws.on("message", (d) => inbox.push(JSON.parse(d)));
  const ready = new Promise((r) => ws.on("open", r)).then(() => ws.send(JSON.stringify({ type: "hello", host })));
  return { ws, inbox, ready, send: (o) => ws.send(JSON.stringify(o)) };
}
function tcpClient(host) {
  const sock = net.connect(PORTS.tcpPort, "127.0.0.1");
  sock.setEncoding("utf8");
  const inbox = [];
  let buf = "";
  sock.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      inbox.push(JSON.parse(buf.slice(0, i)));
      buf = buf.slice(i + 1);
    }
  });
  const ready = new Promise((r) => sock.on("connect", r)).then(() => sock.write(JSON.stringify({ type: "hello", host }) + "\n"));
  return { sock, inbox, ready, send: (o) => sock.write(JSON.stringify(o) + "\n") };
}

try {
  await wait(300); // let the hub find the mock FigCraft
  const figma = wsClient("FIGMA");
  const blender = tcpClient("BLENDER");
  await Promise.all([figma.ready, blender.ready]);
  await wait(200);

  const hosts = figma.inbox.filter((m) => m.type === "hosts").at(-1).hosts.map((h) => h.host).sort();
  assert.deepEqual(hosts, ["BLENDER", "FIGCRAFT", "FIGMA"], "host list");

  const layers = [{ type: "rect", name: "Box", x: 0, y: 0, width: 50, height: 50, fill: "#FF6B6B", cornerRadius: 8 }];

  figma.send({ type: "push", to: "BLENDER", layers, ref: "a" });
  await wait(150);
  assert.equal(blender.inbox.find((m) => m.type === "push")?.layers[0].name, "Box", "Figma -> Blender (TCP)");

  figma.send({ type: "push", to: "FIGCRAFT", layers, ref: "b" });
  await wait(300);
  const created = seen.filter((r) => r.params?.command === "node.create");
  assert.equal(created.length, 1, "FigCraft rect created");
  assert.equal(created[0].params.params.type, "rectangle");
  assert.deepEqual(created[0].params.params.props.fills, [{ type: "solid", color: "#FF6B6B" }], "legacy fill folded into props");
  assert.equal(created[0].params.params.props.cornerRadius, 8);
  assert.ok(seen.some((r) => r.params?.command === "select.set"), "created layers selected");
  assert.equal(figma.inbox.find((m) => m.type === "ack" && m.ref === "b")?.created, 1, "ack");

  figma.send({ type: "pull", to: "FIGCRAFT", ref: "c" });
  await wait(300);
  const pulled = figma.inbox.find((m) => m.type === "pullResult" && m.ref === "c");
  assert.equal(pulled?.layers[0].name, "Card", "FigCraft -> neutral");
  assert.equal(pulled.layers[0].fill, "#112233");

  figma.send({ type: "push", to: "BLENDER", layers: [{ type: "bogus" }], ref: "d" });
  await wait(150);
  assert.match(figma.inbox.find((m) => m.type === "error")?.message ?? "", /unknown layer type/, "validation");

  // A browser page must not be able to connect.
  const evil = new WebSocket(`ws://127.0.0.1:${PORTS.wsPort}`, { origin: "https://evil.example" });
  const blocked = await new Promise((r) => { evil.on("error", () => r(true)); evil.on("open", () => r(false)); });
  assert.equal(blocked, true, "web origins rejected");

  console.log("smoke: all checks passed");
} finally {
  hub.close();
  mock.close();
  process.exit(process.exitCode ?? 0);
}
