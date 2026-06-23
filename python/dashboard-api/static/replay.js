/* ============================================================================
 * Echo Command Interface — REPLAY module  (window.Echo.replay)
 * ----------------------------------------------------------------------------
 * Replays the PERSISTED transmission timeline (GET /api/replay). This NEVER
 * re-runs the backend mission — it is a deterministic playback of what already
 * happened, driving the transmission spine, the holotable beams/route/threat,
 * the troop track and the #replay-fill progress bar.
 *
 * Contract: UI BUILD CONTRACT §4 (window.Echo.replay), §6 (data shapes),
 *           §7 (interactions / reduced-motion).
 *
 * Every cross-module call is guarded (typeof / optional chaining) so a missing
 * or not-yet-loaded module never throws. Echo.util is used inside methods only.
 * ==========================================================================*/
(function () {
  "use strict";

  window.Echo = window.Echo || {};
  var Echo = window.Echo;

  /* ---- internal playback state (not exposed except via .active) ---------- */
  var timer = null;        // setTimeout handle for the step loop
  var running = false;     // local guard mirroring Echo.replay.active
  var seq = 0;             // monotonic token: bumped on stop() to cancel async ticks

  /* ---- fleet / route phase order (contract §6) --------------------------- */
  var FLEET_PHASES = [
    "submitted",
    "calculating_hyperspace_route",
    "loading_transports",
    "jump_to_lightspeed",
    "arriving_hoth_orbit",
    "deployed",
    "completed"
  ];

  /* Agent names that represent fleet/troop movement progress. A transmission
   * touching the fleet agent (or carrying a fleet phase) advances the track. */
  var FLEET_AGENTS = { "fleet-agent": true, "logistics-agent": true };

  /* ----------------------------------------------------------------------- */
  /* small local helpers — never assume Echo.util exists at file-eval time    */
  /* ----------------------------------------------------------------------- */
  function util() {
    return (Echo && Echo.util) ? Echo.util : null;
  }

  function reducedMotion() {
    var u = util();
    if (u && typeof u.prefersReducedMotion === "function") {
      try { return !!u.prefersReducedMotion(); } catch (e) { /* fall through */ }
    }
    // Fallback if util not available yet.
    try {
      return !!(window.matchMedia &&
        window.matchMedia("(prefers-reduced-motion: reduce)").matches);
    } catch (e) {
      return false;
    }
  }

  function byId(id) {
    var u = util();
    if (u && typeof u.$ === "function") {
      try {
        var n = u.$(id);
        if (n) return n;
      } catch (e) { /* fall through */ }
    }
    return document.getElementById(id);
  }

  function getReplayData() {
    var u = util();
    if (u && typeof u.getJSON === "function") {
      return u.getJSON("/api/replay");
    }
    // Defensive fallback — should not normally be hit.
    return fetch("/api/replay", { headers: { "Accept": "application/json" } })
      .then(function (r) {
        if (!r.ok) {
          return r.text().then(function (b) {
            var err = new Error("HTTP " + r.status);
            err.status = r.status; err.body = b;
            throw err;
          });
        }
        return r.json();
      });
  }

  function toast(msg, isError) {
    if (Echo && Echo.app && typeof Echo.app.toast === "function") {
      try { Echo.app.toast(msg, !!isError); return; } catch (e) { /* fall */ }
    }
    // Minimal inline toast fallback so failures are never silent.
    var host = byId("toast");
    if (!host) {
      host = document.createElement("div");
      host.id = "toast";
      document.body.appendChild(host);
    }
    host.textContent = msg;
    host.classList.add("show");
    if (isError) host.classList.add("toast--error");
    window.setTimeout(function () {
      host.classList.remove("show");
      host.classList.remove("toast--error");
    }, 2600);
  }

  /* ---- derive a fleet phase from a transmission row ---------------------- */
  function phaseOf(ev) {
    if (!ev) return null;
    var candidates = [ev.phase, ev.fleet_phase, ev.status, ev.label, ev.summary];
    for (var i = 0; i < candidates.length; i++) {
      var c = candidates[i];
      if (typeof c !== "string") continue;
      var lc = c.toLowerCase();
      for (var p = 0; p < FLEET_PHASES.length; p++) {
        if (lc.indexOf(FLEET_PHASES[p]) !== -1) return FLEET_PHASES[p];
      }
    }
    return null;
  }

  function isFleetEvent(ev) {
    if (!ev) return false;
    if (FLEET_AGENTS[ev.sender] || FLEET_AGENTS[ev.recipient]) return true;
    var mt = (ev.message_type || "").toLowerCase();
    if (mt === "stream" || mt === "status") return true;
    return false;
  }

  /* ---- guarded module dispatch helpers ----------------------------------- */
  function spineClear() {
    if (Echo.spine && typeof Echo.spine.clear === "function") {
      try { Echo.spine.clear(); } catch (e) { /* swallow */ }
    }
  }

  function spineAdd(ev) {
    if (Echo.spine && typeof Echo.spine.add === "function") {
      try { Echo.spine.add(ev, true); } catch (e) { /* swallow */ }
    }
  }

  function holoReset() {
    if (Echo.holotable && typeof Echo.holotable.reset === "function") {
      try { Echo.holotable.reset(); } catch (e) { /* swallow */ }
    }
  }

  function holoBeam(ev) {
    if (!ev) return;
    if (Echo.holotable && typeof Echo.holotable.beam === "function") {
      try {
        Echo.holotable.beam(ev.sender, ev.recipient, { kind: ev.message_type });
      } catch (e) { /* swallow */ }
    }
  }

  function holoSetPhase(phase) {
    if (!phase) return;
    if (Echo.holotable && typeof Echo.holotable.setPhase === "function") {
      try { Echo.holotable.setPhase(phase); } catch (e) { /* swallow */ }
    }
  }

  /* Advance the troop / fleet track UI. Prefer a dedicated app/troop hook if
   * present; otherwise update the visible fleet-track pips + phase tag inline so
   * replay still shows tactile progress without a live troop module. */
  function advanceTroop(phase) {
    if (!phase) return;

    // Preferred: a module hook that owns the troop track.
    if (Echo.app && typeof Echo.app.setTroopPhase === "function") {
      try { Echo.app.setTroopPhase(phase); return; } catch (e) { /* fall */ }
    }
    if (Echo.troop && typeof Echo.troop.setPhase === "function") {
      try { Echo.troop.setPhase(phase); return; } catch (e) { /* fall */ }
    }

    // Inline fallback: light up #fleet-track pips up to the current phase.
    var idx = FLEET_PHASES.indexOf(phase);
    if (idx < 0) return;

    var track = byId("fleet-track");
    if (track) {
      var pips = track.querySelectorAll(".pip");
      for (var i = 0; i < pips.length; i++) {
        pips[i].classList.remove("pip--done", "pip--active");
        if (i < idx) pips[i].classList.add("pip--done");
        else if (i === idx) pips[i].classList.add("pip--active");
      }
    }
    var tag = byId("fleet-phase-tag");
    if (tag) tag.textContent = phase.replace(/_/g, " ").toUpperCase();
  }

  function setFill(pct) {
    var fill = byId("replay-fill");
    if (!fill) return;
    var v = Math.max(0, Math.min(100, pct));
    fill.style.width = v + "%";
    fill.setAttribute("aria-valuenow", String(Math.round(v)));
  }

  /* Show the mission-complete stamp (contract §7 — REINFORCEMENTS DEPLOYED). */
  function showMissionComplete() {
    // Drive route to its terminal state if the holotable exposes it.
    holoSetPhase("completed");
    advanceTroop("completed");

    // Narrative: reinforcements deployed → the imperial threat is repelled.
    if (Echo.app && typeof Echo.app.containThreat === "function") {
      try { Echo.app.containThreat(); } catch (e) { /* swallow */ }
    }

    var stamp = byId("mission-stamp");
    if (stamp) {
      stamp.classList.add("show");
      stamp.hidden = false;
      if (!stamp.textContent || !stamp.textContent.trim()) {
        stamp.textContent = "REINFORCEMENTS DEPLOYED";
      }
    }
  }

  function hideMissionComplete() {
    var stamp = byId("mission-stamp");
    if (stamp) {
      stamp.classList.remove("show");
      // Leave text intact; hidden controls visibility.
      stamp.hidden = true;
    }
  }

  /* ----------------------------------------------------------------------- */
  /* PUBLIC API                                                               */
  /* ----------------------------------------------------------------------- */
  Echo.replay = {
    active: false,

    start: function start() {
      // Guard: ignore if a replay is already in progress.
      if (running || Echo.replay.active) return;

      getReplayData().then(function (data) {
        var events = (data && data.transmissions) ? data.transmissions.slice() : [];
        if (!events.length) {
          toast("No stored timeline to replay.");
          return;
        }

        // ---- enter replay mode (state + controls) ----
        running = true;
        Echo.replay.active = true;
        var token = ++seq; // capture for this run
        if (Echo.state) Echo.state.replaying = true;

        var btnReplay = byId("btn-replay");
        var btnStop = byId("btn-replay-stop");
        if (btnStop) btnStop.hidden = false;
        if (btnReplay) btnReplay.disabled = true;

        // ---- reset views for a clean playback ----
        spineClear();
        holoReset();
        hideMissionComplete();
        setFill(0);
        // Narrative: start nominal — the imperial sector + red alert reveal when
        // the tactical hop replays below.
        if (Echo.app && typeof Echo.app.resetNarrative === "function") {
          try { Echo.app.resetNarrative(); } catch (e) { /* swallow */ }
        }

        var instant = reducedMotion();
        var stepMs = instant ? 0 : 550;
        var total = events.length;
        var i = 0;

        var step = function step() {
          // Cancellation / completion guards.
          if (!running || token !== seq) return;
          if (i >= total) {
            // Final mission-complete state, then stop.
            showMissionComplete();
            setFill(100);
            if (token === seq) Echo.replay.stop();
            return;
          }

          var ev = events[i];

          // 1) Transmission spine packet (animated).
          spineAdd(ev);

          // 2) Holotable beam between sender + recipient.
          holoBeam(ev);

          // 2b) Narrative: the tactical hop is the "⚠ Imperial contact" beat.
          if (ev && (ev.sender === "tactical-agent" || ev.recipient === "tactical-agent") &&
              Echo.app && typeof Echo.app.escalateThreat === "function") {
            try { Echo.app.escalateThreat(); } catch (e) { /* swallow */ }
          }

          // 3) Fleet/route progress when the event implies it.
          if (isFleetEvent(ev)) {
            var phase = phaseOf(ev);
            if (phase) {
              holoSetPhase(phase);
              advanceTroop(phase);
            }
          }

          // 4) Progress bar.
          setFill(Math.round(((i + 1) / total) * 100));

          i++;

          if (instant) {
            // Reduced-motion: play through without timers (microtask flush).
            step();
          } else {
            timer = window.setTimeout(step, stepMs);
          }
        };

        if (instant) {
          // Render the whole persisted timeline at once, then complete.
          step();
        } else {
          // Kick off the paced loop.
          timer = window.setTimeout(step, stepMs);
        }
      }).catch(function (err) {
        var msg = (err && err.message) ? err.message : "request failed";
        toast("Replay unavailable: " + msg, true);
        // Make sure we never get stuck in a half-entered replay state.
        if (running || Echo.replay.active) Echo.replay.stop();
      });
    },

    stop: function stop() {
      // Invalidate any in-flight ticks.
      seq++;
      running = false;
      Echo.replay.active = false;
      if (Echo.state) Echo.state.replaying = false;

      if (timer) {
        window.clearTimeout(timer);
        timer = null;
      }

      // Restore controls.
      var btnReplay = byId("btn-replay");
      var btnStop = byId("btn-replay-stop");
      if (btnStop) btnStop.hidden = true;
      if (btnReplay) btnReplay.disabled = false;

      // Reset the progress bar (instant under reduced-motion; brief settle else).
      if (reducedMotion()) {
        setFill(0);
      } else {
        window.setTimeout(function () {
          // Only reset if we're not mid-replay again.
          if (!Echo.replay.active) setFill(0);
        }, 700);
      }

      // ---- restore the LIVE view ----
      // Prefer a dedicated app reloader if present; otherwise re-fetch the live
      // timeline and rebuild the spine via Echo.spine.renderAll.
      if (Echo.app && typeof Echo.app.reloadLive === "function") {
        try { Echo.app.reloadLive(); return; } catch (e) { /* fall through */ }
      }

      // Fallback: re-fetch /api/timeline and rebuild the spine directly.
      var u = util();
      if (u && typeof u.getJSON === "function" &&
          Echo.spine && typeof Echo.spine.renderAll === "function") {
        u.getJSON("/api/timeline").then(function (data) {
          var tx = (data && data.transmissions) ? data.transmissions : [];
          try { Echo.spine.renderAll(tx); } catch (e) { /* swallow */ }
          if (Echo.state) Echo.state.transmissions = tx;
        }).catch(function () { /* leave spine as-is on failure */ });
      }
    }
  };
})();
