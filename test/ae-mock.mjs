// Runs plugins/adobe-cep/host.jsx against a minimal fake After Effects to check the
// layer-split logic (groups -> guide layers + parenting) and image placement.
// This proves the logic runs; it does NOT prove After Effects accepts every property name.
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

class Prop {
  constructor(name) { this.name = name; this.kids = {}; this.value = [0, 0]; }
  property(n) { return (this.kids[n] ??= new Prop(n)); }
  addProperty(n) { return this.property(n); }
  setValue(v) { this.value = v; }
}
class Layer extends Prop {
  constructor(kind) {
    super("layer");
    this.kind = kind; this.parent = null; this.guideLayer = false; this.comment = ""; this.enabled = true; this.locked = false;
    this.kids["Source Text"] = Object.assign(new Prop("Source Text"), { value: {} });
  }
}
const all = []; // every layer created, in stack order
class CompItem {
  constructor() {
    const add = (kind, extra) => { const l = Object.assign(new Layer(kind), extra); all.push(l); return l; };
    this.layers = { addShape: () => add("shape"), addText: () => add("text"), add: (footage) => add("footage", { footage }) };
    this.selectedLayers = [];
  }
}
const comp = new CompItem();

const ctx = {
  app: {
    name: "Adobe After Effects",
    project: { activeItem: comp, importFile: () => ({ width: 200, height: 100 }), file: null },
    beginUndoGroup() {}, endUndoGroup() {},
  },
  CompItem, ShapeLayer: class {}, TextLayer: class {},
  BlendingMode: { NORMAL: 0, MULTIPLY: 1 },
  Shape: class {}, File: class { constructor(p) { this.exists = !String(p).includes("missing"); } }, ImportOptions: class {},
};
vm.runInNewContext(fs.readFileSync(new URL("../plugins/adobe-cep/host.jsx", import.meta.url), "utf8") + "\nthis.LB = LB;", ctx);

const same = (a, b) => assert.equal(JSON.stringify(a), JSON.stringify(b)); // arrays from the sandbox have another realm's prototype
const pos = (l) => l.property("Transform").property("Position").value;
const layers = [
  {
    type: "group", name: "Card", x: 100, y: 50, width: 300, height: 200, opacity: 0.5, rotation: 10,
    children: [
      { type: "rect", name: "bg", x: 10, y: 20, width: 100, height: 50, opacity: 0.5, fills: [{ type: "solid", color: "#FF0000" }] },
      { type: "image", name: "photo", x: 5, y: 6, width: 100, height: 50, imagePath: "C:/tmp/photo.png" },
      { type: "text", name: "title", x: 0, y: 100, text: { content: "Hi", fontSize: 20 }, fills: [{ type: "solid", color: "#FFFFFF" }] },
      { type: "group", name: "Inner", x: 50, y: 50, width: 40, height: 40, children: [{ type: "ellipse", name: "dot", x: 1, y: 2, width: 10, height: 10 }] },
    ],
  },
];

const res = ctx.LB.create(JSON.stringify(layers));
assert.match(res, /^6 layer\(s\) created/, res);

const byName = (n) => all.find((l) => l.name === n);
const card = byName("Card"), bg = byName("bg"), photo = byName("photo"), title = byName("title"), inner = byName("Inner"), dot = byName("dot");

// group -> invisible guide layer carrying only the transform
assert.equal(card.guideLayer, true);
assert.equal(card.comment, "LayerBridge group");
same(pos(card), [100, 50]);
assert.equal(card.property("Transform").property("Rotation").value, 10);
assert.equal(card.property("Transform").kids["Opacity"], undefined, "group opacity is not set on the guide");
assert.equal(card.parent, null);

// children are parented to it, keep parent-relative positions, and inherit its opacity
assert.equal(bg.parent, card);
same(pos(bg), [10, 20]);
assert.equal(bg.property("Transform").property("Opacity").value, 25, "0.5 own x 0.5 from the group");
assert.equal(title.parent, card);
assert.equal(photo.parent, card);
assert.equal(photo.property("Transform").property("Opacity").value, 50, "no own opacity, so it inherits the group's 50%");

// nested group parents to the outer group; its child to the inner guide
assert.equal(inner.parent, card);
assert.equal(inner.guideLayer, true);
assert.equal(dot.parent, inner);

// image: scaled from the footage size, top-left anchor
same(photo.property("Transform").property("Scale").value, [50, 50], "100x50 on a 200x100 file");
same(photo.property("Transform").property("Anchor Point").value, [0, 0]);
same(pos(photo), [5, 6]);

// guides come first in the stack so their art sits above them
assert.ok(all.indexOf(card) < all.indexOf(bg));

// a missing image is reported, not fatal
const miss = ctx.LB.create(JSON.stringify([{ type: "image", name: "gone", x: 0, y: 0, imagePath: "C:/missing.png" }]));
assert.match(miss, /^0 layer\(s\) created \(image file not found\)/, miss);
const noPath = ctx.LB.create(JSON.stringify([{ type: "image", name: "gone2", x: 0, y: 0 }]));
assert.match(noPath, /image file missing/);

// helpers exposed to the panel
assert.equal(ctx.LB.projectDir(), "", "unsaved project has no folder");
assert.match(ctx.LB.summary(), /"count":0/);

console.log("ae-mock: all checks passed");
