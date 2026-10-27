// Runs in Figma's plugin sandbox (layer format v2, see hub/protocol.mjs).
// The UI iframe owns the WebSocket.
figma.showUI(__html__, { width: 300, height: 440 });

const clamp01 = (v) => Math.min(1, Math.max(0, v));
const hex = (c) => "#" + [c.r, c.g, c.b].map((v) => Math.round(clamp01(v) * 255).toString(16).padStart(2, "0")).join("").toUpperCase();
const rgb = (h) => ({ r: parseInt(h.slice(1, 3), 16) / 255, g: parseInt(h.slice(3, 5), 16) / 255, b: parseInt(h.slice(5, 7), 16) / 255 });
const toBlend = (m) => (m || "normal").toUpperCase().replace(/-/g, "_");
const fromBlend = (m) => (m === "PASS_THROUGH" ? "normal" : String(m || "NORMAL").toLowerCase().replace(/_/g, "-"));

// ---------- SVG path data <-> neutral nodes (Figma emits absolute M/L/C/Q/Z) ----------
function parsePath(d) {
  const tok = d.match(/[MLCQZ]|-?\d*\.?\d+(?:e[-+]?\d+)?/gi) || [];
  const subs = [];
  let cur = null, i = 0, cmd = "";
  const num = () => parseFloat(tok[i++]);
  while (i < tok.length) {
    if (/[A-Za-z]/.test(tok[i])) cmd = tok[i++].toUpperCase();
    if (cmd === "Z") {
      if (cur) {
        cur.closed = true;
        const first = cur.nodes[0], last = cur.nodes[cur.nodes.length - 1];
        // a closing segment that ends on the start point is the same node: keep its in-handle
        if (cur.nodes.length > 1 && last.x === first.x && last.y === first.y) {
          if (last.inX !== undefined) { first.inX = last.inX; first.inY = last.inY; }
          cur.nodes.pop();
        }
      }
      continue;
    }
    if (cmd === "M") { cur = { closed: false, nodes: [{ x: num(), y: num() }] }; subs.push(cur); cmd = "L"; continue; }
    if (!cur) break;
    const prev = cur.nodes[cur.nodes.length - 1];
    if (cmd === "L") cur.nodes.push({ x: num(), y: num() });
    else if (cmd === "C") {
      const x1 = num(), y1 = num(), x2 = num(), y2 = num(), x = num(), y = num();
      prev.outX = x1; prev.outY = y1;
      cur.nodes.push({ x, y, inX: x2, inY: y2 });
    } else if (cmd === "Q") {
      const qx = num(), qy = num(), x = num(), y = num();
      prev.outX = prev.x + (2 / 3) * (qx - prev.x); prev.outY = prev.y + (2 / 3) * (qy - prev.y);
      cur.nodes.push({ x, y, inX: x + (2 / 3) * (qx - x), inY: y + (2 / 3) * (qy - y) });
    } else break;
  }
  return subs;
}
function buildPath(sub) {
  const n = sub.nodes;
  const seg = (a, b) =>
    a.outX !== undefined || b.inX !== undefined
      ? `C ${a.outX !== undefined ? a.outX : a.x} ${a.outY !== undefined ? a.outY : a.y} ${b.inX !== undefined ? b.inX : b.x} ${b.inY !== undefined ? b.inY : b.y} ${b.x} ${b.y}`
      : `L ${b.x} ${b.y}`;
  let d = `M ${n[0].x} ${n[0].y}`;
  for (let k = 1; k < n.length; k++) d += " " + seg(n[k - 1], n[k]);
  if (sub.closed && n.length > 1) d += " " + seg(n[n.length - 1], n[0]) + " Z";
  return d;
}

// ---------- paints ----------
function gradientAngleToTransform(deg) {
  const a = ((deg || 0) * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
  return [[c, s, 0.5 - 0.5 * c - 0.5 * s], [-s, c, 0.5 + 0.5 * s - 0.5 * c]];
}
function toFigmaPaint(p) {
  if (p.type === "solid") return { type: "SOLID", color: rgb(p.color), opacity: p.opacity === undefined ? 1 : p.opacity };
  return {
    type: p.type === "radial" ? "GRADIENT_RADIAL" : "GRADIENT_LINEAR",
    gradientTransform: gradientAngleToTransform(p.angle),
    gradientStops: p.stops.map((s) => ({ position: s.pos, color: Object.assign(rgb(s.color), { a: s.opacity === undefined ? 1 : s.opacity }) })),
    opacity: p.opacity === undefined ? 1 : p.opacity,
  };
}
function fromFigmaPaint(p) {
  if (p.visible === false) return null;
  if (p.type === "SOLID") return { type: "solid", color: hex(p.color), ...(p.opacity !== undefined && p.opacity !== 1 ? { opacity: p.opacity } : {}) };
  if (p.type === "GRADIENT_LINEAR" || p.type === "GRADIENT_RADIAL") {
    const m = p.gradientTransform;
    return {
      type: p.type === "GRADIENT_RADIAL" ? "radial" : "linear",
      angle: Math.round((Math.atan2(m[0][1], m[0][0]) * 180) / Math.PI),
      stops: p.gradientStops.map((s) => ({ pos: s.position, color: hex(s.color), ...(s.color.a !== 1 ? { opacity: s.color.a } : {}) })),
    };
  }
  return null; // IMAGE paints are handled by exporting the node
}

// ---------- Figma -> neutral ----------
async function toNeutral(n, depth) {
  const out = { name: n.name, x: n.x, y: n.y, width: n.width, height: n.height };
  if (n.rotation) out.rotation = -n.rotation; // Figma rotates counter-clockwise
  if (n.visible === false) out.visible = false;
  if (n.locked) out.locked = true;
  if (typeof n.opacity === "number" && n.opacity !== 1) out.opacity = n.opacity;
  if (n.blendMode && n.blendMode !== "PASS_THROUGH" && n.blendMode !== "NORMAL") out.blendMode = fromBlend(n.blendMode);
  if (n.isMask) out.mask = true;

  const fills = Array.isArray(n.fills) ? n.fills : [];
  const hasImage = fills.some((f) => f.type === "IMAGE" && f.visible !== false);
  const paints = fills.map(fromFigmaPaint).filter(Boolean);
  if (paints.length) out.fills = paints;
  if (Array.isArray(n.strokes) && n.strokes.length && n.strokeWeight !== figma.mixed) {
    const sp = n.strokes.map(fromFigmaPaint).filter(Boolean);
    if (sp.length) {
      out.strokes = sp.map((paint) => ({
        paint,
        width: n.strokeWeight,
        align: String(n.strokeAlign || "CENTER").toLowerCase(),
        ...(n.dashPattern && n.dashPattern.length ? { dashes: n.dashPattern } : {}),
      }));
    }
  }
  const fx = (n.effects || []).filter((e) => e.visible !== false).map((e) =>
    e.type === "DROP_SHADOW"
      ? { type: "dropShadow", x: e.offset.x, y: e.offset.y, blur: e.radius, color: hex(e.color), opacity: e.color.a }
      : e.type === "LAYER_BLUR" ? { type: "blur", blur: e.radius } : null).filter(Boolean);
  if (fx.length) out.effects = fx;

  if (hasImage) {
    out.type = "image";
    out.image = { format: "png", data: figma.base64Encode(await n.exportAsync({ format: "PNG" })) };
    return out;
  }
  switch (n.type) {
    case "ELLIPSE": out.type = "ellipse"; break;
    case "TEXT":
      out.type = "text";
      out.text = {
        content: n.characters,
        fontSize: typeof n.fontSize === "number" ? n.fontSize : 16,
        ...(n.fontName !== figma.mixed ? { fontFamily: n.fontName.family, fontStyle: n.fontName.style } : {}),
        align: String(n.textAlignHorizontal || "LEFT").toLowerCase(),
        ...(n.letterSpacing !== figma.mixed && n.letterSpacing.unit === "PIXELS" ? { letterSpacing: n.letterSpacing.value } : {}),
        ...(n.lineHeight !== figma.mixed && n.lineHeight.unit === "PIXELS" ? { lineHeight: n.lineHeight.value } : {}),
      };
      break;
    case "RECTANGLE": case "FRAME": case "GROUP": case "COMPONENT": case "INSTANCE": case "SECTION":
      if ("children" in n && n.type !== "RECTANGLE") {
        out.type = "group";
        if (n.clipsContent) out.clipChildren = true;
        out.children = [];
        if (depth < 24) for (const c of n.children) out.children.push(await toNeutral(c, depth + 1));
      } else out.type = "rect";
      if ("topLeftRadius" in n) {
        const r = [n.topLeftRadius, n.topRightRadius, n.bottomRightRadius, n.bottomLeftRadius];
        if (r.some((v) => v)) out.cornerRadius = r.every((v) => v === r[0]) ? r[0] : r;
      }
      break;
    default: {
      // vectors, stars, polygons, lines, boolean ops: use the resolved geometry
      const geo = n.fillGeometry && n.fillGeometry.length ? n.fillGeometry : n.vectorPaths;
      if (geo && geo.length) {
        out.type = "path";
        out.path = geo.flatMap((g) => parsePath(g.data));
      } else {
        out.type = "image";
        out.image = { format: "png", data: figma.base64Encode(await n.exportAsync({ format: "PNG" })) };
      }
    }
  }
  return out;
}

// ---------- neutral -> Figma ----------
async function build(l, parent) {
  let node;
  if (l.type === "text") {
    node = figma.createText();
    const t = l.text || {};
    let font = { family: t.fontFamily || "Inter", style: t.fontStyle || "Regular" };
    try { await figma.loadFontAsync(font); } catch (e) { font = { family: "Inter", style: "Regular" }; await figma.loadFontAsync(font); }
    node.fontName = font;
    node.characters = t.content || "";
    node.fontSize = t.fontSize || 16;
    if (t.align) node.textAlignHorizontal = t.align.toUpperCase();
    if (t.letterSpacing !== undefined) node.letterSpacing = { value: t.letterSpacing, unit: "PIXELS" };
    if (t.lineHeight !== undefined) node.lineHeight = { value: t.lineHeight, unit: "PIXELS" };
  } else if (l.type === "ellipse") node = figma.createEllipse();
  else if (l.type === "group") { node = figma.createFrame(); node.fills = []; node.clipsContent = !!l.clipChildren; }
  else if (l.type === "path") {
    node = figma.createVector();
    node.vectorPaths = l.path.map((sp) => ({ windingRule: "NONZERO", data: buildPath(sp) }));
  } else node = figma.createRectangle(); // rect and image

  node.name = l.name || l.type;
  if (l.type !== "text" && l.type !== "path") node.resize(Math.max(l.width || 1, 1), Math.max(l.height || 1, 1));
  if (l.rotation) node.rotation = -l.rotation;
  node.x = l.x || 0;
  node.y = l.y || 0;
  if (l.visible === false) node.visible = false;
  if (l.opacity !== undefined) node.opacity = l.opacity;
  if (l.blendMode) node.blendMode = toBlend(l.blendMode);
  if (l.mask) node.isMask = true;

  if (l.type === "image") {
    const img = figma.createImage(figma.base64Decode(l.image.data));
    node.fills = [{ type: "IMAGE", imageHash: img.hash, scaleMode: "FILL" }];
  } else if (l.type !== "group" && l.fills) node.fills = l.fills.map(toFigmaPaint);
  else if (l.type !== "group" && l.type !== "text" && l.type !== "path") node.fills = [];

  if (l.strokes && l.strokes.length && "strokes" in node) {
    node.strokes = l.strokes.map((s) => toFigmaPaint(s.paint));
    node.strokeWeight = l.strokes[0].width;
    if (l.strokes[0].align && "strokeAlign" in node) node.strokeAlign = l.strokes[0].align.toUpperCase();
    if (l.strokes[0].dashes) node.dashPattern = l.strokes[0].dashes;
  }
  if (l.cornerRadius !== undefined && "topLeftRadius" in node) {
    const r = Array.isArray(l.cornerRadius) ? l.cornerRadius : [l.cornerRadius, l.cornerRadius, l.cornerRadius, l.cornerRadius];
    node.topLeftRadius = r[0]; node.topRightRadius = r[1]; node.bottomRightRadius = r[2]; node.bottomLeftRadius = r[3];
  }
  if (l.effects) {
    node.effects = l.effects.map((e) => e.type === "blur"
      ? { type: "LAYER_BLUR", radius: e.blur, visible: true }
      : { type: "DROP_SHADOW", color: Object.assign(rgb(e.color || "#000000"), { a: e.opacity === undefined ? 0.25 : e.opacity }), offset: { x: e.x || 0, y: e.y || 0 }, radius: e.blur, visible: true, blendMode: "NORMAL" });
  }
  parent.appendChild(node);
  if (l.locked) node.locked = true;
  for (const c of l.children || []) await build(c, node);
  return node;
}

// What is selected right now, for the panel's summary line.
function summarize() {
  const kinds = { shapes: 0, text: 0, groups: 0, images: 0, other: 0 };
  const sel = figma.currentPage.selection;
  for (const n of sel) {
    if (n.type === "TEXT") kinds.text++;
    else if (["FRAME", "GROUP", "COMPONENT", "INSTANCE", "SECTION"].includes(n.type)) kinds.groups++;
    else if (["RECTANGLE", "ELLIPSE", "VECTOR", "STAR", "POLYGON", "LINE", "BOOLEAN_OPERATION"].includes(n.type)) {
      (Array.isArray(n.fills) && n.fills.some((f) => f.type === "IMAGE")) ? kinds.images++ : kinds.shapes++;
    } else kinds.other++;
  }
  return { count: sel.length, kinds, where: figma.currentPage.name, hint: "Select layers in Figma to send them" };
}
const postSummary = () => figma.ui.postMessage({ type: "summary", summary: summarize() });
figma.on("selectionchange", postSummary);
figma.on("currentpagechange", postSummary);
postSummary();

// Requests carry an id (`req`) that the answer echoes back.
figma.ui.onmessage = async (msg) => {
  try {
    if (msg.type === "getSelection") {
      const layers = [];
      for (const n of figma.currentPage.selection) layers.push(await toNeutral(n, 0));
      figma.ui.postMessage({ type: "selection", req: msg.req, layers });
    } else if (msg.type === "create") {
      const made = [];
      for (const l of msg.layers) made.push(await build(l, figma.currentPage));
      figma.currentPage.selection = made;
      figma.ui.postMessage({ type: "created", req: msg.req, count: made.length });
    }
  } catch (e) {
    figma.notify("LayerBridge error: " + e.message, { error: true });
    figma.ui.postMessage({ type: "error", req: msg.req, error: e.message });
  }
};
