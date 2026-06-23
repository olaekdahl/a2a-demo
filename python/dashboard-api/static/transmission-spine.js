/* ============================================================================
 * Echo Command Interface — TRANSMISSION SPINE
 * window.Echo.spine
 *
 * Renders the live timeline as a vertical column of decoded military comm
 * PACKETS into #spine (an <ol>). Each packet is a stamped transmission with a
 * timestamp, sender→recipient route, skill/label, task state, summary text, a
 * correlation/id fragment, and a protocol marker.
 *
 * Pure vanilla JS. Uses Echo.util ($, el, esc, fmtTime) inside methods only.
 * Honors prefers-reduced-motion. No frameworks, no external assets.
 * ==========================================================================*/
(function () {
  "use strict";

  window.Echo = window.Echo || {};

  /* ---- local helpers (resolved lazily through Echo.util inside methods) ---- */
  function util() {
    return (window.Echo && window.Echo.util) || {};
  }
  function reducedMotion() {
    var u = util();
    if (typeof u.prefersReducedMotion === "function") {
      try {
        return !!u.prefersReducedMotion();
      } catch (e) {
        /* fall through */
      }
    }
    try {
      return (
        window.matchMedia &&
        window.matchMedia("(prefers-reduced-motion: reduce)").matches
      );
    } catch (e) {
      return false;
    }
  }
  function esc(s) {
    var u = util();
    if (typeof u.esc === "function") return u.esc(s);
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return {
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      }[c];
    });
  }
  function fmtTime(iso) {
    var u = util();
    if (typeof u.fmtTime === "function") {
      try {
        var v = u.fmtTime(iso);
        if (v) return v;
      } catch (e) {
        /* fall through */
      }
    }
    if (!iso) return "----.--.-- --:--:--";
    var d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso);
    function p(n) {
      return (n < 10 ? "0" : "") + n;
    }
    return (
      d.getUTCFullYear() +
      "-" +
      p(d.getUTCMonth() + 1) +
      "-" +
      p(d.getUTCDate()) +
      " " +
      p(d.getUTCHours()) +
      ":" +
      p(d.getUTCMinutes()) +
      ":" +
      p(d.getUTCSeconds())
    );
  }
  function $(id) {
    var u = util();
    if (typeof u.$ === "function") return u.$(id);
    return document.getElementById(id);
  }
  function shortName(name) {
    var u = util();
    if (typeof u.shortName === "function") {
      try {
        var v = u.shortName(name);
        if (v) return v;
      } catch (e) {
        /* fall through */
      }
    }
    if (!name) return "—";
    return String(name).replace(/-agent$/i, "").replace(/-/g, " ");
  }

  /* ---- module-private state -------------------------------------------- */
  var SPINE_ID = "spine";
  // map of transmission id -> rendered <li> node
  var nodes = Object.create(null);
  // ordered list of ids, in render order
  var order = [];
  var selectedId = null;

  function spineEl() {
    return $(SPINE_ID);
  }

  /* ---- state mapping ---------------------------------------------------- */
  // Resolve a transmission/status row into one of our canonical packet states.
  function stateOf(t) {
    if (!t) return "submitted";
    var mt = String(t.message_type || "").toLowerCase();
    var st = String(t.status || "").toLowerCase();

    // message_type takes precedence for structural kinds
    if (mt === "artifact") return "artifact";
    if (mt === "dead-letter" || mt === "dead_letter" || mt === "deadletter")
      return "dead-letter";

    // status drives task lifecycle
    if (st === "failed" || st === "error" || st === "errored") return "failed";
    if (st === "completed" || st === "complete" || st === "done" || st === "ok")
      return "completed";
    if (
      st === "working" ||
      st === "running" ||
      st === "in_progress" ||
      st === "in-progress" ||
      st === "active" ||
      st === "processing"
    )
      return "working";
    if (st === "submitted" || st === "queued" || st === "pending" || st === "")
      // fall back to message_type hints
      return submittedFallback(mt, st);

    // unknown status: lean on message_type
    return submittedFallback(mt, st);
  }
  function submittedFallback(mt, st) {
    if (mt === "completed") return "completed";
    if (mt === "failed") return "failed";
    if (mt === "working") return "working";
    return "submitted";
  }

  // Human/stamped label + glyph for each state (NEVER color-only).
  var STATE_META = {
    submitted: { label: "ENCODED", glyph: "▤", aria: "submitted" },
    working: { label: "DECODING", glyph: "▰", aria: "working" },
    completed: { label: "COMPLETE", glyph: "✔", aria: "completed" },
    failed: { label: "ALERT", glyph: "✖", aria: "failed" },
    artifact: { label: "DATA CARD", glyph: "◈", aria: "artifact data card" },
    "dead-letter": { label: "DEAD-LETTER", glyph: "⚠", aria: "dead letter" },
  };
  function meta(state) {
    return STATE_META[state] || STATE_META.submitted;
  }

  /* ---- protocol marker -------------------------------------------------- */
  function protoMarker() {
    var v = "1.0";
    try {
      var b = document.body;
      if (b && b.getAttribute("data-a2a-version")) {
        v = b.getAttribute("data-a2a-version");
      }
    } catch (e) {
      /* ignore */
    }
    return "A2A/" + v;
  }

  /* ---- correlation fragment -------------------------------------------- */
  function corrFragment(t) {
    var raw =
      (t && (t.correlation_id || t.context_id || t.task_id || t.id)) || "";
    raw = String(raw);
    if (!raw) return "————";
    // show a compact tail fragment, uppercased
    var frag = raw.length > 8 ? raw.slice(-8) : raw;
    return frag.toUpperCase();
  }

  /* ---- decode bars (for working packets) -------------------------------- */
  function buildDecodeBars(u) {
    var bars = u.el ? u.el("span", "packet__bars") : document.createElement("span");
    if (!u.el) bars.className = "packet__bars";
    bars.setAttribute("aria-hidden", "true");
    for (var i = 0; i < 6; i++) {
      var b = document.createElement("i");
      b.className = "packet__bar";
      b.style.setProperty("--bi", String(i));
      bars.appendChild(b);
    }
    return bars;
  }

  /* ---- artifact fold/data-card ----------------------------------------- */
  function buildArtifactCard(u, t) {
    var card = document.createElement("div");
    card.className = "packet__card";
    card.setAttribute("aria-hidden", "false");

    var head = document.createElement("div");
    head.className = "packet__card-head";
    head.textContent = "◈ DECODED DATA FRAGMENT";
    card.appendChild(head);

    var name = t && (t.label || t.skill || t.name);
    if (name) {
      var nm = document.createElement("div");
      nm.className = "packet__card-name";
      nm.textContent = String(name);
      card.appendChild(nm);
    }

    var body = document.createElement("div");
    body.className = "packet__card-body";
    var summary = (t && (t.summary || t.text)) || "Payload attached.";
    body.textContent = String(summary);
    card.appendChild(body);

    return card;
  }

  /* ---- build one packet <li> ------------------------------------------- */
  function buildPacket(t) {
    var u = util();
    var state = stateOf(t);
    var m = meta(state);

    var li = document.createElement("li");
    li.className = "packet packet--" + state;
    li.setAttribute("data-id", t && t.id != null ? String(t.id) : "");
    li.setAttribute("data-state", state);
    li.setAttribute("role", "listitem");
    li.setAttribute("tabindex", "0");
    // button-like semantics: it activates an inspector
    li.setAttribute(
      "aria-label",
      "Transmission " +
        (t && t.id != null ? "#" + t.id + " " : "") +
        m.aria +
        ". Press Enter to inspect."
    );

    /* --- header line: time + state stamp + protocol --- */
    var hd = document.createElement("div");
    hd.className = "packet__head";

    var time = document.createElement("span");
    time.className = "packet__time";
    time.textContent = fmtTime(t && t.created_at);
    hd.appendChild(time);

    var stateEl = document.createElement("span");
    stateEl.className = "packet__state";
    // text label + glyph, never color only
    var glyph = document.createElement("span");
    glyph.className = "packet__state-glyph";
    glyph.setAttribute("aria-hidden", "true");
    glyph.textContent = m.glyph;
    stateEl.appendChild(glyph);
    var stateText = document.createElement("span");
    stateText.className = "packet__state-text";
    stateText.textContent = m.label;
    stateEl.appendChild(stateText);
    hd.appendChild(stateEl);

    var proto = document.createElement("span");
    proto.className = "packet__proto";
    proto.textContent = protoMarker();
    hd.appendChild(proto);

    li.appendChild(hd);

    /* --- route: sender → recipient --- */
    var route = document.createElement("div");
    route.className = "packet__route";
    var sndr = document.createElement("span");
    sndr.className = "packet__from";
    sndr.textContent = shortName(t && t.sender);
    var arrow = document.createElement("span");
    arrow.className = "packet__arrow";
    arrow.setAttribute("aria-hidden", "true");
    arrow.textContent = "→";
    var rcpt = document.createElement("span");
    rcpt.className = "packet__to";
    rcpt.textContent = shortName(t && t.recipient);
    route.appendChild(sndr);
    route.appendChild(arrow);
    route.appendChild(rcpt);
    // screen-reader friendly direction word
    var srRoute = document.createElement("span");
    srRoute.className = "packet__sr";
    srRoute.textContent = " to ";
    route.insertBefore(srRoute, rcpt);
    li.appendChild(route);

    /* --- skill / label --- */
    var skillText = (t && (t.label || t.skill)) || "";
    if (skillText) {
      var skill = document.createElement("div");
      skill.className = "packet__skill";
      skill.textContent = String(skillText);
      li.appendChild(skill);
    }

    /* --- working decode bars --- */
    if (state === "working") {
      li.appendChild(buildDecodeBars(u));
    }

    /* --- transmission text / summary --- */
    var summary = (t && t.summary) || "";
    if (summary) {
      var txt = document.createElement("p");
      txt.className = "packet__text";
      txt.textContent = String(summary);
      li.appendChild(txt);
    }

    /* --- artifact data-card (folded; unfolds via CSS / .is-unfolded) --- */
    if (state === "artifact") {
      li.appendChild(buildArtifactCard(u, t));
    }

    /* --- footer: correlation fragment --- */
    var foot = document.createElement("div");
    foot.className = "packet__foot";
    var corr = document.createElement("span");
    corr.className = "packet__corr";
    corr.title = "correlation fragment";
    var corrTag = document.createElement("span");
    corrTag.className = "packet__corr-tag";
    corrTag.setAttribute("aria-hidden", "true");
    corrTag.textContent = "CORR";
    corr.appendChild(corrTag);
    var corrVal = document.createElement("span");
    corrVal.className = "packet__corr-val";
    corrVal.textContent = corrFragment(t);
    corr.appendChild(corrVal);
    foot.appendChild(corr);
    li.appendChild(foot);

    /* --- interaction wiring --- */
    wirePacket(li, t);

    return li;
  }

  /* ---- per-packet interaction wiring ----------------------------------- */
  function activate(t) {
    if (window.Echo && Echo.app && typeof Echo.app.selectTransmission === "function") {
      try {
        Echo.app.selectTransmission(t);
      } catch (e) {
        /* swallow — UI must not break */
      }
    }
  }

  function wirePacket(li, t) {
    li.addEventListener("click", function () {
      activate(t);
    });
    li.addEventListener("keydown", function (ev) {
      var key = ev.key;
      if (key === "Enter" || key === " " || key === "Spacebar") {
        ev.preventDefault();
        activate(t);
        return;
      }
      if (key === "ArrowDown" || key === "Down") {
        ev.preventDefault();
        focusSibling(li, 1);
        return;
      }
      if (key === "ArrowUp" || key === "Up") {
        ev.preventDefault();
        focusSibling(li, -1);
        return;
      }
      if (key === "Home") {
        ev.preventDefault();
        focusEdge(true);
        return;
      }
      if (key === "End") {
        ev.preventDefault();
        focusEdge(false);
      }
    });
  }

  function focusSibling(li, dir) {
    var list = spineEl();
    if (!list) return;
    var items = list.querySelectorAll(".packet");
    var idx = -1;
    for (var i = 0; i < items.length; i++) {
      if (items[i] === li) {
        idx = i;
        break;
      }
    }
    if (idx < 0) return;
    var next = items[idx + dir];
    if (next && typeof next.focus === "function") next.focus();
  }
  function focusEdge(first) {
    var list = spineEl();
    if (!list) return;
    var items = list.querySelectorAll(".packet");
    if (!items.length) return;
    var target = first ? items[0] : items[items.length - 1];
    if (target && typeof target.focus === "function") target.focus();
  }

  /* ---- count + empty placeholder management ---------------------------- */
  function updateCount() {
    var c = $("spine-count");
    if (c) c.textContent = String(order.length);
  }
  function removeEmpty() {
    var e = $("spine-empty");
    if (e && e.parentNode) {
      // keep the node out of the flow; the contract says "removes #spine-empty"
      e.setAttribute("hidden", "hidden");
      e.classList.add("is-hidden");
    }
  }
  function showEmptyIfNeeded() {
    if (order.length > 0) return;
    var e = $("spine-empty");
    if (e) {
      e.removeAttribute("hidden");
      e.classList.remove("is-hidden");
    }
  }

  /* ---- scroll newest into view ----------------------------------------- */
  function scrollToNewest(li) {
    var list = spineEl();
    if (!list || !li) return;
    // Spine grows downward (newest at bottom); keep newest visible.
    if (reducedMotion()) {
      list.scrollTop = list.scrollHeight;
      return;
    }
    try {
      list.scrollTo({ top: list.scrollHeight, behavior: "smooth" });
    } catch (e) {
      list.scrollTop = list.scrollHeight;
    }
  }

  /* ---- transient animation cleanup ------------------------------------- */
  function clearTransient(li, cls, delay) {
    if (reducedMotion()) {
      li.classList.remove(cls);
      return;
    }
    window.setTimeout(function () {
      if (li) li.classList.remove(cls);
    }, delay);
  }

  /* ====================================================================== *
   *  PUBLIC API — Echo.spine
   * ====================================================================== */
  var spine = {
    /* Rebuild #spine from a full list. */
    renderAll: function (transmissions) {
      var list = spineEl();
      if (!list) return;
      nodes = Object.create(null);
      order = [];
      // remove all packets (preserve #spine-empty if it lives inside)
      var existing = list.querySelectorAll(".packet");
      for (var i = 0; i < existing.length; i++) {
        if (existing[i].parentNode) existing[i].parentNode.removeChild(existing[i]);
      }
      var arr = Array.isArray(transmissions) ? transmissions : [];
      // contract: timeline is asc by id; render in that order so newest is last
      for (var j = 0; j < arr.length; j++) {
        var t = arr[j];
        if (!t) continue;
        var li = buildPacket(t);
        var id = t.id != null ? String(t.id) : "auto-" + j;
        nodes[id] = li;
        order.push(id);
        list.appendChild(li);
      }
      updateCount();
      if (order.length > 0) {
        removeEmpty();
      } else {
        showEmptyIfNeeded();
      }
      // restore selection highlight if still present
      if (selectedId != null && nodes[String(selectedId)]) {
        nodes[String(selectedId)].classList.add("is-selected");
      }
      // keep newest visible after a full rebuild
      if (order.length) {
        var lastNode = nodes[order[order.length - 1]];
        scrollToNewest(lastNode);
      }
    },

    /* Append one packet. */
    add: function (t, animate) {
      var list = spineEl();
      if (!list || !t) return null;

      var id = t.id != null ? String(t.id) : "auto-" + (order.length + 1);

      // de-dupe: if a packet with this id already exists, replace it in place
      if (nodes[id]) {
        var fresh = buildPacket(t);
        var old = nodes[id];
        if (old.classList.contains("is-selected")) {
          fresh.classList.add("is-selected");
        }
        if (old.parentNode) old.parentNode.replaceChild(fresh, old);
        nodes[id] = fresh;
        applyTransientStates(fresh, t, false);
        return fresh;
      }

      var li = buildPacket(t);
      nodes[id] = li;
      order.push(id);
      list.appendChild(li);

      updateCount();
      removeEmpty();

      var doAnim = !!animate && !reducedMotion();

      if (doAnim) {
        li.classList.add("packet--new");
        // force reflow so the slide-in transition runs from initial state
        // eslint-disable-next-line no-unused-expressions
        li.offsetWidth;
        // remove the entry class on next frame to trigger the transition
        window.requestAnimationFrame(function () {
          li.classList.add("packet--new-in");
        });
        clearTransient(li, "packet--new", 700);
        clearTransient(li, "packet--new-in", 700);
      }

      applyTransientStates(li, t, doAnim);

      // keep newest visible
      scrollToNewest(li);

      return li;
    },

    /* Toggle selection on a packet (called by app on inspector open). */
    select: function (id) {
      var list = spineEl();
      if (!list) return;
      var key = id != null ? String(id) : null;

      // clear any previous selection
      var prev = list.querySelectorAll(".packet.is-selected");
      for (var i = 0; i < prev.length; i++) {
        prev[i].classList.remove("is-selected");
        prev[i].removeAttribute("aria-current");
      }

      if (key == null) {
        selectedId = null;
        return;
      }

      var node = nodes[key];
      // if we already had this selected, calling again toggles it off
      if (selectedId === key && !node) {
        selectedId = null;
        return;
      }
      selectedId = key;
      if (node) {
        node.classList.add("is-selected");
        node.setAttribute("aria-current", "true");
      }
    },

    /* Empty the spine entirely. */
    clear: function () {
      var list = spineEl();
      nodes = Object.create(null);
      order = [];
      selectedId = null;
      if (list) {
        var existing = list.querySelectorAll(".packet");
        for (var i = 0; i < existing.length; i++) {
          if (existing[i].parentNode)
            existing[i].parentNode.removeChild(existing[i]);
        }
      }
      updateCount();
      showEmptyIfNeeded();
    },
  };

  /* ---- apply gentle pulse / warning flash / artifact unfold ------------- */
  function applyTransientStates(li, t, animatedEntry) {
    var state = stateOf(t);
    var rm = reducedMotion();

    // working → gentle pulse while active
    if (state === "working") {
      if (!rm) {
        li.classList.add("packet--active");
      }
    } else {
      li.classList.remove("packet--active");
    }

    // failed / dead-letter → warning flash
    if (state === "failed" || state === "dead-letter") {
      if (!rm) {
        li.classList.add("packet--flash");
        clearTransient(li, "packet--flash", 1400);
      }
    }

    // artifact → unfold the data-card
    if (state === "artifact") {
      if (rm) {
        li.classList.add("is-unfolded");
      } else {
        window.requestAnimationFrame(function () {
          li.classList.add("is-unfolded");
        });
      }
    }
  }

  window.Echo.spine = spine;
})();
