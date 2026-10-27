// Shared panel UI for every LayerBridge plugin (After Effects, Illustrator, Photoshop, Figma).
// The single source lives in plugins/shared; `npm run sync-ui` copies it into each plugin.
//
//   LBPanel.mount({
//     host: "AEFT",                         // this program's host id
//     getSummary: async () => ({ count, kinds: { shapes: 2, text: 1 }, where?, hint? }),
//     getLayers:  async () => Layer[],      // the current selection as neutral layers
//     applyLayers: async (layers, from) => "status text",
//     activate?:  () => void,               // bring this app to the front after a push
//   });
(function (global) {
  var NAMES = { AEFT: "After Effects", ILST: "Illustrator", PHXS: "Photoshop", FIGMA: "Figma", FIGCRAFT: "FigCraft", BLENDER: "Blender" };
  var HINTS = {
    AEFT: "Open Window > Extensions > LayerBridge",
    ILST: "Open Window > Extensions > LayerBridge",
    PHXS: "Open Plugins > LayerBridge",
    FIGMA: "Run Plugins > Development > LayerBridge",
    FIGCRAFT: "Start FigCraft with --control 7979",
    BLENDER: "Sidebar (N) > LayerBridge > Connect"
  };
  var ORDER = ["AEFT", "ILST", "PHXS", "FIGMA", "FIGCRAFT", "BLENDER"];
  var KIND_LABELS = { shapes: ["shape", "shapes"], text: ["text", "text"], groups: ["group", "groups"], images: ["image", "images"], other: ["other", "other"] };

  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; });
  }

  // "3 layers selected (2 shapes, 1 text) in Comp 1"
  function describe(s) {
    if (!s || !s.count) return (s && s.hint) || "Nothing selected";
    var parts = [];
    for (var k in (s.kinds || {})) {
      var n = s.kinds[k];
      if (n) parts.push(n + " " + (KIND_LABELS[k] ? KIND_LABELS[k][n === 1 ? 0 : 1] : k));
    }
    return s.count + (s.count === 1 ? " layer" : " layers") + " selected" + (parts.length ? " (" + parts.join(", ") + ")" : "") + (s.where ? " in " + s.where : "");
  }

  var CSS =
    ":root{color-scheme:light dark;--bg:#fff;--fg:#1e1e1e;--mut:#6b6b6b;--line:#d9d9d9;--card:#f5f5f5;--acc:#0d6efd;--ok:#2da44e;--err:#d1242f}" +
    "@media (prefers-color-scheme:dark){:root{--bg:#2b2b2b;--fg:#e6e6e6;--mut:#a0a0a0;--line:#454545;--card:#353535;--acc:#4d9bff;--ok:#3fb950;--err:#ff6b6b}}" +
    "body{margin:0;background:var(--bg);color:var(--fg);font:12px/1.4 system-ui,-apple-system,Segoe UI,sans-serif}" +
    "#lb-root{padding:10px}.lb-head{display:flex;align-items:center;gap:6px;font-weight:600;font-size:13px}" +
    ".lb-dot{width:8px;height:8px;border-radius:50%;background:var(--mut);display:inline-block}.lb-dot.on{background:var(--ok)}" +
    ".lb-sel{margin:8px 0;padding:8px;border-radius:6px;background:var(--card);border:1px solid var(--line)}.lb-sel.empty{color:var(--mut)}" +
    ".lb-h{margin:10px 0 4px;color:var(--mut);font-size:11px;text-transform:uppercase;letter-spacing:.04em}" +
    ".lb-row{display:flex;align-items:center;gap:6px;padding:6px 8px;margin:3px 0;border:1px solid var(--line);border-radius:6px}" +
    ".lb-row .n{flex:1;min-width:0}.lb-row small{display:block;color:var(--mut);font-size:10.5px}.lb-row.off{opacity:.55}" +
    ".lb-row button{font:inherit;padding:4px 9px;border-radius:5px;border:1px solid var(--line);background:var(--bg);color:var(--fg);cursor:pointer}" +
    ".lb-row button.push{background:var(--acc);border-color:var(--acc);color:#fff}" +
    ".lb-row button:disabled{opacity:.4;cursor:default}" +
    ".lb-opt{display:block;margin:10px 0 4px}.lb-status{margin-top:8px;padding:6px 8px;border-radius:6px;background:var(--card);white-space:pre-wrap;color:var(--mut)}" +
    ".lb-status.err{color:var(--err)}";

  function mount(a) {
    var root = document.getElementById("lb-root");
    var style = document.createElement("style");
    style.textContent = CSS;
    document.head.appendChild(style);

    var state = { hosts: [], summary: { count: 0 }, status: "Connecting to the LayerBridge hub…", err: false, myId: null, online: false, activate: false };
    try { state.activate = localStorage.getItem("lb.activate") === "1"; } catch (e) {}
    var ws = null;
    var selfName = NAMES[a.host] || a.host;

    function nameOf(h) {
      var same = state.hosts.filter(function (x) { return x.host === h.host; }).length > 1;
      return NAMES[h.host] + (same ? " (" + h.id.split("-")[1] + ")" : "");
    }
    function setStatus(text, err) { state.status = text; state.err = !!err; render(); }

    function render() {
      var sel = state.summary || { count: 0 };
      var h = '<div class="lb-head"><span class="lb-dot ' + (state.online ? "on" : "") + '"></span>' + esc(selfName) +
        '<span style="font-weight:400;color:var(--mut)">' + (state.online ? "connected" : "offline") + "</span></div>";
      h += '<div class="lb-sel ' + (sel.count ? "" : "empty") + '">' + esc(describe(sel)) + "</div>";
      h += '<div class="lb-h">Send to</div>';
      ORDER.forEach(function (host) {
        if (host === a.host) return;
        var live = state.hosts.filter(function (x) { return x.host === host; });
        if (!live.length) {
          h += '<div class="lb-row off"><div class="n">' + esc(NAMES[host]) + "<small>not connected. " + esc(HINTS[host]) + "</small></div></div>";
          return;
        }
        live.forEach(function (t) {
          var can = state.online && sel.count > 0;
          h += '<div class="lb-row"><div class="n">' + esc(nameOf(t)) + "<small>connected</small></div>" +
            '<button class="push" data-act="push" data-id="' + esc(t.id) + '"' + (can ? "" : " disabled") + ' title="' + (sel.count ? "Send the selection" : "Select layers first") + '">Push</button>' +
            '<button data-act="pull" data-id="' + esc(t.id) + '"' + (state.online ? "" : " disabled") + ' title="Bring its selection here">Pull</button></div>';
        });
      });
      h += '<label class="lb-opt"><input type="checkbox" id="lb-act"' + (state.activate ? " checked" : "") + "> Switch to the target app after pushing</label>";
      h += '<div class="lb-status ' + (state.err ? "err" : "") + '">' + esc(state.status) + "</div>";
      root.innerHTML = h;
    }

    function send(o) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); }

    async function push(id) {
      try {
        var layers = await a.getLayers();
        if (!layers || !layers.length) return setStatus("Nothing selected. Select layers first.", true);
        var t = state.hosts.filter(function (x) { return x.id === id; })[0];
        setStatus("Sending " + layers.length + " layer" + (layers.length === 1 ? "" : "s") + " to " + (t ? nameOf(t) : id) + "…");
        send({ type: "push", to: id, layers: layers, ref: "ui" + Date.now(), activate: state.activate });
      } catch (e) { setStatus("Could not read the selection: " + e.message, true); }
    }

    function connect() {
      ws = new WebSocket("ws://127.0.0.1:61804");
      ws.onopen = function () { ws.send(JSON.stringify({ type: "hello", host: a.host })); };
      ws.onclose = function () { state.online = false; state.hosts = []; setStatus("Hub offline. Start LayerBridge, retrying…", true); setTimeout(connect, 2000); };
      ws.onmessage = async function (e) {
        var m = JSON.parse(e.data);
        if (m.type === "welcome") { state.myId = m.id; state.online = true; setStatus("Ready"); }
        else if (m.type === "hosts") { state.hosts = m.hosts.filter(function (h) { return h.id !== state.myId; }); render(); }
        else if (m.type === "push" || m.type === "pullResult") {
          var src = (m.from || "").split("-")[0];
          try {
            var res = await a.applyLayers(m.layers, m.from);
            setStatus("Received " + m.layers.length + " layer" + (m.layers.length === 1 ? "" : "s") + " from " + (NAMES[src] || m.from) + (res ? "\n" + res : ""));
            if (m.type === "push" && m.activate && a.activate) a.activate();
          } catch (err) { setStatus("Could not apply layers: " + err.message, true); }
        } else if (m.type === "pull") {
          try { send({ type: "pullResult", to: m.from, ref: m.ref, layers: await a.getLayers() }); }
          catch (err) { setStatus("Could not read the selection: " + err.message, true); }
        } else if (m.type === "ack") {
          var w = m.warnings && m.warnings.length ? "\n" + m.warnings.join("\n") : "";
          setStatus("Sent" + (m.created !== undefined ? " (" + m.created + " created)" : "") + w);
        } else if (m.type === "error") setStatus(m.message, true);
      };
    }

    root.addEventListener("click", function (e) {
      var b = e.target; // walk up by hand: Photoshop's UXP DOM has no Element.closest
      while (b && b !== root && !(b.getAttribute && b.getAttribute("data-act"))) b = b.parentNode;
      if (!b || b === root || b.disabled) return;
      var id = b.getAttribute("data-id");
      if (b.getAttribute("data-act") === "push") push(id);
      else { setStatus("Asking for the selection…"); send({ type: "pull", to: id, ref: "ui" + Date.now() }); }
    });
    root.addEventListener("change", function (e) {
      if (e.target.id === "lb-act") {
        state.activate = e.target.checked;
        try { localStorage.setItem("lb.activate", state.activate ? "1" : "0"); } catch (err) {}
      }
    });

    var last = "";
    async function refreshSummary() {
      try {
        var s = await a.getSummary();
        var key = JSON.stringify(s);
        if (key !== last) { last = key; state.summary = s || { count: 0 }; render(); }
      } catch (e) { /* host busy: keep the previous summary */ }
    }
    render();
    connect();
    refreshSummary();
    setInterval(refreshSummary, 1000);
  }

  global.LBPanel = { mount: mount, _describe: describe };
})(typeof window !== "undefined" ? window : this);
