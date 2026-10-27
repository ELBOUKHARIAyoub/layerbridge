// Neutral wire format shared by the hub and every plugin (layer format v2).
//
// Layer {
//   type: "rect" | "ellipse" | "text" | "group" | "image" | "path",
//   name, x, y, width, height,           // design pixels, y down, origin top-left of parent
//   rotation?: degrees clockwise, visible?: bool, locked?: bool,
//   opacity?: 0..1, blendMode?: BLEND_MODES[number],
//   fills?: Paint[], strokes?: Stroke[],  // bottom -> top
//   cornerRadius?: number | [tl, tr, br, bl],
//   path?: { closed: bool, nodes: [{ x, y, inX?, inY?, outX?, outY? }] }[]
//          // one entry per sub-path; coordinates relative to the layer's x,y;
//          // in*/out* are absolute bezier handles (same space as x,y)
//   text?: { content, fontSize, fontFamily?, fontStyle?, align?, lineHeight?, letterSpacing? },
//   image?: { format: "png" | "jpg", data: base64 },
//   effects?: [{ type: "dropShadow" | "blur", x?, y?, blur, color?, opacity? }],
//   clipChildren?: bool, mask?: bool,     // group clipping / this layer masks the ones above
//   children?: Layer[],
//   fill?, stroke?, strokeWidth?          // legacy shorthand, normalised into fills/strokes
// }
// Paint  = { type: "solid", color: "#RRGGBB", opacity? }
//        | { type: "linear" | "radial", stops: [{ pos: 0..1, color, opacity? }], angle? }
// Stroke = { paint: Paint, width, align?: "center"|"inside"|"outside", cap?, join?, dashes?: number[] }
//
// Client -> hub:  hello | push | pull | pullResult
// Hub -> client:  welcome | hosts | push | pull | pullResult | ack | error

export const HOSTS = ["AEFT", "ILST", "PHXS", "FIGMA", "FIGCRAFT", "BLENDER"];
export const LAYER_TYPES = ["rect", "ellipse", "text", "group", "image", "path"];
export const BLEND_MODES = [
  "normal", "darken", "multiply", "color-burn", "lighten", "screen", "color-dodge",
  "overlay", "soft-light", "hard-light", "difference", "exclusion", "hue", "saturation", "color", "luminosity",
];

const MAX_DEPTH = 32;
const MAX_LAYERS = 20000;
const MAX_PATH_NODES = 100000;
const HEX = /^#[0-9a-fA-F]{6}$/;

const fail = (m) => {
  throw new Error(m);
};
const num = (v, what) => Number.isFinite(v) || fail(`${what} must be a number`);
const unit = (v, what) => (Number.isFinite(v) && v >= 0 && v <= 1) || fail(`${what} must be 0..1`);

function checkPaint(p, what) {
  if (!p || typeof p !== "object") fail(`${what} must be an object`);
  if (p.type === "solid") {
    HEX.test(p.color) || fail(`${what}.color must be #RRGGBB`);
  } else if (p.type === "linear" || p.type === "radial") {
    (Array.isArray(p.stops) && p.stops.length >= 2) || fail(`${what}.stops needs 2+ entries`);
    for (const s of p.stops) {
      unit(s.pos, `${what}.stops.pos`);
      HEX.test(s.color) || fail(`${what}.stops.color must be #RRGGBB`);
      if (s.opacity !== undefined) unit(s.opacity, `${what}.stops.opacity`);
    }
    if (p.angle !== undefined) num(p.angle, `${what}.angle`);
  } else fail(`unknown paint type: ${p.type}`);
  if (p.opacity !== undefined) unit(p.opacity, `${what}.opacity`);
}

function checkLayer(l, depth, counters) {
  if (depth > MAX_DEPTH) fail("layer tree too deep");
  if (++counters.layers > MAX_LAYERS) fail("too many layers");
  if (!l || typeof l !== "object" || Array.isArray(l)) fail("layer must be an object");
  LAYER_TYPES.includes(l.type) || fail(`unknown layer type: ${l.type}`);
  for (const k of ["x", "y", "width", "height", "rotation"]) if (l[k] !== undefined) num(l[k], k);
  if (l.opacity !== undefined) unit(l.opacity, "opacity");
  if (l.blendMode !== undefined && !BLEND_MODES.includes(l.blendMode)) fail(`unknown blendMode: ${l.blendMode}`);
  if (l.cornerRadius !== undefined) {
    const cr = Array.isArray(l.cornerRadius) ? l.cornerRadius : [l.cornerRadius];
    (cr.length === 1 || cr.length === 4) && cr.every(Number.isFinite) || fail("cornerRadius must be a number or 4 numbers");
  }
  for (const k of ["fill", "stroke"]) if (l[k] !== undefined && !HEX.test(l[k])) fail(`${k} must be #RRGGBB`);
  l.fills?.forEach((p, i) => checkPaint(p, `fills[${i}]`));
  l.strokes?.forEach((s, i) => {
    checkPaint(s?.paint, `strokes[${i}].paint`);
    num(s.width, `strokes[${i}].width`);
  });
  for (const e of l.effects ?? []) {
    ["dropShadow", "blur"].includes(e?.type) || fail(`unknown effect type: ${e?.type}`);
    num(e.blur, "effect.blur");
    if (e.color !== undefined && !HEX.test(e.color)) fail("effect.color must be #RRGGBB");
  }
  if (l.path !== undefined) {
    Array.isArray(l.path) || fail("path must be an array of sub-paths");
    for (const sp of l.path) {
      Array.isArray(sp?.nodes) || fail("sub-path needs nodes");
      counters.nodes += sp.nodes.length;
      counters.nodes <= MAX_PATH_NODES || fail("too many path nodes");
      for (const n of sp.nodes) {
        num(n.x, "node.x");
        num(n.y, "node.y");
        for (const k of ["inX", "inY", "outX", "outY"]) if (n[k] !== undefined) num(n[k], `node.${k}`);
      }
    }
  }
  if (l.type === "path" && !l.path?.length) fail("path layer needs a path");
  if (l.image !== undefined) {
    ["png", "jpg"].includes(l.image?.format) || fail("image.format must be png or jpg");
    (typeof l.image.data === "string" && l.image.data.length > 0) || fail("image.data must be base64");
  }
  if (l.type === "image" && !l.image) fail("image layer needs image data");
  if (l.text !== undefined && typeof l.text?.content !== "string") fail("text.content must be a string");
  l.children?.forEach((c) => checkLayer(c, depth + 1, counters));
}

// Fold the legacy fill/stroke shorthand into fills/strokes, and mirror the
// first solid fill back to `fill` so older plugins keep working.
function normalizeLayer(l) {
  const out = { ...l };
  if (!out.fills && out.fill) out.fills = [{ type: "solid", color: out.fill }];
  if (!out.strokes && out.stroke) {
    out.strokes = [{ paint: { type: "solid", color: out.stroke }, width: out.strokeWidth ?? 1 }];
  }
  const first = out.fills?.find((p) => p.type === "solid");
  if (first && !out.fill) out.fill = first.color;
  if (out.children) out.children = out.children.map(normalizeLayer);
  return out;
}

export function validateLayers(layers) {
  Array.isArray(layers) || fail("layers must be an array");
  const counters = { layers: 0, nodes: 0 };
  layers.forEach((l) => checkLayer(l, 0, counters));
  return layers.map(normalizeLayer);
}

export function parseMessage(raw) {
  const msg = JSON.parse(raw);
  if (!msg || typeof msg.type !== "string") fail("missing message type");
  return msg;
}
