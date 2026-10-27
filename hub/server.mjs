// LayerBridge hub. Two local listeners, same message set:
//   WebSocket  127.0.0.1:61804  (Figma, CEP/UXP panels)
//   TCP NDJSON 127.0.0.1:61805  (Blender add-on, scripts)
// FigCraft is a virtual host: the hub drives its --control socket itself.
import net from "node:net";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { HOSTS, parseMessage, validateLayers } from "./protocol.mjs";
import { FigCraftClient, pushLayers, pullSelection } from "./adapters/figcraft.mjs";

export function startHub({ wsPort = 61804, tcpPort = 61805, figcraftPort = 7979 } = {}) {
  let nextId = 1;
  /** id -> { id, host, send(obj) } */
  const clients = new Map();
  const fc = new FigCraftClient({ port: figcraftPort });
  let fcUp = false;

  const hostList = () => [
    ...[...clients.values()].map(({ id, host }) => ({ id, host })),
    ...(fcUp ? [{ id: "FIGCRAFT", host: "FIGCRAFT" }] : []),
  ];
  const broadcastHosts = () => {
    const hosts = hostList();
    for (const c of clients.values()) c.send({ type: "hosts", hosts });
  };

  async function tryConnectFigCraft() {
    try {
      await fc.connect();
      fcUp = true;
      fc.socket.once("close", () => {
        fcUp = false;
        broadcastHosts();
      });
      broadcastHosts();
    } catch {
      /* FigCraft not running with --control; retry later */
    }
  }

  const targets = (to, fromId) =>
    [...clients.values()].filter(
      (c) => c.id !== fromId && (to === "ALL" || c.id === to || c.host === to),
    );

  async function handle(client, msg) {
    switch (msg.type) {
      case "hello": {
        if (!HOSTS.includes(msg.host)) throw new Error(`unknown host: ${msg.host}`);
        client.host = msg.host;
        client.id = `${msg.host}-${nextId++}`;
        clients.set(client.id, client);
        client.send({ type: "welcome", id: client.id });
        broadcastHosts();
        return;
      }
      case "push": {
        if (!client.id) throw new Error("send hello first");
        const layers = validateLayers(msg.layers);
        if (msg.to === "FIGCRAFT") {
          if (!fcUp) throw new Error("FigCraft is not connected (run it with --control 7979)");
          const { created, warnings } = await pushLayers(fc, layers);
          client.send({ type: "ack", ref: msg.ref, created, warnings });
          return;
        }
        const dest = targets(msg.to, client.id);
        if (!dest.length) throw new Error(`no connected host matches: ${msg.to}`);
        for (const d of dest) d.send({ type: "push", from: client.id, layers, activate: msg.activate === true }); // validated + normalised
        client.send({ type: "ack", ref: msg.ref, delivered: dest.length });
        return;
      }
      case "pull": {
        if (!client.id) throw new Error("send hello first");
        if (msg.to === "FIGCRAFT") {
          if (!fcUp) throw new Error("FigCraft is not connected");
          const { layers, warnings } = await pullSelection(fc);
          client.send({ type: "pullResult", from: "FIGCRAFT", ref: msg.ref, layers: validateLayers(layers), warnings });
          return;
        }
        const dest = targets(msg.to, client.id);
        if (!dest.length) throw new Error(`no connected host matches: ${msg.to}`);
        for (const d of dest) d.send({ type: "pull", from: client.id, ref: msg.ref });
        return;
      }
      case "pullResult": {
        // reply to a pull: forward to the requester only
        const layers = validateLayers(msg.layers);
        const dest = clients.get(msg.to);
        if (dest) dest.send({ type: "pullResult", from: client.id, ref: msg.ref, layers });
        return;
      }
      default:
        throw new Error(`unknown message type: ${msg.type}`);
    }
  }

  const wire = (client) => async (raw) => {
    try {
      await handle(client, parseMessage(raw));
    } catch (e) {
      client.send({ type: "error", message: e.message });
    }
  };
  const drop = (client) => {
    if (client.id && clients.delete(client.id)) broadcastHosts();
  };

  // --- WebSocket listener: refuse normal web pages, accept plugin runtimes.
  const wss = new WebSocketServer({
    host: "127.0.0.1",
    port: wsPort,
    maxPayload: 32 * 1024 * 1024,
    verifyClient: ({ origin }) => !origin || !/^https?:\/\//i.test(origin),
  });
  wss.on("connection", (ws) => {
    const client = { id: null, host: null, send: (o) => ws.readyState === 1 && ws.send(JSON.stringify(o)) };
    ws.on("message", (d) => wire(client)(d.toString()));
    ws.on("close", () => drop(client));
    ws.on("error", () => drop(client));
  });

  // --- TCP listener (newline-delimited JSON).
  const tcp = net.createServer((sock) => {
    sock.setEncoding("utf8");
    let buf = "";
    const client = { id: null, host: null, send: (o) => !sock.destroyed && sock.write(JSON.stringify(o) + "\n") };
    sock.on("data", (d) => {
      buf += d;
      if (buf.length > 32 * 1024 * 1024) return sock.destroy();
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (line.trim()) wire(client)(line);
      }
    });
    sock.on("close", () => drop(client));
    sock.on("error", () => drop(client));
  });
  tcp.listen(tcpPort, "127.0.0.1");

  tryConnectFigCraft();
  const retry = setInterval(() => !fcUp && tryConnectFigCraft(), 5000);
  retry.unref();

  return {
    wsPort,
    tcpPort,
    status: () => ({ hosts: hostList(), figcraft: fcUp }),
    close() {
      clearInterval(retry);
      fc.close();
      wss.close();
      tcp.close();
    },
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const hub = startHub();
  console.log(`LayerBridge hub: ws://127.0.0.1:${hub.wsPort}  tcp://127.0.0.1:${hub.tcpPort}`);
}
