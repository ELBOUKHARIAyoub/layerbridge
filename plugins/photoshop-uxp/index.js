// Photoshop UXP panel. Untested against a live Photoshop; the batchPlay
// descriptors follow Photoshop's "make contentLayer" recording.
const { app, action, core } = require("photoshop");

const hexToRgb = (h) => ({ red: parseInt(h.slice(1, 3), 16), green: parseInt(h.slice(3, 5), 16), blue: parseInt(h.slice(5, 7), 16) });
const px = (v) => ({ _unit: "pixelsUnit", _value: v });

async function createShape(l) {
  const x = l.x || 0, y = l.y || 0, w = l.width || 1, h = l.height || 1;
  const bounds = { _obj: "rectangle", top: px(y), left: px(x), bottom: px(y + h), right: px(x + w) };
  const shape =
    l.type === "ellipse"
      ? { _obj: "ellipse", top: px(y), left: px(x), bottom: px(y + h), right: px(x + w) }
      : l.cornerRadius
        ? { ...bounds, unitValueQuadVersion: 1, topRight: px(l.cornerRadius), topLeft: px(l.cornerRadius), bottomLeft: px(l.cornerRadius), bottomRight: px(l.cornerRadius) }
        : bounds;
  await action.batchPlay(
    [{
      _obj: "make",
      _target: [{ _ref: "contentLayer" }],
      using: {
        _obj: "contentLayer",
        type: { _obj: "solidColorLayer", color: { _obj: "RGBColor", ...hexToRgb(l.fill || "#CCCCCC") } },
        shape,
      },
    }],
    {},
  );
  app.activeDocument.activeLayers[0].name = l.name || l.type;
}

async function createLayers(layers) {
  const doc = app.activeDocument;
  if (!doc) return "Open a document first";
  let n = 0;
  await core.executeAsModal(async () => {
    const make = async (l) => {
      if (l.type === "group") { for (const c of l.children || []) await make(c); return; }
      if (l.type === "text") {
        const t = await doc.createTextLayer({
          contents: (l.text && l.text.content) || "",
          fontSize: (l.text && l.text.fontSize) || 16,
          position: { x: l.x || 0, y: (l.y || 0) + ((l.text && l.text.fontSize) || 16) },
        });
        t.name = l.name || "Text";
      } else if (l.type === "image") {
        return; // not supported yet
      } else {
        await createShape(l);
      }
      n++;
    };
    for (const l of layers) await make(l);
  }, { commandName: "LayerBridge" });
  return `${n} layer(s) created`;
}

function selection() {
  const doc = app.activeDocument;
  if (!doc) return [];
  return doc.activeLayers.map((L) => {
    const b = L.bounds;
    const item = { type: L.kind === "text" ? "text" : "rect", name: L.name, x: b.left, y: b.top, width: b.right - b.left, height: b.bottom - b.top, ...(L.opacity !== undefined ? { opacity: L.opacity / 100 } : {}) };
    if (L.kind === "text" && L.textItem) item.text = { content: L.textItem.contents, fontSize: L.textItem.characterStyle.size };
    return item;
  });
}

function summary() {
  const doc = app.activeDocument;
  if (!doc) return { count: 0, hint: "Open a document to send layers" };
  const kinds = { shapes: 0, text: 0, groups: 0, images: 0, other: 0 };
  for (const L of doc.activeLayers) {
    if (L.kind === "text") kinds.text++;
    else if (L.kind === "group") kinds.groups++;
    else if (L.kind === "pixel") kinds.images++;
    else if (L.kind === "shape" || L.kind === "vector") kinds.shapes++;
    else kinds.other++;
  }
  return { count: doc.activeLayers.length, kinds, where: doc.name, hint: "Select layers in Photoshop to send them" };
}

LBPanel.mount({
  host: "PHXS",
  getSummary: async () => summary(),
  getLayers: async () => selection(),
  applyLayers: (layers) => createLayers(layers),
});
