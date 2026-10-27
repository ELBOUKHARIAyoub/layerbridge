bl_info = {
    "name": "LayerBridge",
    "author": "you",
    "version": (0, 1, 0),
    "blender": (3, 6, 0),
    "location": "View3D > Sidebar > LayerBridge",
    "description": "Send/receive 2D layers with the LayerBridge hub",
    "category": "Import-Export",
}

import json
import queue
import socket
import threading

import bpy
from mathutils import Vector

HUB = ("127.0.0.1", 61805)
SCALE = 0.01  # 1 design pixel = 1 cm; the design canvas is mapped onto the XZ plane

_sock = None
_inbox = queue.Queue()   # messages from the hub, drained on Blender's main thread
_hosts = []
_my_id = None


def _send(obj):
    if _sock:
        _sock.sendall((json.dumps(obj) + "\n").encode("utf-8"))


def _reader(sock):
    global _sock, _hosts
    buf = b""
    try:
        while True:
            data = sock.recv(65536)
            if not data:
                break
            buf += data
            while b"\n" in buf:
                line, buf = buf.split(b"\n", 1)
                if line.strip():
                    _inbox.put(json.loads(line))
    except OSError:
        pass
    _sock = None
    _hosts = []


def connect():
    global _sock
    if _sock:
        return
    s = socket.create_connection(HUB, timeout=3)
    s.settimeout(None)
    _sock = s
    threading.Thread(target=_reader, args=(s,), daemon=True).start()
    _send({"type": "hello", "host": "BLENDER"})


def _hex_to_rgba(h):
    # Blender colours are linear; hex from design tools is sRGB
    def lin(c):
        c /= 255.0
        return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4
    return (lin(int(h[1:3], 16)), lin(int(h[3:5], 16)), lin(int(h[5:7], 16)), 1.0)


def _material(name, hexcolor):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    bsdf = next((n for n in mat.node_tree.nodes if n.type == "BSDF_PRINCIPLED"), None)
    if bsdf:
        bsdf.inputs["Base Color"].default_value = _hex_to_rgba(hexcolor)
    return mat


def _build(layer, parent=None, z=0.0):
    w, h = layer.get("width", 1) * SCALE, layer.get("height", 1) * SCALE
    x = layer.get("x", 0) * SCALE
    y = -layer.get("y", 0) * SCALE  # design y points down, Blender Z points up
    kind = layer["type"]
    if kind == "group":
        empty = bpy.data.objects.new(layer.get("name", "Group"), None)
        bpy.context.collection.objects.link(empty)
        empty.parent = parent
        for i, c in enumerate(layer.get("children", [])):
            _build(c, empty, i * 0.001)
        return 1
    if kind == "text":
        curve = bpy.data.curves.new(layer.get("name", "Text"), "FONT")
        curve.body = (layer.get("text") or {}).get("content", "")
        curve.size = (layer.get("text") or {}).get("fontSize", 16) * SCALE
        obj = bpy.data.objects.new(layer.get("name", "Text"), curve)
        obj.rotation_euler = (1.5707963, 0, 0)  # stand upright like the planes
        obj.location = Vector((x, 0, y - curve.size))
    elif kind == "image":
        return 0
    else:
        bpy.ops.mesh.primitive_circle_add(vertices=64, fill_type="NGON") if kind == "ellipse" else bpy.ops.mesh.primitive_plane_add(size=1)
        obj = bpy.context.active_object
        obj.name = layer.get("name", kind)
        obj.scale = (w / (1 if kind == "rect" else 2) , h / (1 if kind == "rect" else 2), 1)
        obj.rotation_euler = (1.5707963, 0, 0)  # stand the plane up on XZ
        obj.location = Vector((x + w / 2, z, y - h / 2))
    obj["lb_type"] = kind  # remembered so a later pull reports the same layer type
    if obj.name not in bpy.context.collection.objects:
        bpy.context.collection.objects.link(obj)
    if layer.get("fill"):
        obj.data.materials.append(_material(obj.name, layer["fill"]))
    obj.parent = parent
    return 1


def _srgb_hex(c):
    def to_srgb(v):
        v = max(0.0, min(1.0, v))
        return 12.92 * v if v <= 0.0031308 else 1.055 * (v ** (1 / 2.4)) - 0.055
    return "#%02X%02X%02X" % tuple(round(to_srgb(x) * 255) for x in c[:3])


def _fill_of(o):
    if not (o.data and hasattr(o.data, "materials")) or not o.data.materials:
        return None
    mat = o.data.materials[0]
    if not mat or not mat.node_tree:
        return None
    bsdf = next((n for n in mat.node_tree.nodes if n.type == "BSDF_PRINCIPLED"), None)
    return _srgb_hex(bsdf.inputs["Base Color"].default_value) if bsdf else None


def _world_bounds(o):
    # local `dimensions` collapse for planes stood on edge, so measure in world space
    pts = [o.matrix_world @ Vector(c) for c in o.bound_box]
    xs, zs = [p.x for p in pts], [p.z for p in pts]
    return min(xs), max(xs), min(zs), max(zs)


def _selection_layers():
    out = []
    for o in bpy.context.selected_objects:
        x0, x1, z0, z1 = _world_bounds(o)
        kind = o.get("lb_type") or ("text" if o.type == "FONT" else "rect")
        layer = {
            "type": kind,
            "name": o.name,
            "x": x0 / SCALE,
            "y": -z1 / SCALE,
            "width": (x1 - x0) / SCALE,
            "height": (z1 - z0) / SCALE,
        }
        fill = _fill_of(o)
        if fill:
            layer["fills"] = [{"type": "solid", "color": fill}]
        if kind == "text" and o.type == "FONT":
            layer["text"] = {"content": o.data.body, "fontSize": o.data.size / SCALE}
        out.append(layer)
    return out


def _redraw():
    # the sidebar only refreshes when asked: do it when the host list changes
    try:
        for win in bpy.context.window_manager.windows:
            for area in win.screen.areas:
                if area.type == "VIEW_3D":
                    area.tag_redraw()
    except Exception:
        pass


def _pump():
    global _my_id, _hosts
    while not _inbox.empty():
        m = _inbox.get()
        t = m.get("type")
        if t == "welcome":
            _my_id = m["id"]
        elif t == "hosts":
            _hosts = [h for h in m["hosts"] if h["id"] != _my_id]
            _redraw()
        elif t in ("push", "pullResult"):
            n = sum(_build(l) for l in m["layers"])
            print(f"LayerBridge: {n} object(s) created")
        elif t == "pull":
            _send({"type": "pullResult", "to": m["from"], "ref": m.get("ref"), "layers": _selection_layers()})
        elif t == "error":
            print("LayerBridge error:", m.get("message"))
    return 0.2  # run again in 0.2 s


class LB_OT_connect(bpy.types.Operator):
    bl_idname = "layerbridge.connect"
    bl_label = "Connect to hub"

    def execute(self, context):
        try:
            connect()
        except OSError as e:
            self.report({"ERROR"}, f"Hub not reachable: {e}")
            return {"CANCELLED"}
        return {"FINISHED"}


NAMES = {
    "AEFT": "After Effects", "ILST": "Illustrator", "PHXS": "Photoshop",
    "FIGMA": "Figma", "FIGCRAFT": "FigCraft", "BLENDER": "Blender",
}
HINTS = {
    "AEFT": "Window > Extensions > LayerBridge", "ILST": "Window > Extensions > LayerBridge",
    "PHXS": "Plugins > LayerBridge", "FIGMA": "Plugins > Development > LayerBridge",
    "FIGCRAFT": "start it with --control 7979",
}


class LB_OT_send(bpy.types.Operator):
    bl_idname = "layerbridge.send"
    bl_label = "Push"
    bl_description = "Send the selected objects to this program"

    target: bpy.props.StringProperty()

    def execute(self, context):
        layers = _selection_layers()
        if not layers:
            self.report({"WARNING"}, "Select objects first")
            return {"CANCELLED"}
        _send({"type": "push", "to": self.target, "layers": layers, "ref": "blender"})
        return {"FINISHED"}


class LB_OT_pull(bpy.types.Operator):
    bl_idname = "layerbridge.pull"
    bl_label = "Pull"
    bl_description = "Bring this program's selection into Blender"

    target: bpy.props.StringProperty()

    def execute(self, context):
        _send({"type": "pull", "to": self.target, "ref": "blender-pull"})
        return {"FINISHED"}


def _describe_selection(context):
    sel = context.selected_objects
    if not sel:
        return "Nothing selected"
    shapes = sum(1 for o in sel if o.type == "MESH")
    text = sum(1 for o in sel if o.type == "FONT")
    groups = sum(1 for o in sel if o.type == "EMPTY")
    other = len(sel) - shapes - text - groups
    kinds = ((shapes, "shape", "shapes"), (text, "text", "text"), (groups, "group", "groups"), (other, "other", "other"))
    parts = [f"{n} {one if n == 1 else many}" for n, one, many in kinds if n]
    return f"{len(sel)} object{'s' if len(sel) != 1 else ''} selected ({', '.join(parts)})"


class LB_PT_panel(bpy.types.Panel):
    bl_label = "LayerBridge"
    bl_space_type = "VIEW_3D"
    bl_region_type = "UI"
    bl_category = "LayerBridge"

    def draw(self, context):
        col = self.layout.column()
        head = col.row()
        head.label(text="Blender: " + ("connected" if _sock else "offline"), icon="LINKED" if _sock else "UNLINKED")
        if not _sock:
            col.operator("layerbridge.connect", text="Connect to hub")
            return
        box = col.box()
        box.label(text=_describe_selection(context))
        col.separator()
        col.label(text="Send to")
        has_sel = bool(context.selected_objects)
        for host in ("AEFT", "ILST", "PHXS", "FIGMA", "FIGCRAFT"):
            live = [h for h in _hosts if h["host"] == host]
            if not live:
                row = col.row()
                row.enabled = False
                row.label(text=f"{NAMES[host]}  (not connected: {HINTS[host]})")
                continue
            for h in live:
                row = col.row(align=True)
                row.label(text=NAMES[host] + (f" ({h['id'].split('-')[1]})" if len(live) > 1 else ""))
                push = row.row(align=True)
                push.enabled = has_sel
                push.operator("layerbridge.send", text="Push").target = h["id"]
                row.operator("layerbridge.pull", text="Pull").target = h["id"]


_classes = (LB_OT_connect, LB_OT_send, LB_OT_pull, LB_PT_panel)


def register():
    for c in _classes:
        bpy.utils.register_class(c)
    bpy.app.timers.register(_pump, persistent=True)


def unregister():
    if bpy.app.timers.is_registered(_pump):
        bpy.app.timers.unregister(_pump)
    for c in reversed(_classes):
        bpy.utils.unregister_class(c)
