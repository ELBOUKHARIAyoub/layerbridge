// Distributes the shared panel UI (plugins/shared/panel-ui.js) into every plugin.
// Figma only loads a single HTML file for a plugin UI, so there it is inlined into ui.html
// (generated from ui.src.html). The others get a copy next to their index.html.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SHARED = path.join(ROOT, "plugins", "shared", "panel-ui.js");
const COPY_TO = ["adobe-cep", "photoshop-uxp"];
const TAG = '<script src="panel-ui.js"></script>';

export function build() {
  const js = fs.readFileSync(SHARED, "utf8");
  if (js.includes("</script>")) throw new Error("panel-ui.js must not contain a closing script tag");
  const files = {};
  for (const t of COPY_TO) files[path.join("plugins", t, "panel-ui.js")] = js;
  const src = fs.readFileSync(path.join(ROOT, "plugins", "figma", "ui.src.html"), "utf8");
  if (!src.includes(TAG)) throw new Error("ui.src.html is missing the panel-ui.js script tag");
  files[path.join("plugins", "figma", "ui.html")] = src.replace(TAG, () => `<script>\n${js}\n</script>`);
  return files;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  for (const [rel, content] of Object.entries(build())) {
    fs.writeFileSync(path.join(ROOT, rel), content);
    console.log("wrote " + rel.replace(/\\/g, "/"));
  }
}
