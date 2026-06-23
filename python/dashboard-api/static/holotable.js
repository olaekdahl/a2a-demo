/* ============================================================================
 * Echo Command Interface — holotable.js
 * window.Echo.holotable : the CENTERPIECE command-table RADAR SCOPE projection.
 *
 * Renders a tactical radar scope into svg#holotable (720x720 viewBox) with an
 * optional canvas#holotable-fx layer for the rotating sweep + noise. This is a
 * planetary tactical projection of the Hoth theatre, NOT a force-directed graph:
 *   - concentric range rings, radial bearing lines, faint map grid + tick labels
 *   - a rotating radar sweep (fading trailing wedge), gated by reduced-motion
 *   - a Hoth planetary disc with contour lines + a pulsing ECHO BASE marker
 *   - an IMPERIAL THREAT SECTOR (hatched arc / "northern ridge") that scales with
 *     derived.threat.risk_score
 *   - a FLEET REINFORCEMENT ROUTE (Rendezvous → Hyperspace → Hoth Orbit → Echo Base)
 *     with stop nodes that light from the current fleet phase
 *   - AGENT NODES around the perimeter with language-specific SHAPES
 *     (python=diamond, typescript=triangle, go=hexagon; command=centered reticle)
 *   - a LEGEND (#holotable-legend)
 *   - beam(): animated quadratic arc + travelling pulse + fading trail between nodes
 *
 * app.js loads AFTER this file, so Echo.util is only referenced *inside* methods.
 * ==========================================================================*/
(function () {
  "use strict";

  window.Echo = window.Echo || {};

  var SVG = "http://www.w3.org/2000/svg";

  /* ---- scope geometry (matches svg#holotable viewBox 0 0 720 720) -------- */
  var VB = 720;
  var CX = 360;
  var CY = 372;          /* nudge centre down a touch to leave header room */
  var R_SCOPE = 308;     /* outer range ring radius                        */
  var R_PERIM = 332;     /* radius the agent nodes sit on                  */
  var R_PLANET = 96;     /* Hoth disc radius                               */

  /* ---- fixed agent → language fallback (mirrors contract default table) -- */
  var LANG_FALLBACK = {
    "resistance-command-agent": "python",
    "agent-registry": "python",
    "dashboard-api": "python",
    "intelligence-agent": "typescript",
    "communications-relay-agent": "typescript",
    "tactical-agent": "go",
    "logistics-agent": "go",
    "fleet-agent": "go"
  };

  /* ---- fleet phase order + waypoint mapping (from contract §6) ----------- */
  var PHASE_ORDER = [
    "submitted", "calculating_hyperspace_route", "loading_transports",
    "jump_to_lightspeed", "arriving_hoth_orbit", "deployed", "completed"
  ];
  /* phase → route waypoint index (0 Rendezvous … 3 Echo Base) */
  var PHASE_WAYPOINT = {
    submitted: 0,
    calculating_hyperspace_route: 0,
    loading_transports: 0,
    jump_to_lightspeed: 1,
    arriving_hoth_orbit: 2,
    deployed: 3,
    completed: 3
  };
  var PHASE_LABEL = {
    submitted: "ORDER RECEIVED",
    calculating_hyperspace_route: "PLOTTING HYPERSPACE ROUTE",
    loading_transports: "LOADING TRANSPORTS",
    jump_to_lightspeed: "JUMP TO LIGHTSPEED",
    arriving_hoth_orbit: "ARRIVING HOTH ORBIT",
    deployed: "DEPLOYED — ECHO BASE",
    completed: "REINFORCEMENTS DEPLOYED"
  };

  /* route waypoint anchor points in scope coordinates.
   * Rendezvous sits off the lower-left perimeter; the path climbs through
   * Hyperspace and Hoth Orbit to Echo Base on the planetary disc.        */
  var ROUTE_NODES = [
    { key: "rendezvous", label: "RENDEZVOUS", x: CX - 250, y: CY + 232 },
    { key: "hyperspace", label: "HYPERSPACE", x: CX - 150, y: CY + 96 },
    { key: "orbit", label: "HOTH ORBIT", x: CX - 36, y: CY - 78 }
    /* the 4th stop (Echo Base) is the base marker on the planet itself */
  ];

  /* ---- language → shape + accent variable -------------------------------- */
  var LANG_INFO = {
    python: { cls: "ht-node--python", shape: "diamond", varName: "--lang-python", role: "COMMAND / COORD" },
    typescript: { cls: "ht-node--typescript", shape: "triangle", varName: "--lang-typescript", role: "SIGNAL / INTEL" },
    go: { cls: "ht-node--go", shape: "hexagon", varName: "--lang-go", role: "TACTICAL / EXEC" }
  };

  /* ======================================================================
   * tiny self-contained helpers (no dependency on Echo.util at load time)
   * ====================================================================*/
  function mk(tag, attrs, parent) {
    var n = document.createElementNS(SVG, tag);
    if (attrs) {
      for (var k in attrs) {
        if (attrs.hasOwnProperty(k) && attrs[k] != null) {
          n.setAttribute(k, attrs[k]);
        }
      }
    }
    if (parent) parent.appendChild(n);
    return n;
  }
  function clear(node) { while (node && node.firstChild) node.removeChild(node.firstChild); }
  function rad(deg) { return (deg - 90) * Math.PI / 180; } /* 0deg = up/north */
  function ptOn(r, deg) { return { x: CX + r * Math.cos(rad(deg)), y: CY + r * Math.sin(rad(deg)) }; }
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  function num(v) { var n = Number(v); return isFinite(n) ? n : NaN; }

  function reduced() {
    try {
      if (window.Echo && Echo.util && typeof Echo.util.prefersReducedMotion === "function") {
        return !!Echo.util.prefersReducedMotion();
      }
    } catch (e) { /* fall through */ }
    return window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  }
  function utilLang(name) {
    try {
      if (window.Echo && Echo.util && typeof Echo.util.langOf === "function") {
        var l = Echo.util.langOf(name);
        if (l) return l;
      }
    } catch (e) { /* ignore */ }
    return LANG_FALLBACK[name] || "python";
  }
  function utilShort(name) {
    try {
      if (window.Echo && Echo.util && typeof Echo.util.shortName === "function") {
        var s = Echo.util.shortName(name);
        if (s) return s;
      }
    } catch (e) { /* ignore */ }
    return String(name || "")
      .replace(/-agent$/, "")
      .replace(/^resistance-command$/, "command")
      .replace(/^communications-relay$/, "relay");
  }
  /* read a CSS custom property off :root, with a hard fallback colour */
  function cssVar(name, fallback) {
    try {
      var v = getComputedStyle(document.documentElement).getPropertyValue(name);
      if (v && v.trim()) return v.trim();
    } catch (e) { /* ignore */ }
    return fallback;
  }

  /* ======================================================================
   * module state
   * ====================================================================*/
  var ST = {
    mounted: false,
    svg: null,
    fx: null,            /* canvas#holotable-fx */
    fxCtx: null,
    layers: {},          /* named <g> layers                              */
    nodes: {},           /* name -> { x, y, lang, group, el }             */
    routeStops: [],      /* DOM refs for the 4 route stops                */
    threatEl: null,      /* <g.ht-threat>                                 */
    threatBand: "unknown",
    threatScore: 0,
    phase: null,
    sweepRAF: 0,
    sweepAngle: 0,
    beams: [],           /* active transient beam objects                 */
    beamLayer: null,
    pulseRAF: 0,
    pulseT: 0,
    sized: false
  };

  /* ======================================================================
   * MOUNT — build the static scope
   * ====================================================================*/
  function mount() {
    var svg = document.getElementById("holotable");
    if (!svg) return;
    ST.svg = svg;

    svg.setAttribute("viewBox", "0 0 " + VB + " " + VB);
    if (!svg.getAttribute("preserveAspectRatio")) {
      svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
    }
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label",
      "Tactical radar scope: Hoth theatre, Echo Base, fleet reinforcement route and agent comm nodes.");
    clear(svg);

    /* gradient / filter defs ------------------------------------------- */
    buildDefs(svg);

    /* ordered layers (paint order matters) ----------------------------- */
    ST.layers = {};
    ["grid", "rings", "planet", "threat", "route", "sweep", "beams", "nodes", "labels"]
      .forEach(function (name) {
        var g = mk("g", { "class": "ht-layer ht-layer--" + name }, svg);
        ST.layers[name] = g;
      });
    ST.beamLayer = ST.layers.beams;

    buildGrid(ST.layers.grid);
    buildRings(ST.layers.rings);
    buildPlanet(ST.layers.planet);
    buildThreat(ST.layers.threat);
    buildRoute(ST.layers.route);
    buildSweepSVG(ST.layers.sweep);   /* SVG fallback sweep wedge */

    /* canvas FX layer (optional) --------------------------------------- */
    ST.fx = document.getElementById("holotable-fx");
    if (ST.fx && ST.fx.getContext) {
      try { ST.fxCtx = ST.fx.getContext("2d"); } catch (e) { ST.fxCtx = null; }
    }

    buildLegend();

    ST.mounted = true;
    ST.phase = ST.phase || "submitted";

    startSweep();
    startPulse();

    window.addEventListener("resize", sizeFx, { passive: true });
    sizeFx();
  }

  /* ----- defs: gradients + filters ---------------------------------- */
  function buildDefs(svg) {
    var defs = mk("defs", null, svg);

    var rg = mk("radialGradient",
      { id: "ht-scope-grad", cx: "50%", cy: "50%", r: "62%" }, defs);
    mk("stop", { offset: "0%", "stop-color": "rgba(20,32,42,0.55)" }, rg);
    mk("stop", { offset: "62%", "stop-color": "rgba(10,17,24,0.30)" }, rg);
    mk("stop", { offset: "100%", "stop-color": "rgba(7,10,14,0.0)" }, rg);

    var pg = mk("radialGradient",
      { id: "ht-planet-grad", cx: "38%", cy: "34%", r: "78%" }, defs);
    mk("stop", { offset: "0%", "stop-color": "rgba(143,194,224,0.34)" }, pg);
    mk("stop", { offset: "55%", "stop-color": "rgba(90,130,158,0.16)" }, pg);
    mk("stop", { offset: "100%", "stop-color": "rgba(40,62,80,0.05)" }, pg);

    /* sweep wedge gradient (radar trailing fade) */
    var sg = mk("linearGradient",
      { id: "ht-sweep-grad", x1: "0%", y1: "0%", x2: "100%", y2: "0%" }, defs);
    mk("stop", { offset: "0%", "stop-color": "rgba(79,214,230,0.0)" }, sg);
    mk("stop", { offset: "78%", "stop-color": "rgba(79,214,230,0.10)" }, sg);
    mk("stop", { offset: "100%", "stop-color": "rgba(79,214,230,0.34)" }, sg);

    /* diagonal hazard hatch for the imperial threat sector */
    var hatch = mk("pattern",
      { id: "ht-hatch", width: 9, height: 9, patternUnits: "userSpaceOnUse",
        patternTransform: "rotate(45)" }, defs);
    mk("rect", { width: 9, height: 9, fill: "rgba(224,84,58,0.05)" }, hatch);
    mk("line", { x1: 0, y1: 0, x2: 0, y2: 9, stroke: "rgba(224,84,58,0.42)",
      "stroke-width": 2.4 }, hatch);

    /* soft glow for active markers / beams */
    var f = mk("filter",
      { id: "ht-glow", x: "-60%", y: "-60%", width: "220%", height: "220%" }, defs);
    var blur = mk("feGaussianBlur", { "in": "SourceGraphic", stdDeviation: 2.2,
      result: "b" }, f);
    var merge = mk("feMerge", null, f);
    mk("feMergeNode", { "in": "b" }, merge);
    mk("feMergeNode", { "in": "SourceGraphic" }, merge);
    void blur;

    /* clip to keep contour lines inside the planetary disc */
    var clip = mk("clipPath", { id: "ht-planet-clip" }, defs);
    mk("circle", { cx: CX, cy: CY, r: R_PLANET }, clip);
  }

  /* ----- faint rectilinear map grid underlay ------------------------ */
  function buildGrid(g) {
    var step = 48;
    var minX = CX - R_SCOPE, maxX = CX + R_SCOPE;
    var minY = CY - R_SCOPE, maxY = CY + R_SCOPE;
    /* clip grid to the scope circle */
    var cid = "ht-scope-clip";
    var defs = ST.svg.querySelector("defs");
    var clip = mk("clipPath", { id: cid }, defs);
    mk("circle", { cx: CX, cy: CY, r: R_SCOPE }, clip);
    g.setAttribute("clip-path", "url(#" + cid + ")");

    var x, y;
    for (x = CX - Math.ceil(R_SCOPE / step) * step; x <= maxX; x += step) {
      mk("line", { "class": "ht-grid-line", x1: x, y1: minY, x2: x, y2: maxY }, g);
    }
    for (y = CY - Math.ceil(R_SCOPE / step) * step; y <= maxY; y += step) {
      mk("line", { "class": "ht-grid-line", x1: minX, y1: y, x2: maxX, y2: y }, g);
    }
    void minX; void minY;
  }

  /* ----- concentric range rings + radial bearing lines + ticks ------ */
  function buildRings(g) {
    /* faint filled scope disc */
    mk("circle", { cx: CX, cy: CY, r: R_SCOPE, fill: "url(#ht-scope-grad)",
      stroke: "none" }, g);

    /* concentric range rings */
    var i, r;
    var ringCount = 4;
    for (i = 1; i <= ringCount; i++) {
      r = (R_SCOPE / ringCount) * i;
      mk("circle", { "class": "ht-ring" + (i === ringCount ? " ht-ring--outer" : ""),
        cx: CX, cy: CY, r: r, fill: "none" }, g);
    }

    /* radial bearing lines every 30deg */
    var deg;
    for (deg = 0; deg < 360; deg += 30) {
      var inner = ptOn(R_PLANET + 8, deg);
      var outer = ptOn(R_SCOPE, deg);
      mk("line", { "class": "ht-bearing" + (deg % 90 === 0 ? " ht-bearing--major" : ""),
        x1: inner.x, y1: inner.y, x2: outer.x, y2: outer.y }, g);
    }

    /* range tick labels along the vertical axis */
    var ranges = ["0.4", "0.8", "1.2", "1.6"];
    for (i = 1; i <= ringCount; i++) {
      r = (R_SCOPE / ringCount) * i;
      var t = mk("text", { "class": "ht-tick-label", x: CX + 5, y: CY - r + 13 }, g);
      t.textContent = ranges[i - 1] + "PU";
    }

    /* bearing tick labels at the cardinal/inter-cardinal points */
    var bearings = [
      { deg: 0, t: "000" }, { deg: 45, t: "045" }, { deg: 90, t: "090" },
      { deg: 135, t: "135" }, { deg: 180, t: "180" }, { deg: 225, t: "225" },
      { deg: 270, t: "270" }, { deg: 315, t: "315" }
    ];
    bearings.forEach(function (b) {
      var p = ptOn(R_SCOPE - 16, b.deg);
      var tx = mk("text", { "class": "ht-bearing-label", x: p.x, y: p.y }, g);
      tx.setAttribute("text-anchor", "middle");
      tx.setAttribute("dominant-baseline", "middle");
      tx.textContent = b.t;
    });

    /* centre crosshair tick */
    mk("line", { "class": "ht-cross", x1: CX - 7, y1: CY, x2: CX + 7, y2: CY }, g);
    mk("line", { "class": "ht-cross", x1: CX, y1: CY - 7, x2: CX, y2: CY + 7 }, g);
  }

  /* ----- Hoth planetary disc with topographic contours + Echo Base -- */
  function buildPlanet(g) {
    var pg = mk("g", { "class": "ht-planet" }, g);
    mk("circle", { "class": "ht-planet-disc", cx: CX, cy: CY, r: R_PLANET,
      fill: "url(#ht-planet-grad)" }, pg);
    mk("circle", { "class": "ht-planet-rim", cx: CX, cy: CY, r: R_PLANET,
      fill: "none" }, pg);

    /* contour lines clipped to the disc — irregular topographic rings */
    var cg = mk("g", { "class": "ht-contours", "clip-path": "url(#ht-planet-clip)" }, pg);
    var rings = [
      { rx: 78, ry: 60, dx: -14, dy: 8, rot: -18 },
      { rx: 58, ry: 46, dx: 10, dy: -10, rot: 12 },
      { rx: 40, ry: 34, dx: -4, dy: 16, rot: -8 },
      { rx: 24, ry: 20, dx: 14, dy: 2, rot: 20 }
    ];
    rings.forEach(function (c) {
      var e = mk("ellipse", { "class": "ht-contour", cx: CX + c.dx, cy: CY + c.dy,
        rx: c.rx, ry: c.ry, fill: "none" }, cg);
      e.setAttribute("transform", "rotate(" + c.rot + " " + (CX + c.dx) + " " + (CY + c.dy) + ")");
    });
    /* a couple of fault/ridge strokes for texture */
    mk("path", { "class": "ht-fault",
      d: "M " + (CX - 70) + " " + (CY + 18) + " q 40 -22 78 6 q 30 22 64 -4",
      fill: "none" }, cg);
    mk("path", { "class": "ht-fault",
      d: "M " + (CX - 40) + " " + (CY - 52) + " q 24 30 8 70",
      fill: "none" }, cg);

    /* planet stamped label */
    var hl = mk("text", { "class": "ht-planet-label", x: CX, y: CY + R_PLANET + 22 }, pg);
    hl.setAttribute("text-anchor", "middle");
    hl.textContent = "HOTH";

    /* ECHO BASE marker — the route destination (pulses) */
    var base = ptOn(R_PLANET - 18, 24);   /* on the disc, NE quadrant */
    var bg = mk("g", { "class": "ht-base", id: "ht-echo-base" }, pg);
    mk("circle", { "class": "ht-base-pulse", cx: base.x, cy: base.y, r: 6,
      fill: "none" }, bg);
    /* small bracketed installation glyph */
    mk("rect", { "class": "ht-base-core", x: base.x - 4, y: base.y - 4,
      width: 8, height: 8 }, bg);
    mk("path", { "class": "ht-base-bracket",
      d: "M " + (base.x - 9) + " " + (base.y - 6) + " l 0 -3 l 3 0 " +
         "M " + (base.x + 9) + " " + (base.y - 6) + " l 0 -3 l -3 0 " +
         "M " + (base.x - 9) + " " + (base.y + 6) + " l 0 3 l 3 0 " +
         "M " + (base.x + 9) + " " + (base.y + 6) + " l 0 3 l -3 0",
      fill: "none" }, bg);
    var bl = mk("text", { "class": "ht-base-label", x: base.x + 14, y: base.y + 3 }, bg);
    bl.textContent = "ECHO BASE";
    /* remember for route terminus */
    ST.echoBase = base;
    var ttl = mk("title", null, bg);
    ttl.textContent = "ECHO BASE — reinforcement destination";
  }

  /* ----- imperial threat sector (hatched arc, northern ridge) ------- */
  function buildThreat(g) {
    /* the sector lives on the upper-left ("northern ridge"); centred near
     * bearing 330 and grows with risk. Built as a <g> we restyle later.   */
    var tg = mk("g", { "class": "ht-threat threat--unknown", id: "ht-threat-sector" }, g);
    ST.threatEl = tg;

    mk("path", { "class": "ht-threat-arc", d: "", fill: "url(#ht-hatch)" }, tg);
    mk("path", { "class": "ht-threat-edge", d: "", fill: "none" }, tg);
    /* stamped sector label */
    var lbl = mk("text", { "class": "ht-threat-label", x: 0, y: 0 }, tg);
    lbl.setAttribute("text-anchor", "middle");
    lbl.textContent = "IMPERIAL SECTOR";

    updateThreatGeometry();   /* draw initial (unknown) extent */
  }

  /* compute + redraw the threat sector arc for current band/score */
  function updateThreatGeometry() {
    if (!ST.threatEl) return;
    var arc = ST.threatEl.querySelector(".ht-threat-arc");
    var edge = ST.threatEl.querySelector(".ht-threat-edge");
    var lbl = ST.threatEl.querySelector(".ht-threat-label");

    /* half-angle of the sector scales with risk score (0..100) */
    var score = clamp(num(ST.threatScore) || 0, 0, 100);
    var base = 20;                       /* min half-angle (deg) */
    var span = base + (score / 100) * 40; /* up to ~60deg half-angle */
    if (ST.threatBand === "unknown") span = 16;
    var centerBearing = 332;             /* northern ridge, upper-left */
    var a0 = centerBearing - span;
    var a1 = centerBearing + span;

    /* annular band between two radii near the perimeter */
    var rOuter = R_SCOPE - 2;
    var rInner = R_SCOPE - 46 - (score / 100) * 30; /* thicker at high risk */

    var pOuter0 = ptOn(rOuter, a0);
    var pOuter1 = ptOn(rOuter, a1);
    var pInner1 = ptOn(rInner, a1);
    var pInner0 = ptOn(rInner, a0);
    var large = (a1 - a0) > 180 ? 1 : 0;

    var d =
      "M " + pOuter0.x.toFixed(1) + " " + pOuter0.y.toFixed(1) +
      " A " + rOuter + " " + rOuter + " 0 " + large + " 1 " +
        pOuter1.x.toFixed(1) + " " + pOuter1.y.toFixed(1) +
      " L " + pInner1.x.toFixed(1) + " " + pInner1.y.toFixed(1) +
      " A " + rInner + " " + rInner + " 0 " + large + " 0 " +
        pInner0.x.toFixed(1) + " " + pInner0.y.toFixed(1) +
      " Z";
    if (arc) arc.setAttribute("d", d);
    if (edge) edge.setAttribute("d", d);

    /* place label along the sector mid-bearing */
    if (lbl) {
      var mid = ptOn((rOuter + rInner) / 2, centerBearing);
      lbl.setAttribute("x", mid.x.toFixed(1));
      lbl.setAttribute("y", mid.y.toFixed(1));
      var rot = centerBearing; /* roughly tangent */
      lbl.setAttribute("transform",
        "rotate(" + (rot - 90 + 180) + " " + mid.x.toFixed(1) + " " + mid.y.toFixed(1) + ")");
    }
  }

  /* ----- fleet reinforcement route (dashed) + stop nodes ------------ */
  function buildRoute(g) {
    ST.routeStops = [];

    /* full ordered list of route points incl. Echo Base terminus */
    var pts = ROUTE_NODES.map(function (n) { return { x: n.x, y: n.y, label: n.label, key: n.key }; });
    var base = ST.echoBase || ptOn(R_PLANET - 18, 24);
    pts.push({ x: base.x, y: base.y, label: "ECHO BASE", key: "echo-base" });

    /* build a smooth-ish dashed path through the waypoints */
    var d = "M " + pts[0].x + " " + pts[0].y;
    for (var i = 1; i < pts.length; i++) {
      var p0 = pts[i - 1], p1 = pts[i];
      var mx = (p0.x + p1.x) / 2, my = (p0.y + p1.y) / 2;
      /* bow the segment slightly toward the scope centre for a curved feel */
      var bowX = mx + (CX - mx) * 0.12;
      var bowY = my + (CY - my) * 0.12;
      d += " Q " + bowX.toFixed(1) + " " + bowY.toFixed(1) + " " + p1.x + " " + p1.y;
    }
    mk("path", { "class": "ht-route", id: "ht-route-path", d: d, fill: "none" }, g);
    /* progress overlay (clipped via stroke-dash on update) */
    var prog = mk("path", { "class": "ht-route-progress", id: "ht-route-progress",
      d: d, fill: "none" }, g);
    ST.routePath = prog;

    /* stop nodes */
    pts.forEach(function (p, idx) {
      var sg = mk("g", { "class": "ht-stop", "data-stop": idx, "data-key": p.key }, g);
      mk("circle", { "class": "ht-stop-ring", cx: p.x, cy: p.y, r: 9, fill: "none" }, sg);
      mk("circle", { "class": "ht-stop-core", cx: p.x, cy: p.y, r: 3.4 }, sg);
      /* label offset away from centre */
      var awayX = p.x + (p.x - CX) * 0.06;
      var lblX = p.x + (p.x < CX ? -14 : 14);
      var anchor = p.x < CX ? "end" : "start";
      /* echo-base label points inward to avoid the planet edge */
      if (p.key === "echo-base") { lblX = p.x + 14; anchor = "start"; }
      var t = mk("text", { "class": "ht-stop-label", x: lblX, y: p.y - 14 }, sg);
      t.setAttribute("text-anchor", anchor);
      t.textContent = p.label;
      void awayX;
      var ttl = mk("title", null, sg);
      ttl.textContent = "Route waypoint: " + p.label;
      ST.routeStops.push(sg);
    });

    /* travelling fleet glyph along the route (set by phase) */
    ST.fleetGlyph = mk("g", { "class": "ht-fleet-glyph", id: "ht-fleet-glyph" }, g);
    mk("path", { "class": "ht-fleet-tri", d: "M 0 -6 L 5 5 L 0 2 L -5 5 Z" }, ST.fleetGlyph);
    ST.fleetGlyph.style.opacity = "0";
  }

  /* ----- SVG radar sweep wedge (used when canvas FX absent) ---------- */
  function buildSweepSVG(g) {
    /* a rotating wedge: from centre, a fading trailing arc */
    var wedge = mk("g", { "class": "ht-sweep", id: "ht-sweep" }, g);
    var span = 46; /* degrees of trailing wedge */
    var p0 = ptOn(R_SCOPE, -span);
    var p1 = ptOn(R_SCOPE, 0);
    var d = "M " + CX + " " + CY +
            " L " + p0.x.toFixed(1) + " " + p0.y.toFixed(1) +
            " A " + R_SCOPE + " " + R_SCOPE + " 0 0 1 " +
            p1.x.toFixed(1) + " " + p1.y.toFixed(1) + " Z";
    mk("path", { "class": "ht-sweep-wedge", d: d, fill: "url(#ht-sweep-grad)" }, wedge);
    /* leading edge line */
    mk("line", { "class": "ht-sweep-line", x1: CX, y1: CY, x2: p1.x, y2: p1.y }, wedge);
    ST.sweepEl = wedge;
  }

  /* ======================================================================
   * SWEEP animation (RAF) — gated by reduced motion
   * ====================================================================*/
  function startSweep() {
    stopSweep();
    if (reduced()) {
      /* park the sweep at a fixed bearing, no rotation */
      if (ST.sweepEl) ST.sweepEl.setAttribute("transform", "rotate(45 " + CX + " " + CY + ")");
      drawFxStatic();
      return;
    }
    var last = performance.now();
    var degPerSec = 28; /* ~13s per revolution, calm */
    function step(now) {
      var dt = (now - last) / 1000; last = now;
      ST.sweepAngle = (ST.sweepAngle + degPerSec * dt) % 360;
      if (ST.sweepEl) {
        ST.sweepEl.setAttribute("transform",
          "rotate(" + ST.sweepAngle.toFixed(2) + " " + CX + " " + CY + ")");
      }
      drawFx(ST.sweepAngle);
      ST.sweepRAF = requestAnimationFrame(step);
    }
    ST.sweepRAF = requestAnimationFrame(step);
  }
  function stopSweep() {
    if (ST.sweepRAF) { cancelAnimationFrame(ST.sweepRAF); ST.sweepRAF = 0; }
  }

  /* canvas FX: faint rotating sweep glow + subtle noise speckle */
  function sizeFx() {
    if (!ST.fx) return;
    var rect = ST.fx.getBoundingClientRect();
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    var w = Math.max(2, Math.round(rect.width * dpr));
    var h = Math.max(2, Math.round(rect.height * dpr));
    if (ST.fx.width !== w || ST.fx.height !== h) {
      ST.fx.width = w; ST.fx.height = h;
    }
    ST.fxScale = { w: rect.width || VB, h: rect.height || VB, dpr: dpr };
    ST.sized = true;
    if (reduced()) drawFxStatic();
  }
  function fxMap() {
    /* map scope coords (720 viewBox) to canvas pixel space */
    var s = ST.fxScale || { w: VB, h: VB, dpr: 1 };
    var k = Math.min(s.w, s.h) / VB;
    var offX = (s.w - VB * k) / 2;
    var offY = (s.h - VB * k) / 2;
    return { k: k * s.dpr, ox: offX * s.dpr, oy: offY * s.dpr,
             cx: (offX + CX * k) * s.dpr, cy: (offY + CY * k) * s.dpr };
  }
  function drawFx(angle) {
    if (!ST.fxCtx) return;
    var ctx = ST.fxCtx;
    var m = fxMap();
    ctx.clearRect(0, 0, ST.fx.width, ST.fx.height);
    var rcyan = cssVar("--radar", "#4fd6e6");
    /* rotating glow gradient wedge */
    ctx.save();
    ctx.translate(m.cx, m.cy);
    ctx.rotate((angle - 90) * Math.PI / 180);
    var R = (R_SCOPE) * m.k;
    var grad = ctx.createConicGradient ? null : null;
    /* manual fading wedge using a radial-ish arc fan */
    var steps = 26;
    for (var i = 0; i < steps; i++) {
      var a0 = (-i * 1.9) * Math.PI / 180;
      var a1 = (-(i + 1) * 1.9) * Math.PI / 180;
      var alpha = 0.10 * (1 - i / steps);
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.arc(0, 0, R, a1, a0, false);
      ctx.closePath();
      ctx.fillStyle = rgba(rcyan, alpha);
      ctx.fill();
    }
    ctx.restore();
    void grad;
  }
  function drawFxStatic() {
    if (!ST.fxCtx) return;
    var ctx = ST.fxCtx;
    ctx.clearRect(0, 0, ST.fx.width, ST.fx.height);
    /* a single faint parked wedge so the scope still reads as a radar */
    var m = fxMap();
    ctx.save();
    ctx.translate(m.cx, m.cy);
    ctx.rotate((45 - 90) * Math.PI / 180);
    var R = R_SCOPE * m.k;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.arc(0, 0, R, (-44) * Math.PI / 180, 0, false);
    ctx.closePath();
    ctx.fillStyle = rgba(cssVar("--radar", "#4fd6e6"), 0.05);
    ctx.fill();
    ctx.restore();
  }
  /* convert a hex/rgb css colour + alpha → rgba() string */
  function rgba(col, a) {
    col = String(col || "").trim();
    if (col.charAt(0) === "#") {
      var h = col.slice(1);
      if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
      var r = parseInt(h.slice(0, 2), 16),
          g = parseInt(h.slice(2, 4), 16),
          b = parseInt(h.slice(4, 6), 16);
      return "rgba(" + r + "," + g + "," + b + "," + a + ")";
    }
    if (col.indexOf("rgb") === 0) {
      return col.replace(/rgba?\(([^)]+)\)/, function (_, body) {
        var parts = body.split(",").slice(0, 3).join(",");
        return "rgba(" + parts + "," + a + ")";
      });
    }
    return "rgba(79,214,230," + a + ")";
  }

  /* ======================================================================
   * gentle pulse loop (base + active node reticles), RAF, reduced-aware
   * ====================================================================*/
  function startPulse() {
    stopPulse();
    if (reduced()) return; /* CSS handles static state; no JS pulsing */
    var last = performance.now();
    function step(now) {
      var dt = (now - last); last = now;
      ST.pulseT += dt;
      ST.pulseRAF = requestAnimationFrame(step);
    }
    ST.pulseRAF = requestAnimationFrame(step);
  }
  function stopPulse() {
    if (ST.pulseRAF) { cancelAnimationFrame(ST.pulseRAF); ST.pulseRAF = 0; }
  }

  /* ======================================================================
   * RENDER — place agent nodes, update threat + route highlight
   * ====================================================================*/
  function render(agents, derived) {
    if (!ST.mounted) mount();
    if (!ST.mounted) return;

    agents = Array.isArray(agents) ? agents.slice() : [];
    /* fall back to the canonical roster so the scope is never empty */
    if (!agents.length) {
      agents = Object.keys(LANG_FALLBACK)
        .filter(function (n) { return /-agent$/.test(n); })
        .map(function (n) { return { name: n }; });
    }

    placeNodes(agents);

    /* threat sector from derived.threat.risk_score / threat_level */
    var threat = derived && derived.threat ? derived.threat : null;
    if (threat) {
      var score = num(threat.risk_score);
      if (isFinite(score)) ST.threatScore = score;
      var band = bandFromThreat(threat);
      setThreat(band);
    } else {
      /* no active threat → hide the imperial sector (nominal / contained) */
      setThreat("unknown");
    }

    /* route highlight from troop phase */
    var troopPhase = null;
    if (derived && derived.troop && derived.troop.phase) troopPhase = derived.troop.phase;
    if (troopPhase) setPhase(troopPhase);
    else applyRouteProgress();
  }

  function bandFromThreat(threat) {
    var lvl = String(threat.threat_level || "").toLowerCase();
    if (lvl === "high" || lvl === "critical" || lvl === "severe") return "high";
    if (lvl === "moderate" || lvl === "mod" || lvl === "medium" || lvl === "elevated") return "mod";
    if (lvl === "low" || lvl === "minimal" || lvl === "nominal") return "low";
    var s = num(threat.risk_score);
    if (isFinite(s)) {
      if (s >= 70) return "high";
      if (s >= 40) return "mod";
      return "low";
    }
    return "unknown";
  }

  /* place agent nodes around the perimeter; command centred/top, larger */
  function placeNodes(agents) {
    var layer = ST.layers.nodes;
    clear(layer);
    ST.nodes = {};

    var command = null;
    var others = [];
    agents.forEach(function (a) {
      if (!a || !a.name) return;
      if (a.name === "resistance-command-agent") command = a;
      else others.push(a);
    });

    /* place command node — slightly above centre, between the planet rim
     * and the perimeter at the top of the scope.                          */
    if (command) {
      var cp = ptOn(R_PLANET + 96, 0); /* due north, above the planet */
      makeNode(command, cp.x, cp.y, true);
    }

    /* Fixed bearings keep every node OFF the busy bottom of the scope (the Hoth
     * planet, the "HOTH" label and the mission stamp at ~180deg) and off the
     * lower-left where the reinforcement route runs (~225deg). This stops the
     * intelligence node + label from being buried. */
    var BEARING = {
      "tactical-agent": 320,                 /* NW  */
      "communications-relay-agent": 40,      /* NE  */
      "fleet-agent": 92,                     /* E   */
      "intelligence-agent": 136,             /* SE (clear of the SW route)  */
      "logistics-agent": 266                 /* W   */
    };
    var SLOTS = [320, 40, 92, 136, 266, 300, 60]; /* fallback for unknown agents */
    var slotI = 0;
    others.forEach(function (a) {
      var deg = BEARING.hasOwnProperty(a.name)
        ? BEARING[a.name]
        : SLOTS[slotI++ % SLOTS.length];
      var p = ptOn(R_PERIM, deg);
      makeNode(a, p.x, p.y, false);
    });
  }

  function makeNode(agent, x, y, isCommand) {
    var name = agent.name;
    var lang = (agent.language && LANG_INFO[String(agent.language).toLowerCase()])
      ? String(agent.language).toLowerCase()
      : utilLang(name);
    if (!LANG_INFO[lang]) lang = "python";
    var info = LANG_INFO[lang];

    var cls = "ht-node " + info.cls + (isCommand ? " ht-node--command" : "");
    var g = mk("g", { "class": cls, "data-name": name, "data-lang": lang,
      tabindex: "-1" }, ST.layers.nodes);
    g.setAttribute("transform", "translate(" + x.toFixed(1) + " " + y.toFixed(1) + ")");

    var size = isCommand ? 18 : 13;

    /* targeting reticle (always present on command; transient on others) */
    var ret = mk("g", { "class": "ht-reticle" }, g);
    var rr = size + 9;
    ["M {a} {b} L {a} {c}", "M {d} {b} L {d} {c}"].forEach(function () {});
    /* four corner ticks */
    var corners = [
      [-rr, -rr, 7, 0, 0, 7], [rr, -rr, -7, 0, 0, 7],
      [-rr, rr, 7, 0, 0, -7], [rr, rr, -7, 0, 0, -7]
    ];
    corners.forEach(function (c) {
      mk("path", { "class": "ht-reticle-corner",
        d: "M " + (c[0] + c[2]) + " " + c[1] + " L " + c[0] + " " + c[1] +
           " L " + c[0] + " " + (c[1] + c[5]), fill: "none" }, ret);
    });

    /* language-specific shape */
    var shapeEl;
    if (info.shape === "diamond") {
      shapeEl = mk("path", { "class": "ht-node-shape",
        d: "M 0 " + (-size) + " L " + size + " 0 L 0 " + size + " L " + (-size) + " 0 Z" }, g);
    } else if (info.shape === "triangle") {
      var h = size * 1.15;
      shapeEl = mk("path", { "class": "ht-node-shape",
        d: "M 0 " + (-h) + " L " + (size) + " " + (h * 0.78) +
           " L " + (-size) + " " + (h * 0.78) + " Z" }, g);
    } else { /* hexagon */
      var pts = [];
      for (var k = 0; k < 6; k++) {
        var ang = Math.PI / 180 * (60 * k - 30);
        pts.push((size * Math.cos(ang)).toFixed(1) + " " + (size * Math.sin(ang)).toFixed(1));
      }
      shapeEl = mk("path", { "class": "ht-node-shape",
        d: "M " + pts.join(" L ") + " Z" }, g);
    }
    void shapeEl;

    /* small inner core dot */
    mk("circle", { "class": "ht-node-core", cx: 0, cy: 0, r: isCommand ? 3.2 : 2.2 }, g);

    /* connector tick from node toward scope centre (reads as a contact spur) */
    var dir = Math.atan2(CY - y, CX - x);
    mk("line", { "class": "ht-node-spur",
      x1: Math.cos(dir) * (size + 2), y1: Math.sin(dir) * (size + 2),
      x2: Math.cos(dir) * (size + 14), y2: Math.sin(dir) * (size + 14) }, g);

    /* label */
    var short = utilShort(name);
    var labelBelow = y < CY; /* if node is upper half, put label above-ish */
    var ly = isCommand ? (size + 22) : (y < CY ? -(size + 14) : (size + 18));
    var t = mk("text", { "class": "ht-node-label", x: 0, y: ly }, g);
    t.setAttribute("text-anchor", "middle");
    t.textContent = String(short).toUpperCase();
    void labelBelow;

    /* tooltip */
    var ttl = mk("title", null, g);
    ttl.textContent = name + " — " + lang + " · " + info.role;

    ST.nodes[name] = { x: x, y: y, lang: lang, size: size, group: g, command: isCommand };
  }

  /* ======================================================================
   * THREAT — restyle the imperial sector by band
   * ====================================================================*/
  function setThreat(band) {
    band = (band === "low" || band === "mod" || band === "high") ? band : "unknown";
    ST.threatBand = band;
    if (ST.threatEl) {
      ST.threatEl.setAttribute("class", "ht-threat threat--" + band);
    }
    updateThreatGeometry();
  }

  /* ======================================================================
   * PHASE — advance the fleet route + caption
   * ====================================================================*/
  function setPhase(phase) {
    if (!phase) return;
    ST.phase = String(phase);
    applyRouteProgress();

    var cap = document.getElementById("holotable-phase");
    if (cap) {
      var label = PHASE_LABEL[ST.phase] || String(ST.phase).replace(/_/g, " ").toUpperCase();
      cap.textContent = label;
      cap.setAttribute("data-phase", ST.phase);
    }
  }

  /* light route stops .is-done / .is-active from current phase + slide glyph */
  function applyRouteProgress() {
    if (!ST.routeStops || !ST.routeStops.length) return;
    var wp = PHASE_WAYPOINT.hasOwnProperty(ST.phase) ? PHASE_WAYPOINT[ST.phase] : -1;
    var complete = (ST.phase === "completed");

    ST.routeStops.forEach(function (sg, idx) {
      sg.classList.remove("is-done", "is-active");
      if (wp < 0) return;
      if (idx < wp || (complete && idx <= wp)) sg.classList.add("is-done");
      else if (idx === wp) {
        if (complete) sg.classList.add("is-done");
        else sg.classList.add("is-active");
      }
    });
    /* on completion, mark every stop done */
    if (complete) {
      ST.routeStops.forEach(function (sg) {
        sg.classList.remove("is-active");
        sg.classList.add("is-done");
      });
    }

    /* stroke-dash reveal of the progress path up to the active waypoint */
    revealRoute(wp, complete);
    moveFleetGlyph(wp, complete);
  }

  function revealRoute(wp, complete) {
    var path = ST.routePath;
    if (!path || typeof path.getTotalLength !== "function") return;
    var total;
    try { total = path.getTotalLength(); } catch (e) { return; }
    if (!total) return;
    /* 4 stops → 3 segments; fraction of path revealed */
    var stops = ST.routeStops.length;
    var frac;
    if (wp < 0) frac = 0;
    else if (complete) frac = 1;
    else frac = clamp(wp / (stops - 1), 0, 1);
    path.style.strokeDasharray = total;
    path.style.strokeDashoffset = (total * (1 - frac)).toFixed(1);
  }

  function moveFleetGlyph(wp, complete) {
    var glyph = ST.fleetGlyph;
    var path = ST.routePath;
    if (!glyph || !path || typeof path.getTotalLength !== "function") return;
    var total;
    try { total = path.getTotalLength(); } catch (e) { return; }
    if (!total || wp < 0) { glyph.style.opacity = "0"; return; }
    var stops = ST.routeStops.length;
    var frac = complete ? 1 : clamp(wp / (stops - 1), 0, 1);
    var pt, ahead;
    try {
      pt = path.getPointAtLength(total * frac);
      ahead = path.getPointAtLength(Math.min(total, total * frac + 4));
    } catch (e) { return; }
    var ang = Math.atan2(ahead.y - pt.y, ahead.x - pt.x) * 180 / Math.PI + 90;
    glyph.setAttribute("transform",
      "translate(" + pt.x.toFixed(1) + " " + pt.y.toFixed(1) + ") rotate(" + ang.toFixed(1) + ")");
    glyph.style.opacity = complete ? "0" : "1";
  }

  /* ======================================================================
   * BEAM — animated quadratic arc between two nodes
   * ====================================================================*/
  function nodePoint(name) {
    if (name && ST.nodes[name]) return { x: ST.nodes[name].x, y: ST.nodes[name].y };
    /* unknown sender/recipient → use scope centre as a neutral anchor */
    return { x: CX, y: CY };
  }

  function beam(fromName, toName, opts) {
    if (!ST.mounted) return;
    opts = opts || {};
    var kind = opts.kind || "send";
    var from = nodePoint(fromName);
    var to = nodePoint(toName);

    /* highlight both endpoints briefly */
    activate(fromName);
    activate(toName);

    var lang = utilLang(fromName);
    if (!LANG_INFO[lang]) lang = "python";
    var color;
    if (kind === "dead-letter") color = cssVar("--alert", "#e0543a");
    else color = cssVar(LANG_INFO[lang].varName, cssVar("--radar", "#4fd6e6"));

    /* control point: bow the arc away from the scope centre for a curved
     * holographic feel; midpoint pushed outward.                          */
    var mx = (from.x + to.x) / 2, my = (from.y + to.y) / 2;
    var outX = mx - CX, outY = my - CY;
    var olen = Math.sqrt(outX * outX + outY * outY) || 1;
    var bow = 46;
    var cpx = mx + (outX / olen) * bow;
    var cpy = my + (outY / olen) * bow;
    /* if endpoints straddle the centre, bow perpendicular instead */
    if (olen < 40) {
      var dx = to.x - from.x, dy = to.y - from.y;
      var dl = Math.sqrt(dx * dx + dy * dy) || 1;
      cpx = mx + (-dy / dl) * bow;
      cpy = my + (dx / dl) * bow;
    }
    var d = "M " + from.x.toFixed(1) + " " + from.y.toFixed(1) +
            " Q " + cpx.toFixed(1) + " " + cpy.toFixed(1) + " " +
            to.x.toFixed(1) + " " + to.y.toFixed(1);

    var beamCls = "ht-beam";
    if (kind === "artifact") beamCls += " ht-beam--artifact";
    else if (kind === "dead-letter") beamCls += " ht-beam--dead-letter";
    else if (kind === "status") beamCls += " ht-beam--status";

    var g = mk("g", { "class": beamCls, "data-kind": kind }, ST.beamLayer);
    var trail = mk("path", { "class": "ht-beam-trail", d: d, fill: "none",
      stroke: color }, g);
    var pulse;
    if (kind === "artifact") {
      /* folded data-mote: a small square that rides the arc */
      pulse = mk("rect", { "class": "ht-pulse ht-pulse--mote",
        x: -3.5, y: -3.5, width: 7, height: 7, fill: color }, g);
      pulse.setAttribute("transform", "translate(" + from.x + " " + from.y + ") rotate(45)");
    } else {
      pulse = mk("circle", { "class": "ht-pulse", cx: 0, cy: 0, r: kind === "dead-letter" ? 4.5 : 3.6,
        fill: color }, g);
      pulse.setAttribute("transform", "translate(" + from.x + " " + from.y + ")");
    }

    var beamObj = {
      g: g, trail: trail, pulse: pulse, color: color, kind: kind,
      from: from, to: to, cpx: cpx, cpy: cpy, t: 0, start: 0, done: false
    };
    ST.beams.push(beamObj);

    if (reduced()) {
      /* reduced motion: no travel — flash the full arc, no moving pulse */
      g.classList.add("is-instant");
      if (pulse) pulse.style.display = "none";
      trail.style.opacity = "0.9";
      window.setTimeout(function () { removeBeam(beamObj); }, 520);
      window.setTimeout(function () { deactivate(fromName); deactivate(toName); }, 360);
      return;
    }

    var dur = kind === "dead-letter" ? 900 : 760;
    var startT = performance.now();
    beamObj.start = startT;
    function frame(now) {
      if (beamObj.done) return;
      var t = clamp((now - startT) / dur, 0, 1);
      beamObj.t = t;
      var ease = t * (2 - t); /* easeOut */
      var pt = quad(from, { x: cpx, y: cpy }, to, ease);
      if (beamObj.kind === "artifact") {
        pulse.setAttribute("transform",
          "translate(" + pt.x.toFixed(1) + " " + pt.y.toFixed(1) + ") rotate(" + (45 + ease * 180).toFixed(0) + ")");
      } else {
        pulse.setAttribute("transform", "translate(" + pt.x.toFixed(1) + " " + pt.y.toFixed(1) + ")");
      }
      /* trail fades in then out */
      trail.style.opacity = (t < 0.5 ? t * 1.6 : (1 - t) * 1.6).toFixed(3);
      if (t >= 1) {
        impact(to, color, beamObj.kind);
        removeBeam(beamObj);
        deactivate(fromName);
        deactivate(toName);
        return;
      }
      beamObj.raf = requestAnimationFrame(frame);
    }
    beamObj.raf = requestAnimationFrame(frame);
  }

  function quad(p0, p1, p2, t) {
    var mt = 1 - t;
    return {
      x: mt * mt * p0.x + 2 * mt * t * p1.x + t * t * p2.x,
      y: mt * mt * p0.y + 2 * mt * t * p1.y + t * t * p2.y
    };
  }

  /* small impact ring at the recipient on beam arrival */
  function impact(pt, color, kind) {
    if (reduced()) return;
    var ring = mk("circle", { "class": "ht-impact", cx: pt.x, cy: pt.y, r: 4,
      fill: "none", stroke: color }, ST.beamLayer);
    if (kind === "dead-letter") ring.classList.add("ht-impact--alert");
    var t0 = performance.now();
    function grow(now) {
      var t = clamp((now - t0) / 420, 0, 1);
      ring.setAttribute("r", (4 + t * 16).toFixed(1));
      ring.style.opacity = (1 - t).toFixed(3);
      if (t >= 1) { if (ring.parentNode) ring.parentNode.removeChild(ring); return; }
      requestAnimationFrame(grow);
    }
    requestAnimationFrame(grow);
  }

  function removeBeam(beamObj) {
    if (!beamObj || beamObj.done) return;
    beamObj.done = true;
    if (beamObj.raf) cancelAnimationFrame(beamObj.raf);
    if (beamObj.g && beamObj.g.parentNode) beamObj.g.parentNode.removeChild(beamObj.g);
    var i = ST.beams.indexOf(beamObj);
    if (i >= 0) ST.beams.splice(i, 1);
  }

  function activate(name) {
    var n = name && ST.nodes[name];
    if (n && n.group) n.group.classList.add("is-active");
  }
  function deactivate(name) {
    var n = name && ST.nodes[name];
    if (n && n.group) n.group.classList.remove("is-active");
  }

  /* ======================================================================
   * RESET — clear transient beams (used before replay)
   * ====================================================================*/
  function reset() {
    /* kill in-flight beams */
    ST.beams.slice().forEach(function (b) { removeBeam(b); });
    ST.beams = [];
    if (ST.beamLayer) clear(ST.beamLayer);
    /* drop active highlights */
    Object.keys(ST.nodes).forEach(function (k) {
      var n = ST.nodes[k];
      if (n.group) n.group.classList.remove("is-active");
    });
    /* clear any lingering impact rings already handled by clear() */
  }

  /* ======================================================================
   * LEGEND — Python/TS/Go shapes + roles
   * ====================================================================*/
  function buildLegend() {
    var host = document.getElementById("holotable-legend");
    if (!host) return;
    host.innerHTML = "";
    host.setAttribute("role", "list");
    host.setAttribute("aria-label", "Holotable agent legend");

    var rows = [
      { lang: "python", shape: "diamond", title: "PYTHON", role: "COMMAND / COORD" },
      { lang: "typescript", shape: "triangle", title: "TYPESCRIPT", role: "SIGNAL / INTEL" },
      { lang: "go", shape: "hexagon", title: "GO", role: "TACTICAL / EXEC" }
    ];
    rows.forEach(function (r) {
      var item = document.createElement("div");
      item.className = "ht-legend-item lang--" + r.lang;
      item.setAttribute("role", "listitem");

      var sw = document.createElementNS(SVG, "svg");
      sw.setAttribute("class", "ht-legend-shape ht-node--" + r.lang);
      sw.setAttribute("viewBox", "-12 -12 24 24");
      sw.setAttribute("width", "18");
      sw.setAttribute("height", "18");
      sw.setAttribute("aria-hidden", "true");
      sw.appendChild(legendShape(r.shape));
      item.appendChild(sw);

      var txt = document.createElement("span");
      txt.className = "ht-legend-text";
      var t1 = document.createElement("b");
      t1.className = "ht-legend-lang";
      t1.textContent = r.title;
      var t2 = document.createElement("span");
      t2.className = "ht-legend-role";
      t2.textContent = r.role;
      txt.appendChild(t1);
      txt.appendChild(t2);
      item.appendChild(txt);

      host.appendChild(item);
    });
  }
  function legendShape(shape) {
    var size = 8;
    if (shape === "diamond") {
      return mk("path", { "class": "ht-node-shape",
        d: "M 0 " + (-size) + " L " + size + " 0 L 0 " + size + " L " + (-size) + " 0 Z" });
    }
    if (shape === "triangle") {
      var h = size * 1.15;
      return mk("path", { "class": "ht-node-shape",
        d: "M 0 " + (-h) + " L " + size + " " + (h * 0.78) + " L " + (-size) + " " + (h * 0.78) + " Z" });
    }
    var pts = [];
    for (var k = 0; k < 6; k++) {
      var ang = Math.PI / 180 * (60 * k - 30);
      pts.push((size * Math.cos(ang)).toFixed(1) + " " + (size * Math.sin(ang)).toFixed(1));
    }
    return mk("path", { "class": "ht-node-shape", d: "M " + pts.join(" L ") + " Z" });
  }

  /* ======================================================================
   * reduced-motion live toggle: stop/start animation if the user flips it
   * ====================================================================*/
  try {
    if (window.matchMedia) {
      var mq = window.matchMedia("(prefers-reduced-motion: reduce)");
      var onMq = function () {
        if (!ST.mounted) return;
        startSweep();
        startPulse();
        if (reduced()) { reset(); }
      };
      if (mq.addEventListener) mq.addEventListener("change", onMq);
      else if (mq.addListener) mq.addListener(onMq);
    }
  } catch (e) { /* ignore */ }

  /* ======================================================================
   * public API
   * ====================================================================*/
  Echo.holotable = {
    mount: mount,
    render: render,
    beam: beam,
    setPhase: setPhase,
    setThreat: setThreat,
    reset: reset
  };

})();
