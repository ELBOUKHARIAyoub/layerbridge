// ExtendScript for After Effects (AEFT) and Illustrator (ILST), layer format v2.
// ES3 only: no JSON, no Array.map/forEach, no trailing commas.
// Entry points take a JSON string and return a status string / JSON string.
var LB = (function () {
  var isAE = app.name.indexOf("After Effects") !== -1;
  var warnings = [];

  // ---------- helpers ----------
  function parse(s) { return eval("(" + s + ")"); } // input comes from our own panel
  function jsonify(v) {
    if (v === null || v === undefined) return "null";
    if (typeof v === "string") return '"' + v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r/g, "\\r").replace(/\n/g, "\\n") + '"';
    if (typeof v === "number") return isFinite(v) ? String(v) : "0";
    if (typeof v === "boolean") return String(v);
    var i, parts = [];
    if (v instanceof Array) { for (i = 0; i < v.length; i++) parts.push(jsonify(v[i])); return "[" + parts.join(",") + "]"; }
    for (var k in v) if (v[k] !== undefined) parts.push(jsonify(k) + ":" + jsonify(v[k]));
    return "{" + parts.join(",") + "}";
  }
  function hex2(v) { var s = Math.round(Math.max(0, Math.min(255, v))).toString(16); return s.length < 2 ? "0" + s : s; }
  function toHex(r, g, b) { return ("#" + hex2(r) + hex2(g) + hex2(b)).toUpperCase(); } // 0..255
  function fromHex(h) { return [parseInt(h.substr(1, 2), 16), parseInt(h.substr(3, 2), 16), parseInt(h.substr(5, 2), 16)]; }
  function warnOnce(msg) { for (var i = 0; i < warnings.length; i++) if (warnings[i] === msg) return; warnings.push(msg); }
  function firstSolid(paints) {
    if (!paints) return null;
    for (var i = paints.length - 1; i >= 0; i--) if (paints[i].type === "solid") return paints[i];
    if (paints.length) { warnOnce("gradient approximated"); return { type: "solid", color: paints[0].stops[0].color }; }
    return null;
  }
  function paintOpacity(p) { return p && p.opacity !== undefined ? p.opacity : 1; }
  function result(n) {
    var msg = n + " layer(s) created";
    if (warnings.length) msg += " (" + warnings.join("; ") + ")";
    return msg;
  }
  var BLEND = ["normal", "darken", "multiply", "color-burn", "lighten", "screen", "color-dodge", "overlay", "soft-light", "hard-light", "difference", "exclusion", "hue", "saturation", "color", "luminosity"];
  function blendIndex(name) { for (var i = 0; i < BLEND.length; i++) if (BLEND[i] === name) return i; return 0; }

  // =====================================================================
  // After Effects
  // =====================================================================
  function aeBlend(name) {
    var m = {
      "normal": BlendingMode.NORMAL, "darken": BlendingMode.DARKEN, "multiply": BlendingMode.MULTIPLY, "color-burn": BlendingMode.COLOR_BURN,
      "lighten": BlendingMode.LIGHTEN, "screen": BlendingMode.SCREEN, "color-dodge": BlendingMode.COLOR_DODGE, "overlay": BlendingMode.OVERLAY,
      "soft-light": BlendingMode.SOFT_LIGHT, "hard-light": BlendingMode.HARD_LIGHT, "difference": BlendingMode.DIFFERENCE,
      "exclusion": BlendingMode.EXCLUSION, "hue": BlendingMode.HUE, "saturation": BlendingMode.SATURATION, "color": BlendingMode.COLOR, "luminosity": BlendingMode.LUMINOSITY
    };
    return m[name];
  }
  function aeStyle(contents, l) {
    // AE can't script gradient stops, so gradients fall back to the first stop
    var fill = firstSolid(l.fills);
    if (fill) {
      var f = contents.addProperty("ADBE Vector Graphic - Fill");
      var c = fromHex(fill.color);
      f.property("ADBE Vector Fill Color").setValue([c[0] / 255, c[1] / 255, c[2] / 255]);
      f.property("ADBE Vector Fill Opacity").setValue(paintOpacity(fill) * 100);
    }
    if (l.strokes && l.strokes.length) {
      var s = l.strokes[0], sp = firstSolid([s.paint]);
      if (sp) {
        var st = contents.addProperty("ADBE Vector Graphic - Stroke"), sc = fromHex(sp.color);
        st.property("ADBE Vector Stroke Color").setValue([sc[0] / 255, sc[1] / 255, sc[2] / 255]);
        st.property("ADBE Vector Stroke Width").setValue(s.width);
        st.property("ADBE Vector Stroke Opacity").setValue(paintOpacity(sp) * 100);
        if (s.align && s.align !== "center") warnOnce("stroke align is center-only in AE");
      }
    }
  }
  function aeShapeFromSub(sub) {
    var sh = new Shape(), v = [], inT = [], outT = [], i, n;
    for (i = 0; i < sub.nodes.length; i++) {
      n = sub.nodes[i];
      v.push([n.x, n.y]);
      inT.push(n.inX !== undefined ? [n.inX - n.x, n.inY - n.y] : [0, 0]);  // AE tangents are relative to the vertex
      outT.push(n.outX !== undefined ? [n.outX - n.x, n.outY - n.y] : [0, 0]);
    }
    sh.vertices = v; sh.inTangents = inT; sh.outTangents = outT; sh.closed = !!sub.closed;
    return sh;
  }
  // opacity is the effective value (own x inherited from groups); guide layers carry only the transform
  function aeCommon(layer, l, opacity, isGuide) {
    var t = layer.property("Transform");
    layer.name = l.name || l.type;
    t.property("Position").setValue([l.x || 0, l.y || 0]); // relative to the parent group layer
    if (l.rotation) t.property("Rotation").setValue(l.rotation); // AE rotates clockwise, like the neutral format
    if (!isGuide) {
      if (opacity !== 1) t.property("Opacity").setValue(opacity * 100);
      if (l.blendMode && l.blendMode !== "normal") layer.blendingMode = aeBlend(l.blendMode);
    }
    if (l.effects && !isGuide) {
      for (var i = 0; i < l.effects.length; i++) {
        var e = l.effects[i], fx;
        if (e.type === "dropShadow") {
          fx = layer.property("Effects").addProperty("ADBE Drop Shadow");
          var c = fromHex(e.color || "#000000"), x = e.x || 0, y = e.y || 0;
          fx.property("ADBE Drop Shadow-0001").setValue([c[0] / 255, c[1] / 255, c[2] / 255, 1]);
          fx.property("ADBE Drop Shadow-0002").setValue((e.opacity === undefined ? 0.25 : e.opacity) * 255);
          fx.property("ADBE Drop Shadow-0003").setValue(Math.atan2(x, -y) * 180 / Math.PI);
          fx.property("ADBE Drop Shadow-0004").setValue(Math.sqrt(x * x + y * y));
          fx.property("ADBE Drop Shadow-0005").setValue(e.blur);
        } else if (e.type === "blur") {
          fx = layer.property("Effects").addProperty("ADBE Gaussian Blur 2");
          fx.property("ADBE Gaussian Blur 2-0001").setValue(e.blur);
        }
      }
    }
    if (l.visible === false) layer.enabled = false;
    if (l.locked) layer.locked = true;
  }
  function aeCreate(layers) {
    var comp = app.project.activeItem;
    if (!(comp instanceof CompItem)) return "Open a composition first";
    var n = 0;

    // Layer split: each group becomes an invisible guide layer and its art is parented to it,
    // so x/y stay relative to the group exactly as in the neutral format.
    function make(l, parent, inherited) {
      var i, layer, op = (l.opacity === undefined ? 1 : l.opacity) * inherited;

      if (l.type === "group") {
        var gw = l.width || 1, gh = l.height || 1;
        layer = comp.layers.addShape();
        var gr = layer.property("Contents").addProperty("ADBE Vector Group").property("Contents").addProperty("ADBE Vector Shape - Rect");
        gr.property("ADBE Vector Rect Size").setValue([gw, gh]);
        gr.property("ADBE Vector Rect Position").setValue([gw / 2, gh / 2]); // origin at the top-left, like the neutral format
        aeCommon(layer, l, 1, true);
        layer.guideLayer = true;
        layer.comment = "LayerBridge group";
        if (parent) layer.parent = parent;
        if (l.blendMode && l.blendMode !== "normal") warnOnce("group blend mode not inherited");
        if (l.effects && l.effects.length) warnOnce("group effects not inherited");
        if (l.clipChildren) warnOnce("group clipping not applied");
        for (i = 0; i < (l.children || []).length; i++) make(l.children[i], layer, op);
        n++;
        return;
      }

      if (l.type === "image") {
        if (!l.imagePath) { warnOnce("image file missing"); return; }
        var f = new File(l.imagePath);
        if (!f.exists) { warnOnce("image file not found"); return; }
        var footage = app.project.importFile(new ImportOptions(f));
        layer = comp.layers.add(footage);
        var it = layer.property("Transform");
        it.property("Anchor Point").setValue([0, 0]); // top-left origin
        it.property("Scale").setValue([(l.width || footage.width) / footage.width * 100, (l.height || footage.height) / footage.height * 100]);
        aeCommon(layer, l, op, false);
        if (parent) layer.parent = parent;
        n++;
        return;
      }

      if (l.type === "text") {
        layer = comp.layers.addText("");
        var tp = layer.property("Source Text"), td = tp.value, tx = l.text || {};
        td.text = tx.content || "";
        td.fontSize = tx.fontSize || 16;
        if (tx.fontFamily) { try { td.font = tx.fontFamily.replace(/\s/g, "") + (tx.fontStyle && tx.fontStyle !== "Regular" ? "-" + tx.fontStyle.replace(/\s/g, "") : ""); } catch (e) { warnOnce("font not found"); } }
        var tf = firstSolid(l.fills);
        td.applyFill = !!tf;
        if (tf) { var c = fromHex(tf.color); td.fillColor = [c[0] / 255, c[1] / 255, c[2] / 255]; }
        if (tx.letterSpacing !== undefined) td.tracking = tx.letterSpacing * 1000 / (tx.fontSize || 16);
        tp.setValue(td);
        aeCommon(layer, l, op, false);
        // text origin is the baseline: drop by roughly one ascender
        var pos = layer.property("Transform").property("Position");
        pos.setValue([pos.value[0], pos.value[1] + (tx.fontSize || 16) * 0.8]);
        if (parent) layer.parent = parent;
        n++;
        return;
      }

      var w = l.width || 1, h = l.height || 1, grp, g;
      layer = comp.layers.addShape();
      grp = layer.property("Contents").addProperty("ADBE Vector Group");
      g = grp.property("Contents");
      if (l.type === "path") {
        for (i = 0; i < l.path.length; i++) g.addProperty("ADBE Vector Shape - Group").property("ADBE Vector Shape").setValue(aeShapeFromSub(l.path[i]));
      } else if (l.type === "ellipse") {
        var el = g.addProperty("ADBE Vector Shape - Ellipse");
        el.property("ADBE Vector Ellipse Size").setValue([w, h]);
        el.property("ADBE Vector Ellipse Position").setValue([w / 2, h / 2]);
      } else {
        var rc = g.addProperty("ADBE Vector Shape - Rect");
        rc.property("ADBE Vector Rect Size").setValue([w, h]);
        rc.property("ADBE Vector Rect Position").setValue([w / 2, h / 2]);
        if (l.cornerRadius) {
          var r = l.cornerRadius instanceof Array ? l.cornerRadius[0] : l.cornerRadius;
          if (l.cornerRadius instanceof Array) warnOnce("per-corner radii use the first value");
          rc.property("ADBE Vector Rect Roundness").setValue(r);
        }
      }
      aeStyle(g, l);
      aeCommon(layer, l, op, false);
      if (parent) layer.parent = parent;
      n++;
    }

    app.beginUndoGroup("LayerBridge");
    try { for (var i = 0; i < layers.length; i++) make(layers[i], null, 1); }
    finally { app.endUndoGroup(); }
    return result(n);
  }

  function aeReadGroup(contents, item) {
    for (var i = 1; i <= contents.numProperties; i++) {
      var p = contents.property(i), mn = p.matchName;
      if (mn === "ADBE Vector Group") aeReadGroup(p.property("Contents"), item);
      else if (mn === "ADBE Vector Shape - Rect") { item.type = "rect"; var rs = p.property("ADBE Vector Rect Size").value; item.width = rs[0]; item.height = rs[1]; var rr = p.property("ADBE Vector Rect Roundness").value; if (rr) item.cornerRadius = rr; }
      else if (mn === "ADBE Vector Shape - Ellipse") { item.type = "ellipse"; var es = p.property("ADBE Vector Ellipse Size").value; item.width = es[0]; item.height = es[1]; }
      else if (mn === "ADBE Vector Shape - Group") {
        var sh = p.property("ADBE Vector Shape").value, nodes = [], k;
        for (k = 0; k < sh.vertices.length; k++) {
          var v = sh.vertices[k], a = sh.inTangents[k], b = sh.outTangents[k], nd = { x: v[0], y: v[1] };
          if (a[0] || a[1]) { nd.inX = v[0] + a[0]; nd.inY = v[1] + a[1]; }
          if (b[0] || b[1]) { nd.outX = v[0] + b[0]; nd.outY = v[1] + b[1]; }
          nodes.push(nd);
        }
        item.type = "path"; item.path = (item.path || []); item.path.push({ closed: sh.closed, nodes: nodes });
      } else if (mn === "ADBE Vector Graphic - Fill") {
        var fc = p.property("ADBE Vector Fill Color").value, fo = p.property("ADBE Vector Fill Opacity").value / 100;
        item.fills = [{ type: "solid", color: toHex(fc[0] * 255, fc[1] * 255, fc[2] * 255) }];
        if (fo !== 1) item.fills[0].opacity = fo;
      } else if (mn === "ADBE Vector Graphic - Stroke") {
        var sc = p.property("ADBE Vector Stroke Color").value;
        item.strokes = [{ paint: { type: "solid", color: toHex(sc[0] * 255, sc[1] * 255, sc[2] * 255) }, width: p.property("ADBE Vector Stroke Width").value }];
      }
    }
  }
  function aeSelection() {
    var comp = app.project.activeItem, out = [], i;
    if (!(comp instanceof CompItem)) return out;
    for (i = 0; i < comp.selectedLayers.length; i++) {
      var L = comp.selectedLayers[i], t = L.property("Transform"), p = t.property("Position").value;
      var item = { name: L.name, x: p[0], y: p[1], width: 0, height: 0 };
      var rot = t.property("Rotation").value; if (rot) item.rotation = rot;
      var op = t.property("Opacity").value; if (op !== 100) item.opacity = op / 100;
      if (!L.enabled) item.visible = false;
      if (L.locked) item.locked = true;
      if (L.blendingMode !== BlendingMode.NORMAL) {
        for (var b = 0; b < BLEND.length; b++) if (aeBlend(BLEND[b]) === L.blendingMode) { item.blendMode = BLEND[b]; break; }
      }
      if (L instanceof TextLayer) {
        var td = L.property("Source Text").value, r = L.sourceRectAtTime(comp.time, false);
        item.type = "text"; item.width = r.width; item.height = r.height; item.y = p[1] - (td.fontSize || 16) * 0.8;
        item.text = { content: String(td.text), fontSize: td.fontSize, fontFamily: td.font };
        if (td.applyFill) item.fills = [{ type: "solid", color: toHex(td.fillColor[0] * 255, td.fillColor[1] * 255, td.fillColor[2] * 255) }];
      } else if (L instanceof ShapeLayer) {
        item.type = "rect";
        aeReadGroup(L.property("Contents"), item);
        if (item.type === "rect" || item.type === "ellipse") { item.x = p[0]; item.y = p[1]; } // rect/ellipse were centred in the layer
      } else { item.type = "rect"; var sr = L.sourceRectAtTime(comp.time, false); item.width = sr.width; item.height = sr.height; warnOnce("non-shape layer exported as a box"); }
      out.push(item);
    }
    return out;
  }

  // =====================================================================
  // Illustrator
  // =====================================================================
  var ab; // active artboard rect: [left, top, right, bottom], y up
  function aiX(x) { return ab[0] + x; }
  function aiY(y) { return ab[1] - y; }
  function aiColor(h) { var c = fromHex(h), col = new RGBColor(); col.red = c[0]; col.green = c[1]; col.blue = c[2]; return col; }
  function aiBlend(name) {
    var m = {
      "normal": BlendModes.NORMAL, "darken": BlendModes.DARKEN, "multiply": BlendModes.MULTIPLY, "color-burn": BlendModes.COLORBURN,
      "lighten": BlendModes.LIGHTEN, "screen": BlendModes.SCREEN, "color-dodge": BlendModes.COLORDODGE, "overlay": BlendModes.OVERLAY,
      "soft-light": BlendModes.SOFTLIGHT, "hard-light": BlendModes.HARDLIGHT, "difference": BlendModes.DIFFERENCE,
      "exclusion": BlendModes.EXCLUSION, "hue": BlendModes.HUE, "saturation": BlendModes.SATURATION, "color": BlendModes.COLORBLEND, "luminosity": BlendModes.LUMINOSITY
    };
    return m[name];
  }
  function aiPaint(doc, p, item) {
    if (p.type === "solid") return aiColor(p.color);
    var g = doc.gradients.add();
    g.type = p.type === "radial" ? GradientType.RADIAL : GradientType.LINEAR;
    while (g.gradientStops.length < p.stops.length) g.gradientStops.add();
    for (var i = 0; i < p.stops.length; i++) {
      var s = g.gradientStops[i];
      s.rampPoint = p.stops[i].pos * 100;
      s.color = aiColor(p.stops[i].color);
      if (p.stops[i].opacity !== undefined) s.opacity = p.stops[i].opacity * 100;
    }
    var gc = new GradientColor();
    gc.gradient = g;
    gc.angle = -(p.angle || 0); // Illustrator angles run counter-clockwise
    return gc;
  }
  function aiStyle(doc, item, l) {
    var fill = l.fills && l.fills.length ? l.fills[l.fills.length - 1] : null;
    if (fill) { item.filled = true; item.fillColor = aiPaint(doc, fill); if (fill.opacity !== undefined && fill.type === "solid") warnOnce("fill opacity ignored"); }
    else item.filled = false;
    if (l.strokes && l.strokes.length) {
      var s = l.strokes[0];
      item.stroked = true;
      item.strokeColor = s.paint.type === "solid" ? aiColor(s.paint.color) : aiColor(firstSolid([s.paint]).color);
      item.strokeWidth = s.width;
      if (s.dashes) item.strokeDashes = s.dashes;
      if (s.align && s.align !== "center") warnOnce("stroke align is center-only in Illustrator");
    } else item.stroked = false;
  }
  function aiPath(parent, sub) {
    var p = parent.pathItems.add(), i;
    for (i = 0; i < sub.nodes.length; i++) {
      var n = sub.nodes[i], pt = p.pathPoints.add();
      pt.anchor = [aiX(n.x), aiY(n.y)];
      pt.leftDirection = n.inX !== undefined ? [aiX(n.inX), aiY(n.inY)] : pt.anchor;
      pt.rightDirection = n.outX !== undefined ? [aiX(n.outX), aiY(n.outY)] : pt.anchor;
      pt.pointType = (n.inX !== undefined || n.outX !== undefined) ? PointType.SMOOTH : PointType.CORNER;
    }
    p.closed = !!sub.closed;
    return p;
  }
  function aiCreate(layers) {
    if (app.documents.length === 0) return "Open a document first";
    var doc = app.activeDocument, n = 0;
    ab = doc.artboards[doc.artboards.getActiveArtboardIndex()].artboardRect;

    // children coordinates are parent-relative; Illustrator groups carry none, so offsets are applied here
    function offsetLayer(l, ox, oy) {
      var c = {}, k;
      for (k in l) c[k] = l[k];
      c.x = (l.x || 0) + ox; c.y = (l.y || 0) + oy;
      return c;
    }
    function make(l0, parent, ox, oy) {
      var l = offsetLayer(l0, ox, oy), item, i;
      if (l.type === "group") {
        item = parent.groupItems.add();
        item.name = l.name || "Group";
        for (i = 0; i < (l.children || []).length; i++) make(l.children[i], item, l.x, l.y);
        if (l.clipChildren) warnOnce("group clipping not applied");
        if (l.rotation) item.rotate(-l.rotation, true, true, true, true, Transformation.TOPLEFT);
        n++;
        finish(item, l);
        return;
      }
      if (l.type === "image") {
        if (!l.imagePath) { warnOnce("image file missing"); return; }
        var imgFile = new File(l.imagePath);
        if (!imgFile.exists) { warnOnce("image file not found"); return; }
        item = parent.placedItems.add();
        item.file = imgFile;
        item.position = [aiX(l.x), aiY(l.y)];
        if (l.width) item.width = l.width;
        if (l.height) item.height = l.height;
        try { item.embed(); } catch (e) { warnOnce("image left linked to a temp file"); }
        n++;
        finish(item, l);
        return;
      }
      if (l.type === "text") {
        var t = l.text || {};
        item = parent.textFrames.add();
        item.contents = t.content || "";
        item.position = [aiX(l.x), aiY(l.y)];
        item.textRange.characterAttributes.size = t.fontSize || 16;
        if (t.fontFamily) { try { item.textRange.characterAttributes.textFont = app.textFonts.getByName(t.fontFamily.replace(/\s/g, "") + (t.fontStyle && t.fontStyle !== "Regular" ? "-" + t.fontStyle.replace(/\s/g, "") : "")); } catch (e) { warnOnce("font not found"); } }
        var tf = firstSolid(l.fills);
        if (tf) item.textRange.characterAttributes.fillColor = aiColor(tf.color);
      } else if (l.type === "path") {
        if (l.path.length === 1) item = aiPath(parent, offsetPath(l.path[0], l));
        else {
          item = parent.compoundPathItems.add();
          for (i = 0; i < l.path.length; i++) aiPath(item, offsetPath(l.path[i], l));
        }
        aiStyle(doc, item, l);
      } else if (l.type === "ellipse") {
        item = parent.pathItems.ellipse(aiY(l.y), aiX(l.x), l.width || 1, l.height || 1);
        aiStyle(doc, item, l);
      } else {
        var w = l.width || 1, h = l.height || 1, cr = l.cornerRadius instanceof Array ? l.cornerRadius[0] : l.cornerRadius;
        if (l.cornerRadius instanceof Array) warnOnce("per-corner radii use the first value");
        item = cr ? parent.pathItems.roundedRectangle(aiY(l.y), aiX(l.x), w, h, cr, cr) : parent.pathItems.rectangle(aiY(l.y), aiX(l.x), w, h);
        aiStyle(doc, item, l);
      }
      if (l.rotation) item.rotate(-l.rotation, true, true, true, true, Transformation.TOPLEFT);
      n++;
      finish(item, l);
    }
    function offsetPath(sub, l) {
      var nodes = [], i, s;
      for (i = 0; i < sub.nodes.length; i++) {
        s = sub.nodes[i];
        nodes.push({ x: s.x + l.x, y: s.y + l.y, inX: s.inX === undefined ? undefined : s.inX + l.x, inY: s.inY === undefined ? undefined : s.inY + l.y, outX: s.outX === undefined ? undefined : s.outX + l.x, outY: s.outY === undefined ? undefined : s.outY + l.y });
      }
      return { closed: sub.closed, nodes: nodes };
    }
    function finish(item, l) {
      item.name = l.name || l.type;
      if (l.opacity !== undefined) item.opacity = l.opacity * 100;
      if (l.blendMode && l.blendMode !== "normal") item.blendingMode = aiBlend(l.blendMode);
      if (l.effects && l.effects.length) warnOnce("effects not supported in Illustrator yet");
      if (l.visible === false) item.hidden = true;
      if (l.locked) item.locked = true;
    }
    for (var i = 0; i < layers.length; i++) make(layers[i], doc.activeLayer, 0, 0);
    return result(n);
  }

  function aiReadColor(c) {
    if (c.typename === "RGBColor") return toHex(c.red, c.green, c.blue);
    if (c.typename === "GrayColor") { var g = 255 * (1 - c.gray / 100); return toHex(g, g, g); }
    return null; // CMYK, spot and pattern colours are not converted
  }
  function aiPaintOut(c) {
    if (c.typename === "GradientColor") {
      var g = c.gradient, stops = [], i;
      for (i = 0; i < g.gradientStops.length; i++) {
        var st = g.gradientStops[i], col = aiReadColor(st.color) || "#000000";
        stops.push({ pos: st.rampPoint / 100, color: col });
      }
      return { type: g.type === GradientType.RADIAL ? "radial" : "linear", angle: -c.angle, stops: stops };
    }
    var hx = aiReadColor(c);
    return hx ? { type: "solid", color: hx } : null;
  }
  function aiReadItem(s) {
    var b = s.geometricBounds; // [left, top, right, bottom], y up
    var item = { name: s.name || s.typename, x: b[0] - ab[0], y: ab[1] - b[1], width: b[2] - b[0], height: b[1] - b[3] }, i, p;
    if (s.opacity !== undefined && s.opacity !== 100) item.opacity = s.opacity / 100;
    if (s.hidden) item.visible = false;
    if (s.locked) item.locked = true;
    if (s.blendingMode !== undefined && s.blendingMode !== BlendModes.NORMAL) {
      for (i = 0; i < BLEND.length; i++) if (aiBlend(BLEND[i]) === s.blendingMode) { item.blendMode = BLEND[i]; break; }
    }
    var tn = s.typename;
    if (tn === "GroupItem") {
      item.type = "group"; item.children = [];
      for (i = 0; i < s.pageItems.length; i++) {
        var ch = aiReadItem(s.pageItems[i]);
        ch.x -= item.x; ch.y -= item.y; // children are parent-relative
        item.children.push(ch);
      }
      if (s.clipped) item.clipChildren = true;
      return item;
    }
    if (tn === "TextFrame") {
      item.type = "text";
      var ca = s.textRange.characterAttributes;
      item.text = { content: s.contents, fontSize: ca.size };
      try { item.text.fontFamily = ca.textFont.family; item.text.fontStyle = ca.textFont.style; } catch (e) {}
      p = ca.fillColor ? aiPaintOut(ca.fillColor) : null;
      if (p) item.fills = [p];
      return item;
    }
    if (tn === "PathItem" || tn === "CompoundPathItem") {
      var paths = tn === "PathItem" ? [s] : s.pathItems, subs = [], k;
      for (k = 0; k < paths.length; k++) {
        var nodes = [], pts = paths[k].pathPoints, j;
        for (j = 0; j < pts.length; j++) {
          var pt = pts[j], a = pt.anchor, nd = { x: a[0] - ab[0] - item.x, y: ab[1] - a[1] - item.y };
          if (pt.leftDirection[0] !== a[0] || pt.leftDirection[1] !== a[1]) { nd.inX = pt.leftDirection[0] - ab[0] - item.x; nd.inY = ab[1] - pt.leftDirection[1] - item.y; }
          if (pt.rightDirection[0] !== a[0] || pt.rightDirection[1] !== a[1]) { nd.outX = pt.rightDirection[0] - ab[0] - item.x; nd.outY = ab[1] - pt.rightDirection[1] - item.y; }
          nodes.push(nd);
        }
        subs.push({ closed: paths[k].closed, nodes: nodes });
      }
      item.type = "path"; item.path = subs;
      var first = tn === "PathItem" ? s : s.pathItems[0];
      if (first.filled) { p = aiPaintOut(first.fillColor); if (p) item.fills = [p]; }
      if (first.stroked) { p = aiPaintOut(first.strokeColor); if (p) item.strokes = [{ paint: p, width: first.strokeWidth }]; }
      return item;
    }
    item.type = "rect"; warnOnce(tn + " exported as a box");
    return item;
  }
  function aiSelection() {
    var out = [], sel = app.activeDocument.selection, doc = app.activeDocument;
    ab = doc.artboards[doc.artboards.getActiveArtboardIndex()].artboardRect;
    for (var i = 0; i < sel.length; i++) out.push(aiReadItem(sel[i]));
    return out;
  }

  return {
    create: function (json) {
      warnings = [];
      try { var layers = parse(json); return isAE ? aeCreate(layers) : aiCreate(layers); }
      catch (e) { return "Error: " + e.message + (e.line ? " (line " + e.line + ")" : ""); }
    },
    // cheap, read-only: what is selected right now (polled by the panel every second)
    summary: function () {
      try {
        var k = { shapes: 0, text: 0, groups: 0, images: 0, other: 0 }, count = 0, where = "", i;
        if (isAE) {
          var comp = app.project.activeItem;
          if (!(comp instanceof CompItem)) return jsonify({ count: 0, hint: "Open a composition to send layers" });
          where = comp.name;
          for (i = 0; i < comp.selectedLayers.length; i++) {
            var L = comp.selectedLayers[i];
            if (L instanceof ShapeLayer) k.shapes++;
            else if (L instanceof TextLayer) k.text++;
            else if (L.source && L.source instanceof CompItem) k.groups++;
            else if (L.source) k.images++;
            else k.other++;
            count++;
          }
        } else {
          if (app.documents.length === 0) return jsonify({ count: 0, hint: "Open a document to send layers" });
          var sel = app.activeDocument.selection;
          where = app.activeDocument.name;
          for (i = 0; i < sel.length; i++) {
            var tn = sel[i].typename;
            if (tn === "PathItem" || tn === "CompoundPathItem") k.shapes++;
            else if (tn === "TextFrame") k.text++;
            else if (tn === "GroupItem") k.groups++;
            else if (tn === "PlacedItem" || tn === "RasterItem") k.images++;
            else k.other++;
            count++;
          }
        }
        return jsonify({ count: count, kinds: k, where: where, hint: "Select layers in " + (isAE ? "After Effects" : "Illustrator") + " to send them" });
      } catch (e) { return jsonify({ count: 0 }); }
    },
    projectDir: function () {
      try { return isAE && app.project.file ? app.project.file.parent.fsName : ""; } catch (e) { return ""; }
    },
    bringToFront: function () {
      try { BridgeTalk.bringToFront(BridgeTalk.appName); return "ok"; } catch (e) { return "Error: " + e.message; }
    },
    selection: function () {
      warnings = [];
      try { return jsonify(isAE ? aeSelection() : aiSelection()); }
      catch (e) { return "[]"; }
    }
  };
})();
