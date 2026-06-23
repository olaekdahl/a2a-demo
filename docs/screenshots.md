# Screenshots — Echo Command Interface

The dashboard is the **Echo Command Interface** (ECI): a cinematic Resistance
war-room console rendered entirely with custom CSS + SVG/Canvas + vanilla JS (no
frameworks, no external fonts/images, fully offline). See
[`docs/ui-design-system.md`](./ui-design-system.md) for the full design language.

Open it at **http://localhost:8080** after `docker compose up --build` (the
mission auto-runs, so the console fills with live data within a few seconds).

---

## How to capture screenshots

### Method 1 — Browser built-in (most reliable)
1. `docker compose up --build`, wait for the mission to complete.
2. Open `http://localhost:8080` in Chrome/Edge/Firefox (1440px+ for the intended layout).
3. Capture:
   - Chrome/Edge: `F12` → `Ctrl/Cmd+Shift+P` → "Capture full size screenshot".
   - Firefox: right-click → "Take Screenshot" → "Save full page".

### Method 2 — Static snapshot mode (for headless renderers)
The console keeps a live **SSE** link open and runs a radar-sweep animation, which
prevents some headless tools from ever reaching "network idle". Append
**`?static=1`** to load data once, skip the SSE link, and report reduced-motion
(stops the sweep) so a renderer can settle:

```
http://localhost:8080/?static=1
```

A headless Chromium reaches it reliably on the compose network by service name
(host `--network host` does not work under Docker Desktop/WSL2):

```bash
docker run --rm --network starwars-a2a_resistance -v "$PWD/docs/img":/out \
  <a-headless-chromium-image> --no-sandbox --headless --disable-gpu \
  --window-size=1600,1000 --screenshot=/out/eci-desktop.png \
  "http://dashboard-api:8080/?static=1"
```

> Note: headless PNG capture can be flaky in Docker-Desktop/WSL2 (host networking,
> virtual-time, and software-GL quirks). Method 1 is recommended for crisp captures.

Suggested viewports: desktop `1600×1000` (or `1440×900`), tablet `834×1180`.

---

## What each capture should show (the five zones + modules)

Place captures under `docs/img/`. Filenames are conventions.

### 1 — Full console (`docs/img/eci-desktop.png`)
The whole war room: the **Command Header** strip up top (OPERATION ECHO SHIELD,
THEATER: HOTH, status/phase/threat, live UTC clock, `A2A/1.0`, FULCRUM uplink, the
connection lamp), the **Central Holotable** dominating the middle, the
**Transmission Spine** of comm packets, and the **Right-Side Operations Stack**.
When the mission is complete the header carries the `REINFORCEMENTS DEPLOYED`
mission stamp and the final summary.

### 2 — Central Holotable (`docs/img/eci-holotable.png`)
The command-table radar scope: concentric range rings + radial bearings + a
rotating sweep, the Hoth disc with topographic contours and a pulsing **Echo Base**
marker, the **Imperial threat sector** (hatched arc sized by `risk_score`, red at
HIGH), the **fleet reinforcement route** (Rendezvous → Hyperspace → Hoth Orbit →
Echo Base), and the **agent nodes** with language-specific shapes — Python =
diamond (command/coordination), TypeScript = triangle (signal/intel), Go = hexagon
(tactical/execution) — plus the legend. Live A2A messages animate as arcs between
nodes.

### 3 — Transmission Spine (`docs/img/eci-spine.png`)
Decoded military comm packets, each stamped with timestamp, sender → recipient,
skill/label, task state, transmission text, a correlation-id fragment and the
`A2A/1.0` marker. State treatments: submitted (dim), working (decode bars),
completed (stamped), failed/dead-letter (warning flash), artifact (folded data
card). Click/Enter a packet to open the Data Pad.

### 4 — Decoded Data Pad (`docs/img/eci-datapad.png`)
The Message Inspector: route, correlation id, trace id and **A2A-Version** shown up
top, tabs **Summary / Headers / Message / Task / Artifacts / Raw JSON**, a
line-numbered collapsible JSON viewer, and a copy button. Capture the Headers tab
to show `A2A-Version: 1.0`, `X-Correlation-ID`, `X-Trace-ID`, `X-Demo-Token`.

### 5 — Operations Stack (`docs/img/eci-ops.png`)
The console-insert modules: **Agent Roster** (language badge, health lamp, skill
count, Agent-Card link), **Troop Movement** (transports / ground troops / X-wing
squadrons / medical / ETA + a hyperspace-style phase track), **Threat Assessment**
(threat level, `risk_score` 91 / HIGH, Imperial unit counts, recommendation,
priority targets — colored by risk band, the in-console risk "heatmap"),
**Logistics** (fuel meter 82%, transport/evacuation capacity), **Dead-Letter
Queue** (nominal, or red rows when `FAILURE_SIMULATION=true`), and the **Audit
Log**.

### 6 — Red-alert + replay (optional)
With threat HIGH the header enters red-alert mode and the threat sector pulses.
Press **REPLAY** to replay the persisted timeline (no backend re-run): beams,
packets and the troop track animate back through the mission.

---

## Recommended order for a demo
1. Full console (mission complete) → 2. Holotable (language shapes + beams) →
3. Spine packet → 4. Data Pad Headers/Raw (the wire protocol) →
5. Threat + Troop modules (agent chaining + artifact consumption) →
6. Replay (persisted-event playback).
