// Live test against a real FigCraft started with `figcraft --control 7979`.
// Not part of `npm test`. Run: node test/live-figcraft.mjs [port]
// It opens a NEW document in that FigCraft instance and works only inside it.
import assert from "node:assert/strict";
import { FigCraftClient, pushLayers, pullSelection } from "../hub/adapters/figcraft.mjs";
import { validateLayers } from "../hub/protocol.mjs";

const fc = new FigCraftClient({ port: Number(process.argv[2] ?? 7979) });
await fc.connect();
await fc.execute("file.new", { name: "LayerBridge live test" });

const layers = validateLayers([
  {
    type: "group", name: "Card", x: 40, y: 40, width: 300, height: 180, clipChildren: true, opacity: 0.9, rotation: 10,
    effects: [{ type: "dropShadow", x: 0, y: 6, blur: 12, color: "#000000", opacity: 0.3 }],
    children: [
      { type: "rect", name: "bg", x: 0, y: 0, width: 300, height: 180, cornerRadius: [12, 12, 0, 0],
        fills: [{ type: "linear", angle: 90, stops: [{ pos: 0, color: "#FF5A5F" }, { pos: 0.5, color: "#FFC857" }, { pos: 1, color: "#3D5AFE", opacity: 0.8 }] }],
        strokes: [{ paint: { type: "solid", color: "#111111" }, width: 2, align: "inside", dashes: [6, 3] }] },
      { type: "ellipse", name: "dot", x: 20, y: 20, width: 40, height: 40, blendMode: "color-burn", fills: [{ type: "solid", color: "#FFFFFF", opacity: 0.5 }] },
      { type: "path", name: "blob", x: 100, y: 60, width: 80, height: 60,
        fills: [{ type: "solid", color: "#00B894" }],
        path: [{ closed: true, nodes: [{ x: 0, y: 0, outX: 30, outY: -20 }, { x: 80, y: 20, inX: 60, inY: -20 }, { x: 40, y: 60 }] }] },
      { type: "text", name: "title", x: 20, y: 120, text: { content: "LayerBridge", fontSize: 28, fontFamily: "Inter", fontStyle: "Regular", align: "left" }, fills: [{ type: "solid", color: "#FFFFFF" }] },
    ],
  },
]);

const push = await pushLayers(fc, layers);
console.log("push:", JSON.stringify(push));
assert.equal(push.created, 5, "group + 4 children");

const { layers: back, warnings } = await pullSelection(fc);
console.log("pull warnings:", JSON.stringify(warnings));
validateLayers(back);

const g = back[0];
assert.equal(g.type, "group");
assert.equal(g.name, "Card");
assert.equal(Math.round(g.x), 40, "origin pinned after rotation");
assert.equal(Math.round(g.y), 40);
assert.equal(Math.round(g.rotation), 10, "rotation round-trips clockwise");
assert.equal(g.clipChildren, true);
assert.ok(Math.abs(g.opacity - 0.9) < 0.01);
assert.equal(g.effects[0].type, "dropShadow");
assert.equal(g.children.length, 4);

const bg = g.children.find((c) => c.name === "bg");
assert.equal(bg.type, "rect");
assert.deepEqual(bg.cornerRadius, [12, 12, 0, 0]);
assert.equal(bg.fills[0].type, "linear");
assert.equal(bg.fills[0].stops.length, 3, "gradient stops preserved");
assert.equal(bg.strokes[0].width, 2);
assert.deepEqual(bg.strokes[0].dashes, [6, 3]);

const dot = g.children.find((c) => c.name === "dot");
assert.equal(dot.blendMode, "color-burn");

const blob = g.children.find((c) => c.name === "blob");
assert.equal(blob.type, "path");
assert.equal(blob.path[0].closed, true);
assert.equal(blob.path[0].nodes.length, 3);

const title = g.children.find((c) => c.name === "title" || c.text?.content === "LayerBridge");
assert.equal(title.type, "text");
assert.equal(title.text.content, "LayerBridge");
assert.equal(title.text.fontSize, 28);

fc.close();
console.log("live-figcraft: all checks passed");
