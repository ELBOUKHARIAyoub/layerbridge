// FigCraft adapter (layer format v2, see ../protocol.mjs).
//
// FigCraft has no plugin API, but `figcraft --control <port>` opens a loopback
// TCP socket speaking newline-delimited JSON (docs/control-protocol.md in
// storytold/figcraft). Verified against figcraft 0.11.2:
//   - node.create {type, x, y, width, height, parent, name, text, path, props} -> {id}
//   - node.get {id, depth} -> layer with `children`
//   - file.export {ids, format:"svg"|"png"} -> {data: base64}
//   - file.import {data: base64, name, x, y} -> {id}
//   - rotation is counter-clockwise (neutral format is clockwise) and rotates
//     about the centre, so x,y are re-pinned after rotating
//   - blend names are camelCase, shadow offset is [x, y], colours are {r,g,b,a}
import net from "node:net";

export class FigCraftClient {
  constructor({ port = 7979, host = "127.0.0.1", timeoutMs = 15000 } = {}) {
    this.port = port;
    this.host = host;
    this.timeoutMs = timeoutMs;
    this.nextId = 1;
    this.pending = new Map();
    this.buf = "";
    this.socket = null;
  }

  connect() {
    return new Promise((resolve, reject) => {
      const s = net.connect(this.port, this.host);
      s.setEncoding("utf8");
      s.once("connect", () => {
        this.socket = s;
        resolve();
      });
      s.once("error", reject);
      s.on("data", (d) => this.#onData(d));
      s.on("close", () => {
        for (const p of this.pending.values()) p.reject(new Error("FigCraft connection closed"));
        this.pending.clear();
        this.socket = null;
      });
    });
  }

  #onData(chunk) {
    this.buf += chunk;
    let i;
    while ((i = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, i);
      this.buf = this.buf.slice(i + 1);
      if (!line.trim()) continue;
      const msg = JSON.parse(line);
      const p = this.pending.get(msg.id);
      if (!p) continue;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.ok) p.resolve(msg.result);
      else p.reject(new Error(msg.error || "FigCraft error"));
    }
  }

  call(method, params = {}) {
    if (!this.socket) return Promise.reject(new Error("not connected to FigCraft"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`FigCraft call timed out: ${method}`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.write(JSON.stringify({ id, method, params }) + "\n");
    });
  }

  execute(command, params) {
    return this.call("engine.execute", { command, params });
  }

  close() {
    this.socket?.end();
  }
}

// ---------- small helpers ----------
const HEX6 = /^#[0-9a-fA-F]{6}/;
const toHex = (c) => "#" + [c.r, c.g, c.b].map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, "0")).join("").toUpperCase();
const fromHex = (h) => ({ r: parseInt(h.slice(1, 3), 16) / 255, g: parseInt(h.slice(3, 5), 16) / 255, b: parseInt(h.slice(5, 7), 16) / 255 });
const kebabToCamel = (s) => s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
const camelToKebab = (s) => s.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase());
const round = (v) => Math.round(v * 1000) / 1000;

// ---------- neutral path nodes <-> SVG path data ----------
export function nodesToSvg(subpaths) {
  return subpaths
    .map((sp) => {
      const n = sp.nodes;
      if (!n.length) return "";
      const seg = (a, b) =>
        a.outX !== undefined || b.inX !== undefined
          ? `C ${a.outX ?? a.x} ${a.outY ?? a.y} ${b.inX ?? b.x} ${b.inY ?? b.y} ${b.x} ${b.y}`
          : `L ${b.x} ${b.y}`;
      let d = `M ${n[0].x} ${n[0].y}`;
      for (let k = 1; k < n.length; k++) d += " " + seg(n[k - 1], n[k]);
      if (sp.closed && n.length > 1) d += " " + seg(n[n.length - 1], n[0]) + " Z";
      return d;
    })
    .join(" ");
}

// Parses M L H V C S Q T Z (absolute and relative). Arcs are not supported.
export function svgToNodes(d) {
  const tok = d.match(/[a-zA-Z]|-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/g) || [];
  const subs = [];
  let cur = null, i = 0, cmd = "", cx = 0, cy = 0, sx = 0, sy = 0, lastC2 = null, lastQ = null;
  const num = () => parseFloat(tok[i++]);
  const move = (x, y) => { cur = { closed: false, nodes: [{ x, y }] }; subs.push(cur); sx = cx = x; sy = cy = y; };
  const close = () => {
    if (!cur) return;
    cur.closed = true;
    const first = cur.nodes[0], last = cur.nodes[cur.nodes.length - 1];
    if (cur.nodes.length > 1 && last.x === first.x && last.y === first.y) {
      if (last.inX !== undefined) { first.inX = last.inX; first.inY = last.inY; }
      cur.nodes.pop();
    }
    cx = sx; cy = sy;
  };
  const cubic = (x1, y1, x2, y2, x, y) => {
    const prev = cur.nodes[cur.nodes.length - 1];
    if (x1 !== prev.x || y1 !== prev.y) { prev.outX = x1; prev.outY = y1; }
    const n = { x, y };
    if (x2 !== x || y2 !== y) { n.inX = x2; n.inY = y2; }
    cur.nodes.push(n);
    cx = x; cy = y; lastC2 = [x2, y2]; lastQ = null;
  };
  while (i < tok.length) {
    if (/[a-zA-Z]/.test(tok[i])) cmd = tok[i++];
    const rel = cmd === cmd.toLowerCase(), C = cmd.toUpperCase();
    const ox = rel ? cx : 0, oy = rel ? cy : 0;
    if (C === "Z") { close(); lastC2 = lastQ = null; continue; }
    if (C === "M") { move(num() + ox, num() + oy); cmd = rel ? "l" : "L"; lastC2 = lastQ = null; continue; }
    if (!cur) break;
    if (C === "L") { const x = num() + ox, y = num() + oy; cur.nodes.push({ x, y }); cx = x; cy = y; lastC2 = lastQ = null; }
    else if (C === "H") { const x = num() + ox; cur.nodes.push({ x, y: cy }); cx = x; lastC2 = lastQ = null; }
    else if (C === "V") { const y = num() + oy; cur.nodes.push({ x: cx, y }); cy = y; lastC2 = lastQ = null; }
    else if (C === "C") cubic(num() + ox, num() + oy, num() + ox, num() + oy, num() + ox, num() + oy);
    else if (C === "S") {
      const x1 = lastC2 ? 2 * cx - lastC2[0] : cx, y1 = lastC2 ? 2 * cy - lastC2[1] : cy;
      cubic(x1, y1, num() + ox, num() + oy, num() + ox, num() + oy);
    } else if (C === "Q" || C === "T") {
      let qx, qy;
      if (C === "Q") { qx = num() + ox; qy = num() + oy; }
      else { qx = lastQ ? 2 * cx - lastQ[0] : cx; qy = lastQ ? 2 * cy - lastQ[1] : cy; }
      const x = num() + ox, y = num() + oy;
      cubic(cx + (2 / 3) * (qx - cx), cy + (2 / 3) * (qy - cy), x + (2 / 3) * (qx - x), y + (2 / 3) * (qy - y), x, y);
      lastQ = [qx, qy];
    } else break; // arcs and anything else
  }
  return subs.filter((s) => s.nodes.length > 1);
}

// ---------- paints and effects ----------
function toFcPaint(p) {
  if (p.type === "solid") {
    const a = p.opacity === undefined ? 1 : p.opacity;
    return a === 1 ? { type: "solid", color: p.color } : { type: "solid", color: p.color + Math.round(a * 255).toString(16).padStart(2, "0").toUpperCase() };
  }
  const rad = ((p.angle ?? 0) * Math.PI) / 180, c = Math.cos(rad) / 2, s = Math.sin(rad) / 2;
  return {
    type: "gradient",
    kind: p.type === "radial" ? "radial" : "linear",
    from: [round(0.5 - c), round(0.5 - s)],
    to: [round(0.5 + c), round(0.5 + s)],
    stops: p.stops.map((st) => ({
      color: st.opacity === undefined || st.opacity === 1 ? st.color : { ...fromHex(st.color), a: st.opacity },
      position: st.pos,
    })),
  };
}
function fromFcPaint(p) {
  if (p.visible === false) return null;
  if (p.type === "solid") {
    const hex = String(p.color);
    const out = { type: "solid", color: hex.slice(0, 7).toUpperCase() };
    if (hex.length === 9) out.opacity = round(parseInt(hex.slice(7, 9), 16) / 255);
    if (typeof p.opacity === "number" && p.opacity !== 1) out.opacity = p.opacity;
    return HEX6.test(out.color) ? out : null;
  }
  if (p.type === "gradient") {
    const [fx, fy] = p.from ?? [0.5, 0], [tx, ty] = p.to ?? [0.5, 1];
    return {
      type: p.kind === "radial" ? "radial" : "linear",
      angle: Math.round((Math.atan2(ty - fy, tx - fx) * 180) / Math.PI),
      stops: p.stops.map((st) => ({ pos: round(st.position), color: toHex(st.color), ...(st.color.a !== undefined && st.color.a !== 1 ? { opacity: round(st.color.a) } : {}) })),
    };
  }
  return null;
}

// Style shared by node.create props and node.set.
function styleProps(l, warnings) {
  const props = {};
  if (l.fills) props.fills = l.fills.map(toFcPaint);
  else if (l.type !== "text") props.fills = [];
  if (l.strokes?.length) {
    props.strokes = l.strokes.map((s) => toFcPaint(s.paint));
    props.strokeWeight = l.strokes[0].width;
    if (l.strokes[0].align) props.strokeAlign = l.strokes[0].align;
    if (l.strokes[0].dashes) props.dashes = l.strokes[0].dashes;
  }
  if (l.cornerRadius !== undefined && (l.type === "rect" || l.type === "group")) props.cornerRadius = l.cornerRadius;
  if (l.opacity !== undefined) props.opacity = l.opacity;
  if (l.blendMode && l.blendMode !== "normal") props.blend = kebabToCamel(l.blendMode);
  if (l.visible === false) props.visible = false;
  if (l.locked) props.locked = true;
  if (l.mask) props.isMask = true;
  if (l.effects?.length) {
    props.effects = l.effects.map((e) =>
      e.type === "blur"
        ? { type: "layerBlur", radius: e.blur }
        : { type: "dropShadow", offset: [e.x ?? 0, e.y ?? 0], radius: e.blur, color: { ...fromHex(e.color ?? "#000000"), a: e.opacity ?? 0.25 } },
    );
  }
  if (l.type === "text" && l.text) {
    const t = l.text;
    if (t.fontSize) props.fontSize = t.fontSize;
    if (t.fontFamily) props.fontFamily = t.fontFamily;
    if (t.fontStyle) props.fontStyle = t.fontStyle;
    if (t.align) props.textAlign = t.align;
    if (t.lineHeight !== undefined) props.lineHeight = t.lineHeight;
    if (t.letterSpacing !== undefined) props.letterSpacing = t.letterSpacing;
  }
  return props;
}

// ---------- neutral -> FigCraft ----------
export async function pushLayers(fc, layers) {
  const warnings = [];
  let created = 0;

  const roots = [];
  async function make(l, parent) {
    const common = { x: l.x ?? 0, y: l.y ?? 0, name: l.name, select: false, ...(parent !== undefined ? { parent } : {}) };
    const props = styleProps(l, warnings);
    let id;

    if (l.type === "image") {
      const res = await fc.execute("file.import", { data: l.image.data, name: `${l.name || "image"}.${l.image.format}`, x: common.x, y: common.y });
      id = res.id;
      const set = { ids: [id], ...props };
      delete set.fills; // keep the imported image fill
      if (l.width && l.height) { set.width = l.width; set.height = l.height; }
      if (l.name) set.name = l.name;
      if (parent !== undefined) await fc.execute("node.reparent", { ids: [id], parent });
      await fc.execute("node.set", set);
    } else {
      const params = { ...common, props };
      if (l.type === "rect") Object.assign(params, { type: "rectangle", width: l.width, height: l.height });
      else if (l.type === "ellipse") Object.assign(params, { type: "ellipse", width: l.width, height: l.height });
      else if (l.type === "group") { Object.assign(params, { type: "frame", width: l.width, height: l.height }); props.clip = !!l.clipChildren; }
      else if (l.type === "text") Object.assign(params, { type: "text", text: l.text?.content ?? "" });
      else if (l.type === "path") Object.assign(params, { type: "vector", path: nodesToSvg(l.path) });
      id = (await fc.execute("node.create", params)).id;
    }
    created++;
    if (parent === undefined) roots.push(id);

    if (l.rotation) {
      // FigCraft rotates counter-clockwise about the centre; pin the origin back afterwards
      const { x, y } = await fc.call("node.get", { id });
      await fc.execute("node.set", { ids: [id], rotation: -l.rotation });
      await fc.execute("node.set", { ids: [id], x, y });
    }
    for (const c of l.children ?? []) await make(c, id);
  }

  for (const l of layers) await make(l, undefined);
  if (roots.length) await fc.execute("select.set", { ids: roots });
  return { created, warnings };
}

// ---------- FigCraft -> neutral ----------
const VECTOR_LIKE = new Set(["VECTOR", "POLYGON", "STAR", "LINE", "ARROW", "BOOLEAN", "BOOLEAN_OPERATION"]);
const GROUP_LIKE = new Set(["FRAME", "GROUP", "SECTION", "COMPONENT", "INSTANCE"]);

async function exportData(fc, id, format) {
  return (await fc.execute("file.export", { ids: [id], format })).data;
}

async function toNeutral(fc, n, warnings) {
  const out = { name: n.name, x: n.x ?? 0, y: n.y ?? 0, width: n.width ?? 0, height: n.height ?? 0 };
  if (n.rotation) out.rotation = -n.rotation;
  if (typeof n.opacity === "number" && n.opacity !== 1) out.opacity = round(n.opacity);
  if (n.blend && n.blend !== "normal") out.blendMode = camelToKebab(n.blend);
  if (n.visible === false) out.visible = false;
  if (n.locked) out.locked = true;
  if (n.isMask) out.mask = true;

  const fills = (n.fills ?? []).filter((f) => f.visible !== false);
  if (fills.length) {
    const paints = fills.map(fromFcPaint).filter(Boolean);
    if (paints.length) out.fills = paints;
  }
  if (n.strokes?.length) {
    const sp = n.strokes.map(fromFcPaint).filter(Boolean);
    if (sp.length) out.strokes = sp.map((paint) => ({ paint, width: n.strokeWeight ?? 1, ...(n.strokeAlign ? { align: n.strokeAlign } : {}), ...(n.dashes?.length ? { dashes: n.dashes } : {}) }));
  }
  const fx = (n.effects ?? []).filter((e) => e.visible !== false).map((e) =>
    e.type === "dropShadow" ? { type: "dropShadow", x: e.offset?.[0] ?? 0, y: e.offset?.[1] ?? 0, blur: e.radius ?? 0, color: toHex(e.color), opacity: round(e.color.a ?? 1) }
    : e.type === "layerBlur" ? { type: "blur", blur: e.radius ?? 0 } : null).filter(Boolean);
  if (fx.length) out.effects = fx;

  if (fills.some((f) => f.type === "image")) {
    out.type = "image";
    delete out.fills;
    out.image = { format: "png", data: await exportData(fc, n.id, "png") };
    return out;
  }
  if (n.type === "RECTANGLE") {
    out.type = "rect";
    if (n.cornerRadius) out.cornerRadius = n.cornerRadius;
  } else if (n.type === "ELLIPSE") out.type = "ellipse";
  else if (n.type === "TEXT") {
    out.type = "text";
    const fs = n.fontSize ?? 16;
    const lh = typeof n.lineHeight === "number" ? n.lineHeight : undefined;
    const ls = typeof n.letterSpacing === "number" ? n.letterSpacing : typeof n.letterSpacing === "string" && n.letterSpacing.endsWith("%") ? (parseFloat(n.letterSpacing) / 100) * fs : undefined;
    out.text = { content: n.characters ?? "", fontSize: fs, fontFamily: n.fontFamily, fontStyle: n.fontStyle, align: n.textAlign, ...(lh !== undefined ? { lineHeight: lh } : {}), ...(ls ? { letterSpacing: round(ls) } : {}) };
  } else if (GROUP_LIKE.has(n.type)) {
    out.type = "group";
    if (n.clip) out.clipChildren = true;
    if (n.cornerRadius) out.cornerRadius = n.cornerRadius;
    out.children = [];
    for (const c of n.children ?? []) out.children.push(await toNeutral(fc, c, warnings));
  } else if (VECTOR_LIKE.has(n.type)) {
    const svg = Buffer.from(await exportData(fc, n.id, "svg"), "base64").toString("utf8");
    const subs = [...svg.matchAll(/\bd="([^"]+)"/g)].flatMap((m) => svgToNodes(m[1]));
    if (subs.length) { out.type = "path"; out.path = subs; }
    else { out.type = "image"; out.image = { format: "png", data: await exportData(fc, n.id, "png") }; warnings.push(`${n.name}: path rasterised`); }
  } else {
    out.type = "image";
    out.image = { format: "png", data: await exportData(fc, n.id, "png") };
    warnings.push(`${n.name}: ${n.type} rasterised`);
  }
  return out;
}

export async function pullSelection(fc) {
  const doc = await fc.call("document.inspect", { depth: 1 });
  const warnings = [];
  const layers = [];
  for (const id of doc?.selection ?? []) {
    layers.push(await toNeutral(fc, await fc.call("node.get", { id, depth: 12 }), warnings));
  }
  return { layers, warnings };
}
