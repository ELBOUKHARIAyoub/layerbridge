// One-time plugin installer. plan() only describes what would happen;
// apply() does it. Nothing is changed unless apply() is called without dryRun.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CSXS_VERSIONS = [9, 10, 11, 12]; // covers CC 2019 and later

export function plan({ platform = process.platform, home = os.homedir(), env = process.env } = {}) {
  const win = platform === "win32";
  const mac = platform === "darwin";
  const appData = env.APPDATA ?? path.join(home, "AppData", "Roaming");
  const actions = [];
  const notes = [];

  // After Effects + Illustrator: one CEP panel, plus the flag that lets unsigned panels load.
  const cepDir = win
    ? path.join(appData, "Adobe", "CEP", "extensions")
    : mac ? path.join(home, "Library", "Application Support", "Adobe", "CEP", "extensions") : null;
  if (cepDir) {
    actions.push({
      kind: "copy",
      label: "After Effects + Illustrator panel",
      from: path.join(ROOT, "plugins", "adobe-cep"),
      to: path.join(cepDir, "com.layerbridge.panel"),
    });
    for (const v of CSXS_VERSIONS) {
      actions.push({
        kind: "cepDebug",
        version: v,
        label: `Allow unsigned Adobe panels (CSXS.${v})`,
        detail: win ? `HKCU\\Software\\Adobe\\CSXS.${v}  PlayerDebugMode = 1` : `defaults write com.adobe.CSXS.${v} PlayerDebugMode 1`,
      });
    }
  } else notes.push("Adobe CEP panels are only supported on Windows and macOS.");

  // Blender: copy the add-on into every installed version's addons folder.
  const blenderRoot = win
    ? path.join(appData, "Blender Foundation", "Blender")
    : mac ? path.join(home, "Library", "Application Support", "Blender") : path.join(home, ".config", "blender");
  let versions = [];
  try {
    versions = fs.readdirSync(blenderRoot).filter((d) => /^\d+\.\d+$/.test(d));
  } catch {
    /* Blender not installed or never started */
  }
  for (const v of versions) {
    actions.push({
      kind: "copy",
      label: `Blender ${v} add-on`,
      from: path.join(ROOT, "plugins", "blender", "layerbridge_addon.py"),
      to: path.join(blenderRoot, v, "scripts", "addons", "layerbridge_addon.py"),
    });
  }
  if (!versions.length) notes.push("Blender: no profile found. Start Blender once, then run setup again.");
  else notes.push("Blender: tick the add-on under Edit > Preferences > Add-ons (once).");

  // These can't be installed from outside the app.
  notes.push("Figma: Plugins > Development > Import plugin from manifest > plugins/figma/manifest.json (once).");
  notes.push("Photoshop: UXP Developer Tool > Add Plugin > plugins/photoshop-uxp/manifest.json > Load (once).");
  notes.push("FigCraft: nothing to install. `layerbridge start --figcraft` launches it with its control port.");
  return { actions, notes };
}

const defaultRun = (cmd, args) => spawnSync(cmd, args, { encoding: "utf8" });

export function apply({ actions }, { dryRun = false, platform = process.platform, run = defaultRun } = {}) {
  const results = [];
  for (const a of actions) {
    if (dryRun) {
      results.push({ ...a, status: "planned" });
      continue;
    }
    try {
      if (a.kind === "copy") {
        fs.mkdirSync(path.dirname(a.to), { recursive: true });
        fs.cpSync(a.from, a.to, { recursive: true, force: true });
      } else if (a.kind === "cepDebug") {
        const r = platform === "win32"
          ? run("reg", ["add", `HKCU\\Software\\Adobe\\CSXS.${a.version}`, "/v", "PlayerDebugMode", "/t", "REG_SZ", "/d", "1", "/f"])
          : run("defaults", ["write", `com.adobe.CSXS.${a.version}`, "PlayerDebugMode", "1"]);
        if (r.status !== 0) throw new Error((r.stderr || r.stdout || "command failed").trim());
      }
      results.push({ ...a, status: "done" });
    } catch (e) {
      results.push({ ...a, status: "failed", error: e.message });
    }
  }
  return results;
}
