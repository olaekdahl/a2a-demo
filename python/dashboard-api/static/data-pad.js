/* =====================================================================
   Echo Command Interface — DECODED DATA PAD (Message Inspector)
   window.Echo.dataPad  (per UI BUILD CONTRACT §4)

   In-universe "decoded data pad": opens #data-pad (.open), fills the
   header readouts, builds the tab bar, and renders each tab into
   #dp-body. JSON is shown in a line-numbered, collapsible viewer.
   Vanilla JS only. Uses Echo.util inside methods only.
   ===================================================================== */
(function () {
  "use strict";
  window.Echo = window.Echo || {};

  var TABS = ["summary", "headers", "message", "task", "artifacts", "raw"];
  var TAB_LABEL = {
    summary: "SUMMARY",
    headers: "HEADERS",
    message: "MESSAGE",
    task: "TASK",
    artifacts: "ARTIFACTS",
    raw: "RAW JSON"
  };

  // Module-scoped render state (rebuilt on each render()).
  var current = {
    transmission: null,
    data: null,      // inspectorData { request, response, headers, parts, artifacts }
    tab: "summary"
  };

  /* ----- small local helpers (delegate to Echo.util when possible) ----- */

  function U() { return (window.Echo && window.Echo.util) || {}; }

  function $id(id) {
    var u = U();
    if (typeof u.$ === "function") return u.$(id);
    return document.getElementById(id);
  }

  function make(tag, cls, html) {
    var u = U();
    if (typeof u.el === "function") return u.el(tag, cls, html);
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (html != null) n.innerHTML = html;
    return n;
  }

  function esc(s) {
    var u = U();
    if (typeof u.esc === "function") return u.esc(s);
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function fmtTime(iso) {
    var u = U();
    if (typeof u.fmtTime === "function") return u.fmtTime(iso);
    return iso == null ? "—" : String(iso);
  }

  function safeParse(v) {
    var u = U();
    if (typeof u.safeParse === "function") return u.safeParse(v);
    if (v == null) return null;
    if (typeof v === "object") return v;
    try { return JSON.parse(v); } catch (e) { return v; }
  }

  function reducedMotion() {
    var u = U();
    if (typeof u.prefersReducedMotion === "function") return u.prefersReducedMotion();
    try {
      return window.matchMedia &&
        window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    } catch (e) { return false; }
  }

  /* ----- value/path helpers -------------------------------------------- */

  function isObj(v) { return v && typeof v === "object"; }

  // Tolerant getter across object OR *_json string variants.
  function pick(obj) {
    obj = safeParse(obj);
    if (!isObj(obj)) return undefined;
    for (var i = 1; i < arguments.length; i++) {
      var k = arguments[i];
      if (obj == null) return undefined;
      obj = obj[k];
    }
    return obj;
  }

  function firstDefined() {
    for (var i = 0; i < arguments.length; i++) {
      if (arguments[i] !== undefined && arguments[i] !== null) return arguments[i];
    }
    return undefined;
  }

  // Normalise inspectorData (fields may be objects, *_json strings, or null).
  function normalize(data) {
    data = data || {};
    var request = safeParse(firstDefined(data.request, data.request_json));
    var response = safeParse(firstDefined(data.response, data.response_json));
    var headers = safeParse(firstDefined(data.headers, data.headers_json));
    var parts = Array.isArray(data.parts) ? data.parts : extractParts(request, response);
    var artifacts = Array.isArray(data.artifacts) ? data.artifacts : extractArtifacts(response);
    return {
      request: request != null ? request : null,
      response: response != null ? response : null,
      headers: isObj(headers) ? headers : (headers != null ? headers : null),
      parts: parts || [],
      artifacts: artifacts || [],
      message: extractMessage(request),
      task: extractTask(response)
    };
  }

  function extractMessage(req) {
    req = safeParse(req);
    if (!isObj(req)) return null;
    if (isObj(req.message)) return req.message;
    if (Array.isArray(req.parts)) return req;
    // JSON-RPC style: { params: { message: {...} } }
    var pm = pick(req, "params", "message");
    if (isObj(pm)) return pm;
    return req;
  }

  function extractTask(resp) {
    resp = safeParse(resp);
    if (!isObj(resp)) return null;
    if (isObj(resp.task)) return resp.task;
    if (isObj(resp.result) && (resp.result.artifacts || resp.result.status || resp.result.id)) {
      return resp.result;
    }
    if (resp.artifacts || resp.status || resp.history) return resp;
    return resp;
  }

  function extractParts(req, resp) {
    var parts = [];
    var collect = function (obj) {
      obj = safeParse(obj);
      if (!isObj(obj)) return;
      var msg = isObj(obj.message) ? obj.message : obj;
      var pm = pick(obj, "params", "message");
      if (isObj(pm) && Array.isArray(pm.parts)) parts.push.apply(parts, pm.parts);
      else if (msg && Array.isArray(msg.parts)) parts.push.apply(parts, msg.parts);
      var task = extractTask(obj);
      if (task && Array.isArray(task.history)) {
        task.history.forEach(function (h) {
          if (h && Array.isArray(h.parts)) parts.push.apply(parts, h.parts);
        });
      }
    };
    collect(req);
    collect(resp);
    return parts;
  }

  function extractArtifacts(resp) {
    var task = extractTask(resp);
    if (task && Array.isArray(task.artifacts)) return task.artifacts;
    resp = safeParse(resp);
    if (isObj(resp) && Array.isArray(resp.artifacts)) return resp.artifacts;
    if (isObj(resp) && resp.artifact) return [resp.artifact];
    return [];
  }

  // Pull the data payload object out of an artifact (parts[].data).
  function artifactData(art) {
    if (!isObj(art)) return null;
    if (Array.isArray(art.parts)) {
      for (var i = 0; i < art.parts.length; i++) {
        var p = art.parts[i];
        if (p && p.data !== undefined) return p.data;
        if (p && p.kind === "data" && p.data !== undefined) return p.data;
      }
    }
    if (art.data !== undefined) return art.data;
    return art;
  }

  function artifactName(art) {
    if (!isObj(art)) return "artifact";
    return art.name || art.artifactId || art.artifact_id || art.id || "artifact";
  }

  function partText(p) {
    if (!isObj(p)) return String(p == null ? "" : p);
    if (typeof p.text === "string") return p.text;
    if (p.kind === "text" && typeof p.text === "string") return p.text;
    return null;
  }

  /* ----- JSON line-numbered, collapsible viewer ------------------------ */

  // Build a .json-viewer with rows .json-line > .json-num + .json-code.
  // Object/array openers carry a .json-collapsible toggle; toggling adds
  // .collapsed which hides the inner rows + shows an ellipsis.
  function buildJsonViewer(value) {
    var viewer = make("div", "json-viewer");
    viewer.setAttribute("role", "group");
    viewer.setAttribute("aria-label", "JSON readout");
    var lineNo = { n: 0 };

    if (value === undefined) value = null;

    // Each emitted "line" is an object: { indent, html, group?, end? }
    var lines = [];
    serialize(value, 0, null, false, lines);

    // Assign collapse groups: an opener line gets a group id; its matching
    // closer and all rows in between belong to that group (for toggling).
    var stack = [];
    var groupId = 0;
    lines.forEach(function (ln) {
      if (ln.open) {
        groupId++;
        ln.groupId = groupId;
        stack.push(groupId);
        ln.members = [];
      } else if (ln.close) {
        ln.closeOf = stack.pop();
      }
      // mark membership for all currently-open groups (except the opener's own line)
      ln.groups = stack.slice();
    });

    lines.forEach(function (ln) {
      var row = make("div", "json-line");
      lineNo.n++;
      var num = make("span", "json-num");
      num.textContent = String(lineNo.n);
      num.setAttribute("aria-hidden", "true");
      var code = make("span", "json-code");
      code.style.paddingLeft = (ln.indent * 14) + "px";
      code.innerHTML = ln.html;
      if (ln.open) {
        code.classList.add("json-collapsible");
        code.setAttribute("data-group", String(ln.groupId));
        code.setAttribute("tabindex", "0");
        code.setAttribute("role", "button");
        code.setAttribute("aria-expanded", "true");
        code.setAttribute("aria-label", "Collapse section");
      }
      row.dataset.line = String(lineNo.n);
      if (ln.groups && ln.groups.length) {
        row.dataset.inGroups = ln.groups.join(",");
      }
      row.appendChild(num);
      row.appendChild(code);
      viewer.appendChild(row);
    });

    // Collapse / expand handling.
    var toggle = function (codeEl) {
      var gid = codeEl.getAttribute("data-group");
      if (!gid) return;
      var collapsed = codeEl.classList.toggle("collapsed");
      codeEl.setAttribute("aria-expanded", collapsed ? "false" : "true");
      codeEl.setAttribute("aria-label", collapsed ? "Expand section" : "Collapse section");
      var rows = viewer.querySelectorAll(".json-line");
      for (var i = 0; i < rows.length; i++) {
        var inGroups = (rows[i].dataset.inGroups || "").split(",");
        if (inGroups.indexOf(gid) !== -1) {
          rows[i].hidden = collapsed;
        }
      }
    };

    viewer.addEventListener("click", function (e) {
      var t = e.target;
      while (t && t !== viewer && !t.classList.contains("json-collapsible")) t = t.parentNode;
      if (t && t.classList && t.classList.contains("json-collapsible")) toggle(t);
    });
    viewer.addEventListener("keydown", function (e) {
      var t = e.target;
      if (!t || !t.classList || !t.classList.contains("json-collapsible")) return;
      if (e.key === "Enter" || e.key === " " || e.key === "Spacebar") {
        e.preventDefault();
        toggle(t);
      }
    });

    return viewer;
  }

  function jKey(k) { return '<span class="j-key">' + esc('"' + k + '"') + '</span><span class="j-punct">: </span>'; }
  function jStr(v) { return '<span class="j-str">' + esc(JSON.stringify(v)) + '</span>'; }
  function jNum(v) { return '<span class="j-num">' + esc(String(v)) + '</span>'; }
  function jBool(v) { return '<span class="j-bool">' + esc(String(v)) + '</span>'; }
  function jNull() { return '<span class="j-null">null</span>'; }
  function jPunct(s) { return '<span class="j-punct">' + esc(s) + '</span>'; }

  function scalarHtml(v) {
    if (v === null) return jNull();
    var t = typeof v;
    if (t === "string") return jStr(v);
    if (t === "number") return jNum(v);
    if (t === "boolean") return jBool(v);
    return jStr(String(v));
  }

  // Recursive serializer emitting flat line records.
  function serialize(value, indent, key, trailingComma, out) {
    var keyHtml = key != null ? jKey(key) : "";
    var comma = trailingComma ? jPunct(",") : "";

    if (Array.isArray(value)) {
      if (value.length === 0) {
        out.push({ indent: indent, html: keyHtml + jPunct("[]") + comma });
        return;
      }
      out.push({ indent: indent, open: true, html: keyHtml + jPunct("[") + ' <span class="j-ellipsis">…' + value.length + "</span>" });
      for (var i = 0; i < value.length; i++) {
        serialize(value[i], indent + 1, null, i < value.length - 1, out);
      }
      out.push({ indent: indent, close: true, html: jPunct("]") + comma });
      return;
    }

    if (isObj(value)) {
      var keys = Object.keys(value);
      if (keys.length === 0) {
        out.push({ indent: indent, html: keyHtml + jPunct("{}") + comma });
        return;
      }
      out.push({ indent: indent, open: true, html: keyHtml + jPunct("{") + ' <span class="j-ellipsis">…' + keys.length + "</span>" });
      for (var k = 0; k < keys.length; k++) {
        serialize(value[keys[k]], indent + 1, keys[k], k < keys.length - 1, out);
      }
      out.push({ indent: indent, close: true, html: jPunct("}") + comma });
      return;
    }

    out.push({ indent: indent, html: keyHtml + scalarHtml(value) + comma });
  }

  /* ----- structured readout building blocks ---------------------------- */

  function fieldRow(label, value, mod) {
    var row = make("div", "dp-field" + (mod ? " " + mod : ""));
    var l = make("span", "dp-field__label");
    l.textContent = label;
    var v = make("span", "dp-field__val");
    if (value == null || value === "") {
      v.textContent = "—";
      v.classList.add("is-empty");
    } else {
      v.textContent = String(value);
    }
    row.appendChild(l);
    row.appendChild(v);
    return row;
  }

  function sectionTitle(text) {
    var h = make("div", "dp-section");
    h.appendChild(make("span", "dp-section__tick", "▸"));
    var t = make("span", "dp-section__label");
    t.textContent = text;
    h.appendChild(t);
    return h;
  }

  function badge(label, value, mod) {
    var b = make("span", "badge dp-badge" + (mod ? " " + mod : ""));
    var k = make("span", "dp-badge__k");
    k.textContent = label;
    b.appendChild(k);
    var val = make("span", "dp-badge__v");
    val.textContent = (value == null || value === "") ? "(none)" : String(value);
    if (value == null || value === "") b.classList.add("dp-badge--empty");
    b.appendChild(val);
    return b;
  }

  function emptyNote(text) {
    var n = make("div", "dp-empty-note");
    n.textContent = text;
    return n;
  }

  /* ----- per-tab renderers --------------------------------------------- */

  function renderSummary(host, t, d) {
    var sender = (t && t.sender) || "—";
    var recipient = (t && t.recipient) || "—";
    var skill = skillOf(d.message, t);
    var state = stateOf(t, d.task);

    host.appendChild(sectionTitle("DECODED READOUT"));
    var grid = make("div", "dp-readout");
    grid.appendChild(fieldRow("ROUTE", sender + "  →  " + recipient));
    grid.appendChild(fieldRow("EVENT", (t && (t.label || t.message_type)) || "—"));
    grid.appendChild(fieldRow("SKILL", skill || "—"));
    grid.appendChild(fieldRow("STATE", state || "—", stateMod(state)));
    grid.appendChild(fieldRow("TYPE", (t && t.message_type) || "—"));
    grid.appendChild(fieldRow("DIRECTION", (t && t.direction) || "—"));
    grid.appendChild(fieldRow("CONTEXT", (t && t.context_id) || "—"));
    grid.appendChild(fieldRow("TASK", (t && t.task_id) || taskId(d.task) || "—"));
    grid.appendChild(fieldRow("TIME", t && t.created_at ? fmtTime(t.created_at) : "—"));
    host.appendChild(grid);

    if (t && t.summary) {
      host.appendChild(sectionTitle("FIELD NOTE"));
      var note = make("div", "dp-note");
      note.textContent = t.summary;
      host.appendChild(note);
    }

    // Message text parts (human readable) before raw.
    var texts = [];
    (d.parts || []).forEach(function (p) {
      var tx = partText(p);
      if (tx) texts.push(tx);
    });
    if (texts.length) {
      host.appendChild(sectionTitle("TRANSMISSION TEXT"));
      texts.forEach(function (tx) {
        var n = make("div", "dp-note");
        n.textContent = tx;
        host.appendChild(n);
      });
    }

    // Key artifact fields, if present.
    var arts = d.artifacts || [];
    if (arts.length) {
      host.appendChild(sectionTitle("ARTIFACT INTEL"));
      arts.forEach(function (art) {
        host.appendChild(artifactDigest(art));
      });
    }

    if (!texts.length && !arts.length && !(t && t.summary)) {
      host.appendChild(emptyNote("No structured intel decoded for this packet."));
    }
  }

  // Compact human digest of an artifact's payload — known shapes get
  // curated fields; unknown shapes get a short key/value listing.
  function artifactDigest(art) {
    var wrap = make("div", "dp-artifact");
    var name = artifactName(art);
    var head = make("div", "dp-artifact__head");
    head.appendChild(badge("ARTIFACT", name));
    wrap.appendChild(head);

    var data = artifactData(art);
    var grid = make("div", "dp-readout");

    if (isObj(data)) {
      var fields = curatedArtifactFields(name, data);
      if (fields.length) {
        fields.forEach(function (f) {
          grid.appendChild(fieldRow(f[0], f[1], f[2]));
        });
      } else {
        Object.keys(data).slice(0, 8).forEach(function (k) {
          var v = data[k];
          grid.appendChild(fieldRow(k.replace(/_/g, " ").toUpperCase(), scalarSummary(v)));
        });
      }
    } else {
      grid.appendChild(fieldRow("VALUE", data == null ? "—" : String(data)));
    }
    wrap.appendChild(grid);
    return wrap;
  }

  function curatedArtifactFields(name, d) {
    name = String(name || "").toLowerCase();
    var f = [];
    if (name.indexOf("intelligence") !== -1) {
      f.push(["SYSTEM", d.system]);
      f.push(["EMPIRE PRESENCE", d.empire_presence]);
      f.push(["CONFIDENCE", d.confidence]);
      if (isObj(d.detected_units)) {
        f.push(["AT-AT WALKERS", d.detected_units.at_at_walkers]);
        f.push(["STORMTROOPERS", d.detected_units.stormtroopers]);
        f.push(["STAR DESTROYERS", d.detected_units.star_destroyers]);
        f.push(["PROBE DROIDS", d.detected_units.probe_droids]);
      }
    } else if (name.indexOf("tactical") !== -1) {
      f.push(["THREAT LEVEL", d.threat_level, threatMod(d.threat_level)]);
      f.push(["RISK SCORE", d.risk_score]);
      f.push(["RECOMMENDED", d.recommended_action]);
      if (Array.isArray(d.priority_targets)) f.push(["PRIORITY TARGETS", d.priority_targets.join(", ")]);
      f.push(["RATIONALE", d.rationale]);
    } else if (name.indexOf("logistics") !== -1) {
      f.push(["TRANSPORTS", d.available_transports]);
      f.push(["X-WINGS", d.available_x_wings]);
      f.push(["MEDICAL UNITS", d.available_medical_units]);
      f.push(["FUEL %", d.fuel_percentage]);
      f.push(["EVAC CAPACITY", d.evacuation_capacity]);
    } else if (name.indexOf("deployment") !== -1) {
      f.push(["STATUS", d.deployment_status]);
      f.push(["DESTINATION", d.destination]);
      f.push(["ETA (MIN)", d.eta_minutes]);
      if (isObj(d.units_deployed)) {
        Object.keys(d.units_deployed).slice(0, 4).forEach(function (k) {
          f.push([k.replace(/_/g, " ").toUpperCase(), d.units_deployed[k]]);
        });
      }
    }
    // Drop fields whose value is undefined.
    return f.filter(function (row) { return row[1] !== undefined; });
  }

  function scalarSummary(v) {
    if (v == null) return "—";
    if (Array.isArray(v)) return v.length + " item" + (v.length === 1 ? "" : "s");
    if (isObj(v)) return "{ " + Object.keys(v).length + " fields }";
    return String(v);
  }

  function renderHeaders(host, t, d) {
    host.appendChild(sectionTitle("REQUEST HEADERS"));
    var h = isObj(d.headers) ? d.headers : null;
    var get = function (key) {
      if (!h) return null;
      // case-insensitive lookup
      if (h[key] != null) return h[key];
      var lk = key.toLowerCase();
      var found = null;
      Object.keys(h).forEach(function (k) {
        if (k.toLowerCase() === lk) found = h[k];
      });
      return found;
    };

    var badges = make("div", "dp-badges");
    badges.appendChild(badge("A2A-VERSION", get("A2A-Version"), "dp-badge--ver"));
    badges.appendChild(badge("X-CORRELATION-ID", get("X-Correlation-ID")));
    badges.appendChild(badge("X-TRACE-ID", get("X-Trace-ID")));
    badges.appendChild(badge("X-DEMO-TOKEN", get("X-Demo-Token")));
    host.appendChild(badges);

    if (h) {
      host.appendChild(sectionTitle("ALL HEADERS"));
      host.appendChild(buildJsonViewer(h));
    } else {
      host.appendChild(emptyNote(d.headers == null ? "(none)" : String(d.headers)));
    }
  }

  function renderMessage(host, t, d) {
    host.appendChild(sectionTitle("REQUEST MESSAGE"));
    var msg = d.message;
    if (!isObj(msg) && d.request == null) {
      host.appendChild(emptyNote("(none)"));
      return;
    }
    if (isObj(msg)) {
      var meta = make("div", "dp-readout");
      meta.appendChild(fieldRow("ROLE", msg.role));
      meta.appendChild(fieldRow("MESSAGE ID", msg.messageId || msg.message_id));
      meta.appendChild(fieldRow("KIND", msg.kind));
      host.appendChild(meta);
    }

    var parts = (d.parts && d.parts.length) ? d.parts :
      (isObj(msg) && Array.isArray(msg.parts) ? msg.parts : []);
    if (parts.length) {
      host.appendChild(sectionTitle("PARTS (" + parts.length + ")"));
      parts.forEach(function (p, i) {
        var pw = make("div", "dp-part");
        var kind = (p && (p.kind || (p.text != null ? "text" : p.data != null ? "data" : "part"))) || "part";
        pw.appendChild(badge("PART " + (i + 1), kind));
        var tx = partText(p);
        if (tx != null) {
          var n = make("div", "dp-note");
          n.textContent = tx;
          pw.appendChild(n);
        } else {
          pw.appendChild(buildJsonViewer(p && p.data !== undefined ? p.data : p));
        }
        host.appendChild(pw);
      });
    }

    host.appendChild(sectionTitle("RAW REQUEST"));
    host.appendChild(buildJsonViewer(d.request != null ? d.request : (isObj(msg) ? msg : null)));
  }

  function renderTask(host, t, d) {
    host.appendChild(sectionTitle("RESPONSE TASK"));
    var task = d.task;
    if (!isObj(task) && d.response == null) {
      host.appendChild(emptyNote("(none)"));
      return;
    }
    if (isObj(task)) {
      var meta = make("div", "dp-readout");
      meta.appendChild(fieldRow("TASK ID", task.id || task.taskId));
      meta.appendChild(fieldRow("CONTEXT", task.contextId || task.context_id));
      meta.appendChild(fieldRow("STATE", stateOf(t, task), stateMod(stateOf(t, task))));
      if (isObj(task.status)) {
        meta.appendChild(fieldRow("STATUS STATE", task.status.state));
        if (task.status.timestamp) meta.appendChild(fieldRow("STATUS TIME", fmtTime(task.status.timestamp)));
      }
      var arts = Array.isArray(task.artifacts) ? task.artifacts.length : 0;
      meta.appendChild(fieldRow("ARTIFACTS", arts));
      host.appendChild(meta);
    }
    host.appendChild(sectionTitle("RAW TASK"));
    host.appendChild(buildJsonViewer(isObj(task) ? task : (d.response != null ? d.response : null)));
  }

  function renderArtifacts(host, t, d) {
    var arts = d.artifacts || [];
    if (!arts.length) {
      host.appendChild(sectionTitle("ARTIFACTS"));
      host.appendChild(emptyNote("No artifacts attached to this transmission."));
      return;
    }
    host.appendChild(sectionTitle("ARTIFACTS (" + arts.length + ")"));
    arts.forEach(function (art, i) {
      var block = make("div", "dp-artifact-block");
      block.appendChild(artifactDigest(art));
      var data = artifactData(art);
      var sub = make("div", "dp-section dp-section--sub");
      sub.appendChild(make("span", "dp-section__tick", "◣"));
      var lbl = make("span", "dp-section__label");
      lbl.textContent = "DATA";
      sub.appendChild(lbl);
      block.appendChild(sub);
      block.appendChild(buildJsonViewer(data));
      host.appendChild(block);
    });
  }

  function renderRaw(host, t, d) {
    host.appendChild(sectionTitle("RAW TRANSMISSION RECORD"));
    var full = {
      transmission: t || null,
      request: d.request,
      response: d.response,
      headers: d.headers
    };
    host.appendChild(buildJsonViewer(full));
  }

  /* ----- field derivation helpers -------------------------------------- */

  function skillOf(msg, t) {
    if (isObj(msg)) {
      if (msg.skill_id) return msg.skill_id;
      if (msg.skillId) return msg.skillId;
      if (isObj(msg.metadata) && (msg.metadata.skill_id || msg.metadata.skillId)) {
        return msg.metadata.skill_id || msg.metadata.skillId;
      }
    }
    return (t && t.label) || null;
  }

  function stateOf(t, task) {
    if (t && t.status) return t.status;
    if (isObj(task)) {
      if (isObj(task.status) && task.status.state) return task.status.state;
      if (task.state) return task.state;
    }
    return null;
  }

  function taskId(task) {
    if (isObj(task)) return task.id || task.taskId || null;
    return null;
  }

  function stateMod(state) {
    state = String(state || "").toLowerCase();
    if (!state) return "";
    if (state.indexOf("fail") !== -1 || state.indexOf("dead") !== -1 || state.indexOf("error") !== -1 || state.indexOf("reject") !== -1) return "dp-field--alert";
    if (state.indexOf("work") !== -1 || state.indexOf("submit") !== -1 || state.indexOf("input") !== -1) return "dp-field--warn";
    if (state.indexOf("complet") !== -1 || state.indexOf("ok") !== -1 || state.indexOf("success") !== -1) return "dp-field--ok";
    return "";
  }

  function threatMod(level) {
    level = String(level || "").toLowerCase();
    if (level.indexOf("high") !== -1 || level.indexOf("critical") !== -1) return "dp-field--alert";
    if (level.indexOf("mod") !== -1 || level.indexOf("med") !== -1) return "dp-field--warn";
    if (level.indexOf("low") !== -1) return "dp-field--ok";
    return "";
  }

  /* ----- tab bar + body wiring ----------------------------------------- */

  function buildTabBar() {
    var bar = $id("dp-tabs");
    if (!bar) return;
    bar.innerHTML = "";
    bar.setAttribute("role", "tablist");
    bar.setAttribute("aria-label", "Data pad sections");
    TABS.forEach(function (name) {
      var btn = make("button", "dp-tab");
      btn.type = "button";
      btn.setAttribute("data-tab", name);
      btn.setAttribute("role", "tab");
      btn.id = "dp-tab-" + name;
      btn.setAttribute("aria-controls", "dp-body");
      btn.textContent = TAB_LABEL[name];
      bar.appendChild(btn);
    });

    bar.addEventListener("click", function (e) {
      var b = e.target;
      while (b && b !== bar && !(b.classList && b.classList.contains("dp-tab"))) b = b.parentNode;
      if (b && b.classList && b.classList.contains("dp-tab")) {
        selectTab(b.getAttribute("data-tab"));
      }
    });

    bar.addEventListener("keydown", function (e) {
      var tabs = Array.prototype.slice.call(bar.querySelectorAll(".dp-tab"));
      var idx = tabs.indexOf(document.activeElement);
      if (idx === -1) return;
      var next = -1;
      if (e.key === "ArrowRight" || e.key === "ArrowDown") next = (idx + 1) % tabs.length;
      else if (e.key === "ArrowLeft" || e.key === "ArrowUp") next = (idx - 1 + tabs.length) % tabs.length;
      else if (e.key === "Home") next = 0;
      else if (e.key === "End") next = tabs.length - 1;
      if (next !== -1) {
        e.preventDefault();
        tabs[next].focus();
        selectTab(tabs[next].getAttribute("data-tab"));
      }
    });
  }

  function selectTab(name) {
    if (TABS.indexOf(name) === -1) name = "summary";
    current.tab = name;
    var bar = $id("dp-tabs");
    if (bar) {
      var tabs = bar.querySelectorAll(".dp-tab");
      for (var i = 0; i < tabs.length; i++) {
        var on = tabs[i].getAttribute("data-tab") === name;
        tabs[i].classList.toggle("active", on);
        tabs[i].setAttribute("aria-selected", on ? "true" : "false");
        tabs[i].setAttribute("tabindex", on ? "0" : "-1");
      }
    }
    renderBody(name);
  }

  function renderBody(name) {
    var body = $id("dp-body");
    if (!body) return;
    body.innerHTML = "";
    body.setAttribute("role", "tabpanel");
    body.setAttribute("aria-labelledby", "dp-tab-" + name);

    var t = current.transmission;
    var d = current.data;
    if (!d) {
      body.appendChild(emptyNote("No transmission decoded."));
      return;
    }
    try {
      if (name === "summary") renderSummary(body, t, d);
      else if (name === "headers") renderHeaders(body, t, d);
      else if (name === "message") renderMessage(body, t, d);
      else if (name === "task") renderTask(body, t, d);
      else if (name === "artifacts") renderArtifacts(body, t, d);
      else renderRaw(body, t, d);
    } catch (err) {
      body.innerHTML = "";
      body.appendChild(emptyNote("Decode error: " + (err && err.message ? err.message : String(err))));
    }
  }

  /* ----- copy current tab JSON ----------------------------------------- */

  function currentTabJson() {
    var d = current.data;
    var t = current.transmission;
    if (!d) return "{}";
    var payload;
    switch (current.tab) {
      case "headers": payload = d.headers; break;
      case "message": payload = d.request != null ? d.request : d.message; break;
      case "task": payload = d.response != null ? d.response : d.task; break;
      case "artifacts": payload = d.artifacts; break;
      case "raw":
        payload = { transmission: t || null, request: d.request, response: d.response, headers: d.headers };
        break;
      case "summary":
      default:
        payload = {
          route: { sender: t && t.sender, recipient: t && t.recipient },
          event: t && (t.label || t.message_type),
          state: stateOf(t, d.task),
          context_id: t && t.context_id,
          task_id: (t && t.task_id) || taskId(d.task),
          artifacts: (d.artifacts || []).map(function (a) {
            return { name: artifactName(a), data: artifactData(a) };
          })
        };
        break;
    }
    if (payload === undefined) payload = null;
    try { return JSON.stringify(payload, null, 2); }
    catch (e) { return String(payload); }
  }

  function copyText(text) {
    var done = function (ok) { flashCopy(ok); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { done(true); }, function () { fallbackCopy(text, done); });
    } else {
      fallbackCopy(text, done);
    }
  }

  function fallbackCopy(text, cb) {
    var ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.top = "-1000px";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    var ok = false;
    try { ok = document.execCommand("copy"); } catch (e) { ok = false; }
    document.body.removeChild(ta);
    cb(ok);
  }

  function flashCopy(ok) {
    var btn = $id("dp-copy");
    if (!btn) return;
    var prev = btn.getAttribute("data-prev-label");
    if (prev == null) btn.setAttribute("data-prev-label", btn.textContent || "COPY");
    btn.textContent = ok ? "COPIED ✔" : "COPY FAILED";
    btn.classList.toggle("dp-copy--ok", ok);
    btn.classList.toggle("dp-copy--err", !ok);
    if (flashCopy._t) clearTimeout(flashCopy._t);
    flashCopy._t = setTimeout(function () {
      btn.textContent = btn.getAttribute("data-prev-label") || "COPY";
      btn.classList.remove("dp-copy--ok", "dp-copy--err");
    }, 1400);
  }

  /* ----- header fill --------------------------------------------------- */

  function fillHeader(t, d) {
    var label = $id("dp-label");
    if (label) label.textContent = (t && (t.label || t.message_type)) || "TRANSMISSION";

    var route = $id("dp-route");
    if (route) {
      var s = (t && t.sender) || "?";
      var r = (t && t.recipient) || "?";
      route.textContent = s + "  →  " + r;
    }

    var headers = isObj(d.headers) ? d.headers : null;
    var hget = function (key) {
      if (!headers) return null;
      if (headers[key] != null) return headers[key];
      var lk = key.toLowerCase(), found = null;
      Object.keys(headers).forEach(function (k) { if (k.toLowerCase() === lk) found = headers[k]; });
      return found;
    };

    var corrId = hget("X-Correlation-ID") || (t && t.correlation_id);
    var traceId = hget("X-Trace-ID") || (t && t.trace_id);
    var version = hget("A2A-Version");
    if (version == null) {
      var bodyVer = document.body && document.body.getAttribute("data-a2a-version");
      version = bodyVer || null;
    }
    var taskIdVal = taskId(d.task) || (t && t.task_id);

    setText("dp-corr", corrId);
    setText("dp-trace", traceId);
    setText("dp-version", version);

    // optional extra hooks if present in the DOM
    setTextIf("dp-task", taskIdVal);
    setTextIf("dp-context", t && t.context_id);
  }

  function setText(id, v) {
    var n = $id(id);
    if (!n) return;
    n.textContent = (v == null || v === "") ? "(none)" : String(v);
    n.classList.toggle("is-empty", v == null || v === "");
  }
  function setTextIf(id, v) {
    var n = $id(id);
    if (!n) return;
    setText(id, v);
  }

  /* ----- public API ---------------------------------------------------- */

  var wired = false;

  function wireOnce() {
    if (wired) return;
    wired = true;

    buildTabBar();

    var copyBtn = $id("dp-copy");
    if (copyBtn) {
      if (!copyBtn.getAttribute("aria-label")) copyBtn.setAttribute("aria-label", "Copy current tab JSON to clipboard");
      copyBtn.addEventListener("click", function () { copyText(currentTabJson()); });
    }

    var closeBtn = $id("dp-close");
    if (closeBtn) {
      if (!closeBtn.getAttribute("aria-label")) closeBtn.setAttribute("aria-label", "Close data pad");
      closeBtn.addEventListener("click", function () { api.close(); });
    }
  }

  var api = {
    render: function (transmission, inspectorData) {
      wireOnce();

      var pad = $id("data-pad");
      if (!pad) return;

      current.transmission = transmission || null;
      current.data = normalize(inspectorData);

      var empty = $id("dp-empty");
      if (empty) empty.hidden = true;

      fillHeader(current.transmission, current.data);
      selectTab("summary");

      pad.classList.add("open");
      pad.setAttribute("aria-hidden", "false");
      if (!pad.getAttribute("role")) pad.setAttribute("role", "dialog");
      pad.setAttribute("aria-label", "Decoded data pad — message inspector");

      // Move focus to the active tab for keyboard users (skip if reduced motion
      // is irrelevant here, but always good for a11y).
      var active = $id("dp-tab-summary");
      if (active && typeof active.focus === "function") {
        try { active.focus({ preventScroll: true }); } catch (e) { active.focus(); }
      }

      if (reducedMotion()) pad.classList.add("dp-no-anim");
      else pad.classList.remove("dp-no-anim");
    },

    close: function () {
      var pad = $id("data-pad");
      if (!pad) return;
      pad.classList.remove("open");
      pad.setAttribute("aria-hidden", "true");
      var empty = $id("dp-empty");
      if (empty) empty.hidden = false;
    },

    // Exposed for tests / debugging.
    _buildJsonViewer: buildJsonViewer,
    _normalize: normalize
  };

  window.Echo.dataPad = api;
})();
