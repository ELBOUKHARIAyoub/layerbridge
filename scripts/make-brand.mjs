// Renders the LayerBridge logo files from brand/brand.mjs. Run: npm run brand
//   docs/brand/       mark + lockup (SVG and PNG), palette
//   plugins/*/icons/  the icons each host app wants in its plugin list
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { fileURLToPath } from "node:url";
import { BRAND, markBody, markSvg } from "../brand/brand.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// Wordmark: "Layer" in the text colour, "Bridge" in the gradient.
const lockupSvg = (text) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 330 64" width="330" height="64">
  <defs><linearGradient id="lbw" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="${BRAND.violet}"/><stop offset="1" stop-color="${BRAND.coral}"/></linearGradient></defs>
  <g>${markBody("lbm")}</g>
  <text x="78" y="45" font-family="Segoe UI, Inter, Helvetica, Arial, sans-serif" font-size="37" font-weight="700" letter-spacing="-.5">
    <tspan fill="${text}">Layer</tspan><tspan fill="url(#lbw)">Bridge</tspan></text>
</svg>\n`;

const out = (...p) => path.join(ROOT, ...p);
const write = (file, data) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, data); };
const png = async (svg, file, width) => { write(file, await sharp(Buffer.from(svg), { density: 384 }).resize({ width }).png().toBuffer()); };

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  write(out("docs/brand/mark.svg"), markSvg() + "\n");
  write(out("docs/brand/lockup-light.svg"), lockupSvg(BRAND.ink));
  write(out("docs/brand/lockup-dark.svg"), lockupSvg("#FFFFFF"));
  for (const w of [512, 256, 128]) await png(markSvg(), out(`docs/brand/mark-${w}.png`), w);
  await png(lockupSvg(BRAND.ink), out("docs/brand/lockup-light.png"), 1320);
  await png(lockupSvg("#FFFFFF"), out("docs/brand/lockup-dark.png"), 1320);

  // plugin-list icons
  await png(markSvg(), out("plugins/adobe-cep/icons/icon-23.png"), 23);
  await png(markSvg(), out("plugins/adobe-cep/icons/icon-46.png"), 46);
  await png(markSvg(), out("plugins/photoshop-uxp/icons/plugin-icon.png"), 48);
  await png(markSvg(), out("plugins/photoshop-uxp/icons/plugin-icon@2x.png"), 96);

  write(out("docs/brand/README.md"), `# LayerBridge brand

| Token | Value | Use |
|---|---|---|
| Violet | \`${BRAND.violet}\` | primary: buttons, links, "Layer" accent |
| Coral | \`${BRAND.coral}\` | accent: gradient end, highlights |
| Ink | \`${BRAND.ink}\` | text on light backgrounds |
| Paper | \`${BRAND.paper}\` | light background |
| Night | \`${BRAND.night}\` | dark background |

Gradient: 135deg, violet to coral. Use the gradient on the logo badge only; buttons stay solid violet
(white text on coral is below the contrast we want for small text).

The mark is an arch (the bridge) over two stacked layers. Regenerate everything with \`npm run brand\`.
`);
  console.log("brand assets written");
}
