import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { validateLayers } from "../hub/protocol.mjs";

const rich = {
  type: "group", name: "Card", x: 10, y: 20, width: 200, height: 100, rotation: 15, clipChildren: true, blendMode: "multiply", opacity: 0.8,
  effects: [{ type: "dropShadow", x: 0, y: 4, blur: 8, color: "#000000", opacity: 0.25 }],
  children: [
    { type: "rect", name: "bg", x: 0, y: 0, width: 200, height: 100, cornerRadius: [8, 8, 0, 0],
      fills: [{ type: "linear", angle: 90, stops: [{ pos: 0, color: "#FF0000" }, { pos: 1, color: "#0000FF", opacity: 0.5 }] }],
      strokes: [{ paint: { type: "solid", color: "#111111" }, width: 2, align: "inside", dashes: [4, 2] }] },
    { type: "path", name: "blob", x: 5, y: 5, width: 50, height: 50,
      path: [{ closed: true, nodes: [{ x: 0, y: 0, outX: 10, outY: 0 }, { x: 50, y: 25, inX: 40, inY: 0 }, { x: 0, y: 50 }] }] },
    { type: "image", name: "photo", x: 0, y: 0, width: 4, height: 4, image: { format: "png", data: "iVBORw0KGgo=" } },
  ],
};

// valid v2 layer passes and legacy shorthand is folded in
const [ok] = validateLayers([rich]);
assert.equal(ok.children[0].fills[0].type, "linear");
const [legacy] = validateLayers([{ type: "rect", fill: "#FF6B6B", stroke: "#000000", strokeWidth: 3 }]);
assert.deepEqual(legacy.fills, [{ type: "solid", color: "#FF6B6B" }]);
assert.equal(legacy.strokes[0].width, 3);
const [mirror] = validateLayers([{ type: "rect", fills: [{ type: "solid", color: "#ABCDEF" }] }]);
assert.equal(mirror.fill, "#ABCDEF", "first solid fill mirrored to legacy fill");

// bad input is rejected with a useful message
const bad = (layer, re) => assert.throws(() => validateLayers([layer]), re);
bad({ type: "blob" }, /unknown layer type/);
bad({ type: "rect", blendMode: "glow" }, /blendMode/);
bad({ type: "rect", opacity: 3 }, /opacity/);
bad({ type: "rect", cornerRadius: [1, 2] }, /cornerRadius/);
bad({ type: "rect", fills: [{ type: "linear", stops: [{ pos: 0, color: "#000000" }] }] }, /stops/);
bad({ type: "path" }, /path layer needs a path/);
bad({ type: "path", path: [{ nodes: [{ x: "a", y: 0 }] }] }, /node\.x/);
bad({ type: "image" }, /image layer needs image data/);
bad({ type: "image", image: { format: "gif", data: "x" } }, /image\.format/);
bad({ type: "rect", effects: [{ type: "glow", blur: 1 }] }, /effect type/);

// depth limit
let deep = { type: "group" };
for (let i = 0; i < 40; i++) deep = { type: "group", children: [deep] };
bad(deep, /too deep/);

// Figma plugin path converter: parse(build(x)) round-trips, Q curves become C
const src = fs.readFileSync(new URL("../plugins/figma/code.js", import.meta.url), "utf8");
const start = src.indexOf("function parsePath");
const end = src.indexOf("// ---------- paints");
const ctx = {};
vm.runInNewContext(src.slice(start, end) + "\nthis.parsePath = parsePath; this.buildPath = buildPath;", ctx);
const nodes = rich.children[1].path[0];
const again = ctx.parsePath(ctx.buildPath(nodes));
assert.equal(again.length, 1);
assert.equal(again[0].closed, true);
assert.equal(again[0].nodes.length, 3);
assert.equal(again[0].nodes[0].outX, 10);
assert.equal(again[0].nodes[1].inX, 40);
const quad = ctx.parsePath("M 0 0 Q 10 20 30 0");
assert.ok(Math.abs(quad[0].nodes[0].outY - 40 / 3) < 1e-9, "quadratic converted to cubic");

console.log("protocol: all checks passed");
