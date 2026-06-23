/* =====================================================================
   ECHO COMMAND INTERFACE — app.js  (THE CONDUCTOR, loads LAST)
   Owns: state, all data fetching, the SSE live feed, boot sequence,
   live clock, run-mission, red-alert + mission-complete, keyboard
   wiring, and the rendering of the modules NOT owned by other files:
   command header, Agent Roster, Troop Movement, Threat Assessment,
   Logistics, Dead-Letter, Audit. Derives state.derived and feeds the
   holotable.  Vanilla JS only.  No frameworks, no CDN, offline.
   ===================================================================== */
(function () {
  "use strict";

  window.Echo = window.Echo || {};
  var Echo = window.Echo;

  /* ===================================================================
     0. UTIL  (Echo.util — contract §4)
     =================================================================== */
  function $(id) { return document.getElementById(id); }

  function el(tag, cls, html) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (html != null) node.innerHTML = html;
    return node;
  }

  function esc(value) {
    if (value == null) return "";
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function pad2(n) { return n < 10 ? "0" + n : "" + n; }

  function fmtTime(iso) {
    if (!iso) return "—";
    var d = new Date(iso);
    if (isNaN(d.getTime())) {
      // Already a plain string we cannot parse — show as-is, trimmed.
      return String(iso).slice(0, 19).replace("T", " ");
    }
    return (
      d.getUTCFullYear() + "-" + pad2(d.getUTCMonth() + 1) + "-" + pad2(d.getUTCDate()) +
      " " + pad2(d.getUTCHours()) + ":" + pad2(d.getUTCMinutes()) + ":" + pad2(d.getUTCSeconds())
    );
  }

  function safeParse(v) {
    if (v == null) return null;
    if (typeof v === "object") return v;
    try { return JSON.parse(v); } catch (e) { return v; }
  }

  function getJSON(url, opts) {
    return fetch(url, opts).then(function (res) {
      return res.text().then(function (text) {
        var body;
        try { body = text ? JSON.parse(text) : null; } catch (e) { body = text; }
        if (!res.ok) {
          throw { status: res.status, body: body };
        }
        return body;
      });
    });
  }

  // Default agent → language table (contract §4).
  var LANG_TABLE = {
    "resistance-command-agent": "python",
    "agent-registry": "python",
    "dashboard-api": "python",
    "intelligence-agent": "typescript",
    "communications-relay-agent": "typescript",
    "tactical-agent": "go",
    "logistics-agent": "go",
    "fleet-agent": "go"
  };

  function langOf(name) {
    if (!name) return "python";
    var key = String(name).toLowerCase();
    if (LANG_TABLE[key]) return LANG_TABLE[key];
    // Fall back to live agent record language if known.
    var agents = Echo.state && Echo.state.agents;
    if (agents) {
      for (var i = 0; i < agents.length; i++) {
        if (agents[i] && agents[i].name === name && agents[i].language) {
          var lng = String(agents[i].language).toLowerCase();
          if (lng === "python" || lng === "typescript" || lng === "go") return lng;
        }
      }
    }
    return "python";
  }

  function shortName(name) {
    if (!name) return "—";
    return String(name)
      .replace(/-agent$/, "")
      .replace(/-/g, " ")
      .toUpperCase();
  }

  // Pull parts[0].data out of an /api/artifacts row (mirrors backend §7).
  function artifactPayload(row) {
    if (!row) return null;
    var parsed = row.artifact != null ? row.artifact : safeParse(row.artifact_json);
    if (!parsed || typeof parsed !== "object") return null;
    var parts = parsed.parts;
    if (Array.isArray(parts) && parts.length) {
      var first = parts[0];
      if (first && typeof first === "object" && first.data && typeof first.data === "object") {
        return first.data;
      }
    }
    if (parsed.units_deployed || parsed.deployment_status) return parsed;
    if (parsed.data && typeof parsed.data === "object") return parsed.data;
    return parsed;
  }

  function isStaticSnapshot() {
    return /[?&]static=1\b/.test(location.search);
  }

  function prefersReducedMotion() {
    // Static snapshot mode also reports reduced motion so continuous rAF loops
    // (e.g. the radar sweep) stop, letting a headless renderer settle.
    if (isStaticSnapshot()) return true;
    return !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  }

  Echo.util = {
    $: $, el: el, esc: esc, fmtTime: fmtTime, getJSON: getJSON, safeParse: safeParse,
    langOf: langOf, shortName: shortName, artifactPayload: artifactPayload,
    prefersReducedMotion: prefersReducedMotion
  };

  /* ===================================================================
     1. STATE  (Echo.state — contract §4)
     =================================================================== */
  Echo.state = {
    transmissions: [],
    seen: new Set(),
    statusUpdates: [],
    agents: [],
    mission: null,
    derived: { intel: null, threat: null, logistics: null, troop: null },
    replaying: false,
    resetting: false,
    // ACTIVE-ALERT layer: the imperial sector + header red-alert only show during
    // a live dispatch or a replay (between the tactical hop and reinforcement
    // arrival) — NEVER on initial load. The THREAT ASSESSMENT level itself
    // (HIGH/91) is the analysis result and is always shown as-is, so the header
    // readout and the assessment module never disagree.
    threatActive: false
  };
  var state = Echo.state;
  var alertTimer = null;

  var CONTEXT_ID = "operation-echo-shield";

  var FLEET_PHASES = [
    "submitted", "calculating_hyperspace_route", "loading_transports",
    "jump_to_lightspeed", "arriving_hoth_orbit", "deployed", "completed"
  ];

  // Phase → route waypoint (contract §6).
  function phaseWaypoint(phase) {
    var p = (phase || "").toLowerCase();
    if (p === "submitted" || p === "calculating_hyperspace_route" || p === "loading_transports") return "Rendezvous";
    if (p === "jump_to_lightspeed") return "Hyperspace";
    if (p === "arriving_hoth_orbit") return "Hoth Orbit";
    if (p === "deployed" || p === "completed") return "Echo Base";
    return null;
  }

  /* ===================================================================
     2. SMALL HELPERS (toast, safe module calls)
     =================================================================== */
  var toastTimer = null;
  function toast(msg, kind) {
    var t = $("toast");
    if (!t) {
      t = el("div");
      t.id = "toast";
      document.body.appendChild(t);
    }
    t.textContent = msg;
    t.className = "show" + (kind ? " toast--" + kind : "");
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.className = ""; }, 3200);
  }

  // typeof-guarded module call: never let a missing module crash boot.
  function call(mod, method) {
    var args = Array.prototype.slice.call(arguments, 2);
    try {
      var m = Echo[mod];
      if (m && typeof m[method] === "function") {
        return m[method].apply(m, args);
      }
    } catch (e) {
      if (window.console) console.warn("Echo." + mod + "." + method + " failed:", e);
    }
    return undefined;
  }

  function setText(id, value) {
    var node = $(id);
    if (node) node.textContent = (value == null || value === "") ? "—" : String(value);
  }

  function titleCase(s) {
    if (!s) return "";
    return String(s).replace(/_/g, " ").replace(/\b\w/g, function (c) { return c.toUpperCase(); });
  }

  /* ===================================================================
     3. LIVE CLOCK
     =================================================================== */
  function tickClock() {
    var node = $("ch-clock");
    if (node) node.textContent = fmtTime(new Date().toISOString()) + " UTC";
  }

  /* ===================================================================
     4. COMMAND HEADER (zone 1)
     =================================================================== */
  function renderHeader() {
    var m = state.mission;
    setText("ch-theater", "THEATER: HOTH / ECHO BASE");

    if (m) {
      setText("ch-status", (m.status || "standby").toUpperCase());
      setText("ch-phase", m.phase ? titleCase(m.phase) : "—");
      setText("ch-context", m.context_id || CONTEXT_ID);
    } else {
      setText("ch-status", "STANDBY");
      setText("ch-phase", "—");
      setText("ch-context", CONTEXT_ID);
    }

    // Threat readout mirrors the THREAT ASSESSMENT module exactly (the analysis
    // result) so the two never disagree.
    var band = threatBand();
    var label = { low: "LOW", mod: "MODERATE", high: "HIGH", unknown: "NOMINAL" }[band] || "NOMINAL";
    setText("ch-threat", label);
    var threatNode = $("ch-threat");
    if (threatNode) {
      threatNode.className = "threat--" + band;
      threatNode.setAttribute("data-band", band);
    }

    // A2A protocol version from body attribute.
    var ver = document.body.getAttribute("data-a2a-version") || "1.0";
    setText("ch-protocol", "A2A/" + ver);

    // Mission complete → reveal stamp + final summary.
    var complete = m && String(m.status).toLowerCase() === "completed";
    var stamp = $("mission-stamp");
    if (stamp) {
      if (complete) {
        stamp.classList.add("show");
        stamp.textContent = "REINFORCEMENTS DEPLOYED";
        stamp.hidden = false;
      } else {
        stamp.classList.remove("show");
      }
    }
    // Final summary prominent in header.
    var brand = $("ch-brand") || document.querySelector(".ch-brand");
    var summaryNode = $("ch-summary");
    if (!summaryNode && brand) {
      summaryNode = el("p");
      summaryNode.id = "ch-summary";
      summaryNode.className = "ch-summary";
      brand.appendChild(summaryNode);
    }
    if (summaryNode) {
      if (complete && m.final_summary) {
        summaryNode.textContent = m.final_summary;
        summaryNode.classList.add("show");
      } else {
        summaryNode.textContent = "";
        summaryNode.classList.remove("show");
      }
    }

    // Red-alert styling only during an active alert (dispatch / replay window).
    applyRedAlert(state.threatActive && band === "high");
  }

  function applyRedAlert(on) {
    var header = $("command-header");
    if (!header) return;
    if (on) header.classList.add("red-alert");
    else header.classList.remove("red-alert");
  }

  function setConn(stateName, text) {
    var dot = $("ch-conn-dot");
    if (dot) dot.className = "conn--" + stateName;
    setText("ch-conn", text);
  }

  /* ===================================================================
     5. AGENT ROSTER (#mod-roster)
     =================================================================== */
  function renderRoster() {
    var host = $("roster-list");
    if (!host) return;
    host.innerHTML = "";
    var agents = state.agents || [];
    setText("roster-count", agents.length || 0);

    if (!agents.length) {
      host.appendChild(el("div", "roster-empty mono-faint", "AWAITING REGISTRY UPLINK…"));
      return;
    }

    agents.forEach(function (a) {
      var lang = langOf(a.name) || (a.language || "python").toLowerCase();
      var card = a.card || {};
      var skills = Array.isArray(card.skills) ? card.skills.length : 0;
      var health = (a.health_status || "unknown").toLowerCase();
      var healthCls =
        health === "healthy" || health === "up" || health === "ok" ? "healthy"
        : (health === "down" || health === "unhealthy" || health === "error") ? "down"
        : "unknown";
      var healthLabel = healthCls === "healthy" ? "NOMINAL" : healthCls === "down" ? "OFFLINE" : "UNKNOWN";

      var row = el("div", "roster-row");
      row.setAttribute("role", "listitem");

      var dot = el("span", "health--" + healthCls);
      dot.setAttribute("aria-hidden", "true");
      row.appendChild(dot);

      var main = el("div", "roster-main");
      var nameLine = el("div", "roster-name", esc(shortName(a.name)));
      main.appendChild(nameLine);
      var meta = el("div", "roster-meta",
        '<span class="lang-badge lang--' + lang + '">' + esc(lang.toUpperCase()) + '</span>' +
        '<span class="roster-skills">' + skills + ' SKILL' + (skills === 1 ? "" : "S") + '</span>' +
        '<span class="roster-health health-txt--' + healthCls + '">' + healthLabel + '</span>'
      );
      main.appendChild(meta);
      if (card.description) {
        main.appendChild(el("div", "roster-desc", esc(card.description)));
      }
      row.appendChild(main);

      // Card link → open raw Agent Card JSON in a new tab.
      var link = el("a", "roster-card-link");
      link.href = "/api/agents/" + encodeURIComponent(a.name) + "/card";
      link.target = "_blank";
      link.rel = "noopener";
      link.textContent = "CARD ▸";
      link.setAttribute("aria-label", "Open Agent Card for " + shortName(a.name) + " in a new tab");
      row.appendChild(link);

      host.appendChild(row);
    });
  }

  /* ===================================================================
     6. DERIVE STATE from artifacts + troop-movement (feeds holotable)
     =================================================================== */
  function deriveFromArtifacts(artifacts) {
    var intel = null, threat = null, logistics = null;
    (artifacts || []).forEach(function (row) {
      var payload = artifactPayload(row);
      if (!payload) return;
      switch (row.name) {
        case "intelligence-report": intel = payload; break;
        case "tactical-assessment": threat = payload; break;
        case "logistics-assessment": logistics = payload; break;
        default: break;
      }
    });
    if (intel) state.derived.intel = intel;
    if (threat) state.derived.threat = threat;
    if (logistics) state.derived.logistics = logistics;
  }

  function threatBand() {
    var t = state.derived.threat;
    if (!t) return "unknown";
    var lvl = (t.threat_level || "").toString().toLowerCase();
    if (lvl.indexOf("high") >= 0 || lvl === "critical" || lvl === "severe") return "high";
    if (lvl.indexOf("mod") >= 0 || lvl === "medium" || lvl === "elevated") return "mod";
    if (lvl.indexOf("low") >= 0 || lvl === "minimal") return "low";
    // Fall back to numeric risk_score (0..100 or 0..1).
    var s = t.risk_score;
    if (s != null) {
      var n = Number(s);
      if (n <= 1) n = n * 100;
      if (n >= 66) return "high";
      if (n >= 33) return "mod";
      return "low";
    }
    return "unknown";
  }

  /* ===================================================================
     7. THREAT ASSESSMENT (#mod-threat — risk band / heatmap)
     =================================================================== */
  function renderThreat() {
    var t = state.derived.threat;
    var band = threatBand();
    var gauge = $("threat-gauge");
    if (gauge) {
      gauge.className = "ht-threat-gauge threat--" + band;
      var pct = 0;
      if (t && t.risk_score != null) {
        var n = Number(t.risk_score);
        if (n <= 1) n = n * 100;
        pct = Math.max(0, Math.min(100, n));
      }
      gauge.style.setProperty("--risk", pct + "%");
      gauge.setAttribute("aria-label", "Threat band " +
        ({ low: "low", mod: "moderate", high: "high", unknown: "unknown" }[band]) +
        ", risk score " + Math.round(pct));
    }

    setText("threat-level", t ? (t.threat_level ? String(t.threat_level).toUpperCase() : band.toUpperCase()) : "—");
    setText("threat-score", t && t.risk_score != null ? Math.round((Number(t.risk_score) <= 1 ? Number(t.risk_score) * 100 : Number(t.risk_score))) : "—");

    var reco = $("threat-reco");
    if (reco) {
      reco.textContent = (t && t.recommended_action) ? t.recommended_action : "—";
      reco.classList.toggle("threat-reco--alert", band === "high");
    }
    setText("threat-rationale", t && t.rationale ? t.rationale : "—");

    // Priority targets.
    var targets = $("threat-targets");
    if (targets) {
      targets.innerHTML = "";
      var list = (t && Array.isArray(t.priority_targets)) ? t.priority_targets : [];
      if (!list.length) {
        targets.appendChild(el("li", "mono-faint", "— no priority targets —"));
      } else {
        list.forEach(function (tg) {
          targets.appendChild(el("li", "threat-target", "◣ " + esc(typeof tg === "string" ? tg : JSON.stringify(tg))));
        });
      }
    }

    // Imperial unit counts (from intel report).
    var units = $("threat-units");
    if (units) {
      units.innerHTML = "";
      var det = (state.derived.intel && state.derived.intel.detected_units) || null;
      var keys = ["stormtroopers", "at_at_walkers", "at_st_walkers", "star_destroyers", "probe_droids"];
      if (!det) {
        units.appendChild(el("div", "mono-faint", "— no intel —"));
      } else {
        keys.forEach(function (k) {
          var v = det[k];
          var cell = el("div", "threat-unit");
          cell.appendChild(el("span", "threat-unit__label", esc(k.replace(/_/g, " ").toUpperCase())));
          cell.appendChild(el("span", "threat-unit__val", v == null ? "—" : esc(v)));
          units.appendChild(cell);
        });
      }
    }

    // The holotable threat sector is driven by the gated refreshHolotable()
    // (so it only appears on the narrative reveal), not directly here.
  }

  /* ===================================================================
     8. LOGISTICS (#mod-logistics incl #log-fuel-meter)
     =================================================================== */
  function renderLogistics() {
    var l = state.derived.logistics;
    var fuel = l && l.fuel_percentage != null ? Number(l.fuel_percentage) : null;
    setText("log-fuel", fuel != null ? Math.round(fuel) + "%" : "—");

    var meter = $("log-fuel-meter");
    if (meter) {
      var fill = meter.querySelector(".meter__fill");
      if (!fill) {
        fill = el("div", "meter__fill");
        meter.appendChild(fill);
      }
      var pct = fuel != null ? Math.max(0, Math.min(100, fuel)) : 0;
      fill.style.width = pct + "%";
      var band = fuel == null ? "low" : (fuel >= 60 ? "ok" : fuel >= 30 ? "warn" : "low");
      meter.className = "meter meter--" + band;
      meter.setAttribute("role", "meter");
      meter.setAttribute("aria-valuenow", String(Math.round(pct)));
      meter.setAttribute("aria-valuemin", "0");
      meter.setAttribute("aria-valuemax", "100");
      meter.setAttribute("aria-label", "Fleet fuel " + Math.round(pct) + " percent");
    }

    setText("log-transports", l && l.available_transports != null ? l.available_transports : "—");
    setText("log-evac", l && l.evacuation_capacity != null ? l.evacuation_capacity : "—");

    // Supply / recommended troop movement summary.
    var supply = $("log-supply");
    if (supply) {
      var rec = l && l.recommended_troop_movement;
      if (rec) {
        var bits = [];
        if (rec.reinforce_echo_base != null) bits.push("REINFORCE " + rec.reinforce_echo_base);
        if (rec.evacuate_civilians != null) bits.push("EVAC " + rec.evacuate_civilians);
        if (rec.reserve_defensive_units != null) bits.push("RESERVE " + rec.reserve_defensive_units);
        supply.textContent = bits.length ? bits.join("  ·  ") : "—";
      } else {
        supply.textContent = l && l.available_x_wings != null ? ("X-WINGS " + l.available_x_wings) : "—";
      }
    }
  }

  /* ===================================================================
     9. TROOP MOVEMENT (#mod-troop incl #fleet-track) + holotable route
     =================================================================== */
  var FLEET_PHASE_SHORT = {
    submitted: "SUBMIT", calculating_hyperspace_route: "ROUTE",
    loading_transports: "LOAD", jump_to_lightspeed: "JUMP",
    arriving_hoth_orbit: "ORBIT", deployed: "DEPLOY", completed: "DONE"
  };
  function renderTroopTrack(currentPhase) {
    var host = $("fleet-track");
    if (host) {
      host.innerHTML = "";
      var idx = FLEET_PHASES.indexOf((currentPhase || "").toLowerCase());
      FLEET_PHASES.forEach(function (p, i) {
        var cls = "pip";
        if (idx >= 0 && i < idx) cls += " pip--done";
        else if (idx >= 0 && i === idx) cls += " pip--active";
        // The pip is a thin segment bar (no inline text); CSS shows a short
        // data-label only for the active phase. Full name is the title/tooltip.
        var pip = el("li", cls);
        pip.setAttribute("data-label", FLEET_PHASE_SHORT[p] || p.toUpperCase());
        pip.setAttribute("title", titleCase(p));
        host.appendChild(pip);
      });
    }
    if (currentPhase) setText("fleet-phase-tag", titleCase(currentPhase));
  }

  function renderTroop(data) {
    var movement = data ? data.troopMovement : null;
    var phase = data ? (data.fleetPhase || data.currentPhase) : null;

    var grid = $("troop-grid");
    var empty = $("troop-empty");
    if (!movement) {
      if (empty) empty.hidden = false;
      if (grid) grid.hidden = true;
    } else {
      if (empty) empty.hidden = true;
      if (grid) grid.hidden = false;
      setText("t-troops", movement.ground_troops);
      setText("t-transports", movement.troop_transports);
      setText("t-xwings", movement.x_wing_squadrons);
      setText("t-medical", movement.medical_units);
      setText("t-eta", movement.eta_minutes != null ? movement.eta_minutes + " MIN" : "—");
      setText("t-dest", movement.destination);
      setText("troop-transmission", movement.transmission);
    }

    state.derived.troop = { phase: phase, movement: movement };
    renderTroopTrack(phase);

    // Feed holotable route + phase.
    if (phase) {
      call("holotable", "setPhase", phase);
    }
  }

  /* ===================================================================
     10. DEAD-LETTER QUEUE (#mod-deadletter)
     =================================================================== */
  function renderDeadLetters(rows) {
    var host = $("deadletter-list");
    var tag = $("deadletter-tag");
    rows = rows || [];
    if (tag) {
      if (rows.length) {
        tag.textContent = rows.length + " STUCK";
        tag.classList.add("alert");
      } else {
        tag.textContent = "NOMINAL";
        tag.classList.remove("alert");
      }
    }
    if (!host) return;
    host.innerHTML = "";
    if (!rows.length) {
      host.appendChild(el("div", "deadletter-nominal", "◇ QUEUE CLEAR — NO FAILED HOPS"));
      return;
    }
    rows.forEach(function (r) {
      var row = el("div", "deadletter-row");
      row.appendChild(el("div", "deadletter-route",
        esc(shortName(r.sender)) + " → " + esc(shortName(r.recipient)) +
        '<span class="deadletter-skill">' + esc(r.skill_id || "") + "</span>"));
      row.appendChild(el("div", "deadletter-err",
        '<span class="badge">' + (r.attempts != null ? esc(r.attempts) : "?") + " TRIES</span> " +
        esc(r.last_error || "unknown error")));
      host.appendChild(row);
    });
  }

  /* ===================================================================
     11. AUDIT LOG (#mod-audit)
     =================================================================== */
  function renderAudit(rows) {
    var host = $("audit-list");
    if (!host) return;
    host.innerHTML = "";
    rows = rows || [];
    if (!rows.length) {
      host.appendChild(el("div", "mono-faint", "— no audit entries —"));
      return;
    }
    // Most recent first, capped.
    rows.slice().reverse().slice(0, 60).forEach(function (r) {
      var row = el("div", "audit-row");
      row.appendChild(el("span", "audit-time", esc(fmtTime(r.created_at))));
      row.appendChild(el("span", "audit-action", esc((r.action || "event").toUpperCase())));
      row.appendChild(el("span", "audit-actor", esc(r.actor || "—")));
      host.appendChild(row);
    });
  }

  /* ===================================================================
     12. MESSAGE INSPECTOR — Echo.app.openInspector / selectTransmission
     =================================================================== */
  function buildInspectorData(message, transmission) {
    var m = message || {};
    var request = m.request != null ? m.request : safeParse(m.request_json);
    var response = m.response != null ? m.response : safeParse(m.response_json);
    var headers = m.headers != null ? m.headers : safeParse(m.headers_json);

    var parts = [];
    var collect = function (obj) {
      if (!obj || typeof obj !== "object") return;
      var msg = obj.message || obj;
      if (msg && Array.isArray(msg.parts)) parts.push.apply(parts, msg.parts);
      if (obj.task && Array.isArray(obj.task.history)) {
        obj.task.history.forEach(function (h) {
          if (h && Array.isArray(h.parts)) parts.push.apply(parts, h.parts);
        });
      }
    };
    collect(request);
    collect(response);

    var artifacts = [];
    if (response && typeof response === "object") {
      if (response.task && Array.isArray(response.task.artifacts)) artifacts = response.task.artifacts;
      else if (Array.isArray(response.artifacts)) artifacts = response.artifacts;
      else if (response.artifact) artifacts = [response.artifact];
    }

    var summary = {
      label: transmission.label,
      message_type: transmission.message_type,
      sender: transmission.sender || m.sender,
      recipient: transmission.recipient || m.recipient,
      status: transmission.status,
      summary: transmission.summary,
      direction: transmission.direction || m.direction,
      created_at: transmission.created_at || m.created_at
    };

    return {
      request: request, response: response, headers: headers,
      parts: parts, artifacts: artifacts, summary: summary
    };
  }

  function openInspector(transmission) {
    if (!transmission) return;
    call("spine", "select", transmission.id);

    if (transmission.message_ref) {
      getJSON("/api/messages/" + encodeURIComponent(transmission.message_ref))
        .then(function (res) {
          var data = buildInspectorData((res && res.message) || {}, transmission);
          call("dataPad", "render", transmission, data);
        })
        .catch(function (err) {
          var data = buildInspectorData({
            request_json: JSON.stringify({
              note: "No persisted message for this event.",
              error: (err && err.status) ? "HTTP " + err.status : String(err)
            })
          }, transmission);
          call("dataPad", "render", transmission, data);
        });
    } else {
      // No message ref — synthesize from the transmission row itself.
      var data = buildInspectorData({
        request_json: JSON.stringify({
          label: transmission.label, message_type: transmission.message_type,
          sender: transmission.sender, recipient: transmission.recipient,
          status: transmission.status, summary: transmission.summary,
          created_at: transmission.created_at
        })
      }, transmission);
      call("dataPad", "render", transmission, data);
    }
  }

  Echo.app = {
    openInspector: openInspector,
    selectTransmission: openInspector,
    toast: toast,
    // Used by replay.js to advance the troop track for a given fleet phase.
    setTroopPhase: function (phase) { renderTroopTrack(phase); },
    // Used by replay.js stop() to restore the live view after a replay. The
    // archived mission already concluded, so the live view rests CALM (the
    // active-alert layer stays down; the assessment readout shows the analysis).
    reloadLive: function () {
      state.threatActive = false;
      loadMission(); loadTimeline(); loadTroop();
      loadArtifacts(); loadAudit(); loadDeadLetters();
    },
    // Narrative hooks (used by replay.js): reset to nominal, reveal, resolve.
    resetNarrative: function () { resetNarrative(); },
    escalateThreat: function () { escalateThreat(); },
    containThreat: function () { containThreat(); }
  };

  /* ===================================================================
     13. DATA LOADERS
     =================================================================== */
  function loadMission() {
    return getJSON("/api/mission").then(function (res) {
      state.mission = res ? res.mission : null;
      renderHeader();
    }).catch(function () { renderHeader(); });
  }

  function loadAgents() {
    return getJSON("/api/agents").then(function (res) {
      state.agents = (res && res.agents) || [];
      renderRoster();
      refreshHolotable();
    }).catch(function () { renderRoster(); });
  }

  function loadTimeline() {
    return getJSON("/api/timeline").then(function (res) {
      var list = (res && res.transmissions) || [];
      state.transmissions = list;
      state.seen = new Set();
      list.forEach(function (t) { if (t && t.id != null) state.seen.add(t.id); });
      var count = $("spine-count");
      if (count) count.textContent = String(list.length);
      var emptyEl = $("spine-empty");
      if (emptyEl) emptyEl.hidden = list.length > 0;
      call("spine", "renderAll", list);
    }).catch(function () {});
  }

  function loadArtifacts() {
    return getJSON("/api/artifacts").then(function (res) {
      var arts = (res && res.artifacts) || [];
      state.artifacts = arts;
      deriveFromArtifacts(arts);
      renderThreat();
      renderLogistics();
      renderHeader();
      refreshHolotable();
    }).catch(function () {});
  }

  function loadTroop() {
    return getJSON("/api/troop-movement").then(function (res) {
      renderTroop(res || null);
      refreshHolotable();
    }).catch(function () { renderTroop(null); });
  }

  function loadStatusUpdates() {
    return getJSON("/api/status-updates?contextId=" + encodeURIComponent(CONTEXT_ID))
      .then(function (res) {
        state.statusUpdates = (res && res.statusUpdates) || [];
      }).catch(function () {});
  }

  function loadAudit() {
    return getJSON("/api/audit").then(function (res) {
      renderAudit((res && res.auditLogs) || []);
    }).catch(function () {});
  }

  function loadDeadLetters() {
    return getJSON("/api/dead-letters").then(function (res) {
      renderDeadLetters((res && res.deadLetters) || []);
    }).catch(function () {});
  }

  function refreshHolotable() {
    var d = state.derived || {};
    // The imperial sector only shows during an active alert (dispatch/replay) —
    // never on initial load, and not after reinforcements have arrived.
    call("holotable", "render", state.agents, {
      intel: d.intel,
      logistics: d.logistics,
      troop: d.troop,
      threat: state.threatActive ? d.threat : null
    });
  }

  /* ===================================================================
     NARRATIVE — "nominal … ⚠ Imperial contact … coordinate … deployed"
     =================================================================== */
  // Clear the active-alert layer back to calm (no imperial sector, no red-alert).
  // The THREAT ASSESSMENT readout/module are untouched — they show the analysis.
  function resetNarrative() {
    if (alertTimer) { clearTimeout(alertTimer); alertTimer = null; }
    state.threatActive = false;
    applyRedAlert(false);
    renderHeader();
    refreshHolotable();
  }

  // ⚠ ACTIVE ALERT — the Empire is detected: imperial sector + red-alert engage.
  // Only fires during a live dispatch or a replay (never on load).
  function escalateThreat() {
    if (state.threatActive) return;
    var band = threatBand();
    if (band !== "high" && band !== "mod") return;   // nothing to raise an alert over
    state.threatActive = true;
    renderHeader();        // header red-alert engages
    refreshHolotable();    // imperial sector fades in
    toast("⚠ IMPERIAL CONTACT DETECTED — HOTH SYSTEM", band === "high");
  }

  // ✓ STAND DOWN — reinforcements arrived, the threat is repelled: alert clears.
  function containThreat() {
    if (alertTimer) { clearTimeout(alertTimer); alertTimer = null; }
    if (!state.threatActive) return;
    state.threatActive = false;
    applyRedAlert(false);
    renderHeader();        // red-alert clears
    refreshHolotable();    // imperial sector fades out
    toast("✓ ECHO BASE REINFORCED — SECTOR HELD");
  }

  function loadAll() {
    return Promise.all([
      loadMission(), loadAgents(), loadTimeline(), loadArtifacts(),
      loadTroop(), loadStatusUpdates(), loadAudit(), loadDeadLetters()
    ]);
  }

  /* ===================================================================
     14. SSE LIVE FEED
     =================================================================== */
  var es = null;

  function beamKindFor(t) {
    var mt = (t.message_type || "").toLowerCase();
    var st = (t.status || "").toLowerCase();
    if (st === "dead-letter" || mt === "dead-letter") return "dead-letter";
    if (mt.indexOf("artifact") >= 0 || st === "artifact") return "artifact";
    if (mt.indexOf("status") >= 0) return "status";
    return "send";
  }

  function onTransmission(t) {
    if (!t || t.id == null) return;
    if (state.seen.has(t.id)) return;
    state.seen.add(t.id);
    state.transmissions.push(t);

    var count = $("spine-count");
    if (count) count.textContent = String(state.transmissions.length);
    var emptyEl = $("spine-empty");
    if (emptyEl) emptyEl.hidden = true;

    call("spine", "add", t, true);
    var kind = beamKindFor(t);
    call("holotable", "beam", t.sender, t.recipient, { kind: kind });

    if (kind === "dead-letter") {
      loadDeadLetters();
    }
    // Live derived refresh — new artifacts / troop data may have landed.
    loadArtifacts();
    loadTroop();
    // Narrative beat: the tactical hop is the moment the threat is assessed —
    // reveal the imperial sector + red alert (after artifacts refresh).
    if (!state.replaying &&
        (t.sender === "tactical-agent" || t.recipient === "tactical-agent")) {
      setTimeout(escalateThreat, 450);
    }
  }

  function onStatusUpdate(u) {
    if (!u) return;
    state.statusUpdates.push(u);
    if ((u.agent_name || "") === "fleet-agent") {
      var phase = u.phase || u.state;
      renderTroopTrack(phase);
      if (phase) setText("fleet-phase-tag", titleCase(phase));
      call("holotable", "setPhase", phase);
      state.derived.troop = state.derived.troop || {};
      state.derived.troop.phase = phase;
      refreshHolotable();
    }
  }

  function onMission(m) {
    state.mission = m || null;
    renderHeader();
    if (m && String(m.status).toLowerCase() === "completed") {
      // Lock holotable route to final state.
      call("holotable", "setPhase", "completed");
      refreshHolotable();
      toast("MISSION COMPLETE — REINFORCEMENTS DEPLOYED", "ok");
      // Live dispatch: the threat is repelled shortly after reinforcements
      // deploy — stand the alert down (only if an alert is currently active).
      if (!state.replaying && state.threatActive) {
        if (alertTimer) clearTimeout(alertTimer);
        alertTimer = setTimeout(containThreat, prefersReducedMotion() ? 0 : 2200);
      }
    }
  }

  function connectSSE() {
    if (es) { try { es.close(); } catch (e) {} }
    // Static snapshot mode (?static=1): load data once but skip the persistent
    // SSE link. Useful for screenshots / headless rendering where an open
    // EventSource would keep the page from ever reaching network-idle.
    if (isStaticSnapshot()) {
      setConn("idle", "STATIC SNAPSHOT");
      return;
    }
    if (typeof EventSource === "undefined") {
      setConn("error", "NO SSE SUPPORT");
      return;
    }
    setConn("idle", "OPENING…");
    es = new EventSource("/api/events/stream");

    es.addEventListener("open", function () {
      setConn("live", "FULCRUM LINK LIVE");
    });

    es.addEventListener("connected", function () {
      setConn("live", "FULCRUM LINK LIVE");
    });

    es.addEventListener("transmission", function (ev) {
      if (state.replaying || state.resetting) return;
      var d = safeParse(ev.data);
      if (d && d.transmission) onTransmission(d.transmission);
    });

    es.addEventListener("status-update", function (ev) {
      if (state.replaying || state.resetting) return;
      var d = safeParse(ev.data);
      if (d && d.statusUpdate) onStatusUpdate(d.statusUpdate);
    });

    es.addEventListener("mission", function (ev) {
      if (state.replaying || state.resetting) return;
      var d = safeParse(ev.data);
      if (d) onMission(d.mission || null);
    });

    es.addEventListener("error", function () {
      setConn("error", "LINK INTERRUPTED — RETRYING");
      // EventSource auto-reconnects; reflect live again on next open.
    });
  }

  /* ===================================================================
     15. RUN MISSION / REPLAY CONTROLS
     =================================================================== */
  // Reset the whole console to a nominal / standby state (no active mission).
  function clearView() {
    resetNarrative();                       // threatActive=false; header/holo calm
    state.transmissions = [];
    state.seen = new Set();
    state.statusUpdates = [];
    state.derived = { intel: null, threat: null, logistics: null, troop: null };
    state.mission = null;
    call("spine", "clear");
    call("holotable", "reset");             // clear any transient beams
    call("holotable", "setPhase", "submitted");
    var sc = $("spine-count"); if (sc) sc.textContent = "0";
    var se = $("spine-empty"); if (se) se.hidden = false;
    renderHeader();                         // STATUS STANDBY, THREAT NOMINAL
    renderThreat();                         // standby (— everywhere)
    renderLogistics();
    renderTroop(null);
    renderTroopTrack(null);
    renderDeadLetters([]);
    renderAudit([]);
    refreshHolotable();                     // scope + agents, no threat / no route progress
    var stamp = $("mission-stamp"); if (stamp) stamp.classList.remove("show");
  }

  function resetMission() {
    var btn = $("btn-reset");
    state.resetting = true;
    if (btn) { btn.disabled = true; btn.setAttribute("aria-busy", "true"); }
    clearView();
    toast("CONSOLE RESET — STANDBY");
    getJSON("/api/reset-mission", { method: "POST", headers: { "Content-Type": "application/json" } })
      .catch(function () { /* view already cleared; backend reset is best-effort */ })
      .then(function () {
        // mission:reset can wait behind a running mission lock; clear once more
        // after it returns so interim SSE rows do not linger in the UI.
        clearView();
      })
      .then(function () {
        state.resetting = false;
        if (btn) { btn.disabled = false; btn.removeAttribute("aria-busy"); }
      });
  }

  function runMission() {
    var btn = $("btn-run");
    if (btn) { btn.disabled = true; btn.setAttribute("aria-busy", "true"); }
    // Wipe to nominal first, then watch the fresh mission fill in live over SSE
    // (scout → ⚠ tactical contact → coordinate → deploy).
    clearView();
    toast("DISPATCHING MISSION — STAND BY", "amber");
    getJSON("/api/run-mission", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command: "start_mission" })
    }).then(function () {
      toast("MISSION DISPATCHED — AWAITING TRANSMISSIONS", "ok");
    }).catch(function (err) {
      toast("DISPATCH FAILED" + (err && err.status ? " (HTTP " + err.status + ")" : ""), "alert");
    }).then(function () {
      if (btn) { btn.disabled = false; btn.removeAttribute("aria-busy"); }
    });
  }

  function wireControls() {
    var run = $("btn-run");
    if (run) run.addEventListener("click", runMission);

    var replay = $("btn-replay");
    if (replay) replay.addEventListener("click", function () {
      var stop = $("btn-replay-stop");
      if (stop) stop.hidden = false;
      call("replay", "start");
    });

    var replayStop = $("btn-replay-stop");
    if (replayStop) replayStop.addEventListener("click", function () {
      replayStop.hidden = true;
      call("replay", "stop");
    });

    var reset = $("btn-reset");
    if (reset) reset.addEventListener("click", function () {
      // Stop replay timers without triggering replay.js live reload; resetMission
      // clears local UI and then calls /api/reset-mission itself.
      call("replay", "stop", { skipReload: true });
      var stop = $("btn-replay-stop"); if (stop) stop.hidden = true;
      resetMission();
    });
  }

  // Reloaders used by Echo.replay.stop() to restore the live timeline.
  Echo.app.reload = {
    timeline: loadTimeline,
    artifacts: loadArtifacts,
    troop: loadTroop,
    mission: loadMission,
    all: loadAll
  };

  /* ===================================================================
     16. BOOT SEQUENCE
     =================================================================== */
  var BOOT_LINES = [
    "INITIALIZING ECHO COMMAND INTERFACE",
    "ACQUIRING A2A REGISTRY…",
    "SYNCING AGENT CARDS…",
    "OPENING FULCRUM CHANNEL…",
    "LOADING OPERATION ECHO SHIELD…",
    "LINK STABLE."
  ];

  var bootDone = false;

  function dismissBoot() {
    if (bootDone) return;
    bootDone = true;
    var overlay = $("boot-overlay");
    if (overlay) {
      overlay.classList.add("is-done");
      window.setTimeout(function () { if (overlay) overlay.hidden = true; }, 600);
    }
  }

  function runBoot() {
    var overlay = $("boot-overlay");
    var log = $("boot-log");
    var skip = $("boot-skip");

    if (skip) {
      skip.addEventListener("click", dismissBoot);
    }

    if (!overlay || !log) {
      bootDone = true;
      return;
    }

    if (prefersReducedMotion()) {
      // Instant: print all lines, dismiss promptly.
      BOOT_LINES.forEach(function (line) {
        log.appendChild(el("div", "boot-line", esc(line)));
      });
      window.setTimeout(dismissBoot, 400);
      return;
    }

    var i = 0;
    var step = function () {
      if (bootDone) return;
      if (i < BOOT_LINES.length) {
        log.appendChild(el("div", "boot-line", esc(BOOT_LINES[i])));
        i++;
        window.setTimeout(step, 250);
      } else {
        window.setTimeout(dismissBoot, 600);
      }
    };
    step();
    // Safety: never trap the operator behind the boot screen.
    window.setTimeout(dismissBoot, 4000);
  }

  /* ===================================================================
     17. KEYBOARD WIRING (Esc)
     =================================================================== */
  function wireKeyboard() {
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" || e.key === "Esc") {
        if (!bootDone) { dismissBoot(); return; }
        var pad = $("data-pad");
        if (pad && pad.classList.contains("open")) {
          call("dataPad", "close");
        }
      } else if ((e.key === "Enter" || e.key === " ") && !bootDone) {
        // Enter/Space also skips boot when the overlay holds focus.
        var overlay = $("boot-overlay");
        if (overlay && !overlay.hidden && overlay.contains(document.activeElement)) {
          e.preventDefault();
          dismissBoot();
        }
      }
    });
  }

  /* ===================================================================
     18. INIT
     =================================================================== */
  function init() {
    if (isStaticSnapshot()) {
      document.body.classList.add("is-static-snapshot");
    }

    // Live clock.
    tickClock();
    window.setInterval(tickClock, 1000);

    // Static UI prerender (placeholders before data arrives).
    setText("ch-protocol", "A2A/" + (document.body.getAttribute("data-a2a-version") || "1.0"));
    setConn("idle", "STANDBY");
    renderHeader();
    renderRoster();
    renderThreat();
    renderLogistics();
    renderTroop(null);
    renderDeadLetters([]);
    renderAudit([]);

    // Uplink blink indicator label.
    setText("ch-uplink", "UPLINK: FULCRUM CHANNEL");

    // Build the holotable static scope.
    call("holotable", "mount");

    wireControls();
    wireKeyboard();

    // Boot animation + data load run IN PARALLEL (never block fetch).
    runBoot();
    loadAll().then(function () {
      // Initial load is CALM — the assessment shows the analysis (THREAT: HIGH)
      // but the imperial sector + red-alert stay down. The "⚠ contact → repelled"
      // arc plays when you DISPATCH a mission or hit REPLAY.
      refreshHolotable();
    });

    // Open the live feed.
    connectSSE();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
