// Runs plugins/adobe-cep/host.jsx against a minimal fake Illustrator, to make
// sure the read path executes and emits layers the hub accepts. This is NOT a
// substitute for testing inside the real app.
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { validateLayers } from "../hub/protocol.mjs";

const BlendModes = { NORMAL: 0, MULTIPLY: 1, DARKEN: 2, COLORBURN: 3, LIGHTEN: 4, SCREEN: 5, COLORDODGE: 6, OVERLAY: 7, SOFTLIGHT: 8, HARDLIGHT: 9, DIFFERENCE: 10, EXCLUSION: 11, HUE: 12, SATURATION: 13, COLORBLEND: 14, LUMINOSITY: 15 };
const GradientType = { LINEAR: 1, RADIAL: 2 };
const rgb = (r, g, b) => ({ typename: "RGBColor", red: r, green: g, blue: b });
const pt = (a, l, r) => ({ anchor: a, leftDirection: l ?? a, rightDirection: r ?? a });

const blob = {
  typename: "PathItem", name: "blob", geometricBounds: [110, 400, 160, 350], opacity: 50, hidden: false, locked: false,
  blendingMode: BlendModes.MULTIPLY, filled: true, stroked: true, strokeWidth: 2, closed: true,
  fillColor: { typename: "GradientColor", angle: -90, gradient: { type: GradientType.LINEAR, gradientStops: [{ rampPoint: 0, color: rgb(255, 0, 0) }, { rampPoint: 100, color: rgb(0, 0, 255) }] } },
  strokeColor: rgb(17, 17, 17),
  pathPoints: [pt([110, 400], null, [120, 400]), pt([160, 375], [150, 400]), pt([110, 350])],
};
blob.pathPoints.length = 3;
const group = { typename: "GroupItem", name: "wrap", geometricBounds: [100, 400, 200, 300], opacity: 100, clipped: true, pageItems: [blob] };

const doc = { artboards: { getActiveArtboardIndex: () => 0, 0: { artboardRect: [100, 400, 500, 0] } }, selection: [group], gradients: {} };
const ctx = { app: { name: "Adobe Illustrator", documents: { length: 1 }, activeDocument: doc }, BlendModes, GradientType, BlendingMode: {}, CompItem: class {} };
ctx.app.documents[0] = doc;
vm.runInNewContext(fs.readFileSync(new URL("../plugins/adobe-cep/host.jsx", import.meta.url), "utf8") + "\nthis.LB = LB;", ctx);

const out = JSON.parse(ctx.LB.selection());
assert.equal(out.length, 1);
const g = out[0];
assert.equal(g.type, "group");
assert.equal(g.clipChildren, true);
assert.equal(g.x, 0);   // artboard-relative: 100 - 100
assert.equal(g.y, 0);   // 400 - 400
const p = g.children[0];
assert.equal(p.type, "path");
assert.equal(p.blendMode, "multiply");
assert.equal(p.opacity, 0.5);
assert.equal(p.fills[0].type, "linear");
assert.equal(p.fills[0].angle, 90);
assert.equal(p.strokes[0].width, 2);
assert.equal(p.path[0].closed, true);
assert.equal(p.path[0].nodes.length, 3);
assert.equal(p.path[0].nodes[0].outX, 20 - 10, "handle expressed relative to the layer origin");
assert.equal(p.path[0].nodes[0].inX, undefined, "no in-handle when it coincides with the anchor");

validateLayers(out); // the hub accepts what the plugin emits
console.log("adobe-mock: all checks passed");
