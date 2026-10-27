import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { plan, apply } from "../installer/install.mjs";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "lb-home-"));
try {
  // Windows layout with one Blender profile present
  const appData = path.join(home, "AppData", "Roaming");
  fs.mkdirSync(path.join(appData, "Blender Foundation", "Blender", "4.2"), { recursive: true });
  const env = { APPDATA: appData };

  const p = plan({ platform: "win32", home, env });
  const labels = p.actions.map((a) => a.label);
  assert.ok(labels.includes("After Effects + Illustrator panel"));
  assert.ok(labels.includes("Blender 4.2 add-on"));
  assert.equal(p.actions.filter((a) => a.kind === "cepDebug").length, 4, "one flag per CSXS version");
  assert.ok(p.notes.some((n) => n.startsWith("Figma")) && p.notes.some((n) => n.startsWith("Photoshop")));

  // dry run touches nothing
  const dry = apply(p, { dryRun: true, platform: "win32" });
  assert.ok(dry.every((r) => r.status === "planned"));
  assert.ok(!fs.existsSync(path.join(appData, "Adobe")), "dry run wrote nothing");

  // real apply (registry calls stubbed) copies the files
  const calls = [];
  const res = apply(p, { platform: "win32", run: (cmd, args) => (calls.push([cmd, ...args]), { status: 0 }) });
  assert.ok(res.every((r) => r.status === "done"), JSON.stringify(res.filter((r) => r.status !== "done")));
  const panel = path.join(appData, "Adobe", "CEP", "extensions", "com.layerbridge.panel");
  for (const f of ["CSXS/manifest.xml", "index.html", "host.jsx", "CSInterface.js"]) assert.ok(fs.existsSync(path.join(panel, f)), f);
  assert.ok(fs.existsSync(path.join(appData, "Blender Foundation", "Blender", "4.2", "scripts", "addons", "layerbridge_addon.py")));
  assert.equal(calls.length, 4);
  assert.deepEqual(calls[0].slice(0, 4), ["reg", "add", "HKCU\\Software\\Adobe\\CSXS.9", "/v"]);

  // a failing command is reported, not thrown
  const bad = apply({ actions: [{ kind: "cepDebug", version: 9, label: "x" }] }, { platform: "win32", run: () => ({ status: 1, stderr: "denied" }) });
  assert.equal(bad[0].status, "failed");
  assert.match(bad[0].error, /denied/);

  // macOS layout uses defaults + ~/Library
  const m = plan({ platform: "darwin", home, env: {} });
  assert.ok(m.actions[0].to.includes(path.join("Library", "Application Support", "Adobe", "CEP", "extensions")));
  const macCalls = [];
  apply({ actions: m.actions.filter((a) => a.kind === "cepDebug") }, { platform: "darwin", run: (c, a) => (macCalls.push([c, ...a]), { status: 0 }) });
  assert.deepEqual(macCalls[0], ["defaults", "write", "com.adobe.CSXS.9", "PlayerDebugMode", "1"]);

  console.log("installer: all checks passed");
} finally {
  fs.rmSync(home, { recursive: true, force: true });
}
