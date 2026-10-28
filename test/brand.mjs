import assert from "node:assert/strict";
import fs from "node:fs";
import sharp from "sharp";
import { BRAND, markSvg } from "../brand/brand.mjs";
import { build } from "../scripts/sync-ui.mjs";

const read = (p) => fs.readFileSync(new URL("../" + p, import.meta.url), "utf8");

// WCAG contrast ratio between two #RRGGBB colours
const lum = (hex) => {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
};
const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

// readable text on every surface it is used on (white on violet buttons, body text, dark mode)
assert.ok(contrast("#FFFFFF", BRAND.violet) >= 4.5, "white on violet button");
assert.ok(contrast("#FFFFFF", BRAND.violetDark) >= 4.5, "white on the dark-mode violet button");
assert.ok(contrast(BRAND.ink, BRAND.paper) >= 7, "ink on paper");
assert.ok(contrast("#ECE9FA", BRAND.night) >= 7, "light text on night");
assert.ok(contrast("#FFFFFF", BRAND.coral) < 4.5, "coral really is too light for white text, which is why buttons stay violet");

// the committed logo files are what the brand definition produces (run `npm run brand` if not)
assert.equal(read("docs/brand/mark.svg"), markSvg() + "\n", "docs/brand/mark.svg is out of date");

// every panel carries the same logo
const files = build();
for (const [name, content] of Object.entries(files)) {
  assert.ok(content.includes("lbpanel"), `${name} has no logo`);
  assert.ok(content.includes("linear-gradient(90deg,#5B3DF5,#FF5E7E)"), `${name} is missing the accent line`);
  assert.ok(!content.includes("__LB_MARK_SVG__"), `${name} still has the logo placeholder`);
  assert.ok(content.includes(`--acc:${BRAND.violet}`), `${name}: light accent differs from the brand file`);
  assert.ok(content.includes(`--acc:${BRAND.violetDark}`), `${name}: dark accent differs from the brand file`);
  assert.ok(content.includes(`--bg:${BRAND.paper}`) && content.includes(`--bg:${BRAND.night}`), `${name}: backgrounds differ from the brand file`);
}
assert.ok(read("plugins/shared/panel-ui.js").includes("__LB_MARK_SVG__"), "shared source keeps the placeholder");

// plugin icons exist at the sizes each host asks for
for (const [file, size] of [["plugins/adobe-cep/icons/icon-23.png", 23], ["plugins/adobe-cep/icons/icon-46.png", 46], ["plugins/photoshop-uxp/icons/plugin-icon.png", 48], ["plugins/photoshop-uxp/icons/plugin-icon@2x.png", 96]]) {
  const m = await sharp(new URL("../" + file, import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")).metadata();
  assert.equal(m.width, size, file);
  assert.equal(m.height, size, file);
}
assert.ok(read("plugins/adobe-cep/CSXS/manifest.xml").includes("./icons/icon-23.png"), "CEP manifest points at its icon");
assert.ok(JSON.parse(read("plugins/photoshop-uxp/manifest.json")).icons[0].path === "icons/plugin-icon.png", "UXP manifest points at its icon");

console.log("brand: all checks passed");
