#!/usr/bin/env node
// LayerBridge: one command for everything.
//   layerbridge start [--figcraft] [--open]   run the hub + status page
//   layerbridge setup [--yes] [--dry-run]     install the plugins
//   layerbridge status                        ask a running hub who is connected
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import readline from "node:readline/promises";
import { spawn } from "node:child_process";
import { startHub } from "./hub/server.mjs";
import { plan, apply } from "./installer/install.mjs";
import { BRAND, markSvg } from "./brand/brand.mjs";

const STATUS_PORT = 61806;
const FIGCRAFT_PORT = 7979;
const args = process.argv.slice(2);
const cmd = args[0] && !args[0].startsWith("-") ? args[0] : "start";
const flag = (f) => args.includes(f);

const PAGE = `<!doctype html><meta charset="utf-8"><title>LayerBridge</title>
<link rel="icon" href="data:image/svg+xml,${encodeURIComponent(markSvg("lbf"))}">
<style>
  :root { color-scheme: light dark; --bg:${BRAND.paper}; --fg:${BRAND.ink}; --cor:#E0436A; --line:#E2DDF5; font: 15px system-ui, sans-serif; }
  @media (prefers-color-scheme: dark) { :root { --bg:${BRAND.night}; --fg:#ECE9FA; --cor:#FF6F8D; --line:#3A3455; } }
  body { max-width: 30rem; margin: 0 auto; padding: 0 1rem 2rem; background: var(--bg); color: var(--fg); }
  body::before { content:""; display:block; height:4px; margin:0 -1rem 1.5rem; background: linear-gradient(90deg, ${BRAND.violet}, ${BRAND.coral}); }
  header { display:flex; align-items:center; gap:.7rem; margin-bottom:1rem } header svg { width:40px; height:40px; display:block }
  h1 { font-size: 1.5rem; margin:0; letter-spacing:-.02em } h1 i { font-style:normal; color: var(--cor) }
  ul { list-style:none; padding:0 } li { margin:.35rem 0; padding:.55rem .7rem; border:1px solid var(--line); border-radius:8px }
  .dot { display:inline-block; width:.6rem; height:.6rem; border-radius:50%; margin-right:.5rem; background:#2da44e }
  .off { background:#999 } small { opacity:.65 }
</style>
<header>${markSvg("lbs")}<h1>Layer<i>Bridge</i></h1></header>
<ul id="list"></ul><small id="note"></small>
<script>
  const HOSTS = { AEFT: "After Effects", ILST: "Illustrator", PHXS: "Photoshop", FIGMA: "Figma", BLENDER: "Blender", FIGCRAFT: "FigCraft" };
  async function tick() {
    try {
      const s = await (await fetch("/api/status")).json();
      const on = new Set(s.hosts.map((h) => h.host));
      list.innerHTML = Object.entries(HOSTS).map(([k, name]) =>
        '<li><span class="dot ' + (on.has(k) ? "" : "off") + '"></span>' + name + ' <small>' + (on.has(k) ? "connected" : "not connected") + "</small></li>").join("");
      note.textContent = "Open an app with its LayerBridge panel. FigCraft needs: figcraft --control 7979";
    } catch { note.textContent = "hub not reachable"; }
  }
  tick(); setInterval(tick, 1500);
</script>`;

function portOpen(port) {
  return new Promise((resolve) => {
    const s = net.connect(port, "127.0.0.1");
    s.once("connect", () => (s.destroy(), resolve(true)));
    s.once("error", () => resolve(false));
  });
}

function figcraftPath() {
  const candidates = process.platform === "win32"
    ? ["C:\\Program Files\\FigCraft\\figcraft.exe"]
    : ["/Applications/FigCraft.app/Contents/MacOS/figcraft"];
  return candidates.find((p) => fs.existsSync(p));
}

async function launchFigCraft() {
  if (await portOpen(FIGCRAFT_PORT)) return console.log(`FigCraft control port ${FIGCRAFT_PORT} is already open`);
  const exe = figcraftPath();
  if (!exe) return console.log("FigCraft not found. Start it yourself with: figcraft --control " + FIGCRAFT_PORT);
  spawn(exe, ["--control", String(FIGCRAFT_PORT)], { detached: true, stdio: "ignore" }).unref();
  console.log("Started FigCraft with the control port on (the hub connects within a few seconds)");
}

async function setup() {
  const p = plan();
  console.log("LayerBridge setup\n");
  for (const a of p.actions) console.log(`  - ${a.label}${a.detail ? `\n      ${a.detail}` : a.to ? `\n      -> ${a.to}` : ""}`);
  console.log("\nBy hand:");
  for (const n of p.notes) console.log("  * " + n);
  if (flag("--dry-run")) return console.log("\n(dry run, nothing changed)");
  if (!flag("--yes") && !flag("-y")) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = (await rl.question("\nApply the steps above? [y/N] ")).trim().toLowerCase();
    rl.close();
    if (answer !== "y" && answer !== "yes") return console.log("Cancelled, nothing changed.");
  }
  const results = apply(p);
  for (const r of results) console.log(`  ${r.status === "done" ? "ok    " : "FAILED"} ${r.label}${r.error ? ": " + r.error : ""}`);
  console.log("\nRestart After Effects / Illustrator, then open Window > Extensions > LayerBridge.");
  if (results.some((r) => r.status === "failed")) process.exitCode = 1;
}

function openStatusPage() {
  const url = `http://127.0.0.1:${STATUS_PORT}`;
  if (process.platform === "win32") spawn("cmd", ["/c", "start", "", url], { stdio: "ignore" }).unref();
  else spawn(process.platform === "darwin" ? "open" : "xdg-open", [url], { stdio: "ignore" }).unref();
}

async function start() {
  // A second launch (double-clicking twice) should not crash on the busy ports.
  if (await portOpen(61804)) {
    console.log(`LayerBridge is already running.\n  status  http://127.0.0.1:${STATUS_PORT}`);
    if (flag("--figcraft")) await launchFigCraft();
    if (flag("--open")) openStatusPage();
    return process.exit(0);
  }
  const hub = startHub();
  const web = http.createServer((req, res) => {
    if (req.url === "/api/status") {
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      return res.end(JSON.stringify(hub.status()));
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(PAGE);
  });
  web.on("error", (e) => {
    console.error(`Status page could not start on port ${STATUS_PORT}: ${e.code ?? e.message}`);
  });
  web.listen(STATUS_PORT, "127.0.0.1");
  console.log(`LayerBridge running\n  hub     ws://127.0.0.1:${hub.wsPort}  tcp://127.0.0.1:${hub.tcpPort}\n  status  http://127.0.0.1:${STATUS_PORT}`);
  if (flag("--figcraft")) await launchFigCraft();
  if (flag("--open")) openStatusPage();
}

async function status() {
  try {
    const body = await new Promise((resolve, reject) =>
      http.get(`http://127.0.0.1:${STATUS_PORT}/api/status`, (r) => { let d = ""; r.on("data", (c) => (d += c)); r.on("end", () => resolve(d)); }).on("error", reject));
    const s = JSON.parse(body);
    console.log(s.hosts.length ? s.hosts.map((h) => `  ${h.host}  (${h.id})`).join("\n") : "  hub is running, nobody connected yet");
  } catch {
    console.log("hub is not running. Start it with: layerbridge start");
    process.exitCode = 1;
  }
}

const commands = { start, setup, status };
if (!commands[cmd]) {
  console.log("usage: layerbridge [start|setup|status]  (start --figcraft --open | setup --yes --dry-run)");
  process.exit(1);
}
await commands[cmd]();
