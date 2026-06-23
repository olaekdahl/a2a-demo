# Echo Command Interface — UI Design System

The **Echo Command Interface** is the war-room dashboard for the *Operation Echo
Shield* Agent2Agent (A2A) demo. It dramatizes a Star-Wars-Resistance multi-agent
mission as a **cinematic tactical console**: a command-bunker terminal wired into
the (fictional) *Fulcrum* secure channel, watching coordinated AI agents plan and
execute a reinforcement of Echo Base on Hoth.

It is built with **custom CSS + vanilla JS + SVG/Canvas only** — no frameworks, no
Tailwind/Bootstrap/UI kit, no CDN, no external fonts or images. It is served
statically (no build step) by the FastAPI `dashboard-api` and works fully offline.
It uses only original "galactic resistance" motifs — no official Lucasfilm/Disney
assets.

> Source files:
> - `python/dashboard-api/app/templates/index.html` — Jinja template, full DOM
> - `python/dashboard-api/static/echo-command.css` — the design system (this doc)
> - `python/dashboard-api/static/{holotable,transmission-spine,data-pad,replay,app}.js`
>   — behavior modules (the `window.Echo` API), authored separately

---

## 1. Design concept

Not a SaaS card grid. Not neon cyberpunk. Not glassmorphism. The reference image is
a **gritty field-radio / command-bunker / holographic-tactical** console:

- **Physical console panels**, not floating cards — clipped (notched) corners,
  hairline edges, corner brackets, rivet dots, stamped label bars.
- **Signal-based**: live SSE traffic is shown as *transmissions* and *beams*, not
  rows in a table. Status is conveyed with lamps, meters, stamps and reticles.
- **Cold, muted, desaturated palette** — deep charcoal, bunker black, Hoth ice
  blue, radar cyan. Color is used sparingly as *signal*, never decoration.
- **Restraint**: subtle scanlines + a faint map grid, **no heavy blur, no big
  glows, no neon saturation, no rounded cards.** Cinematic but legible.

Hierarchy is built from **size, casing, letter-spacing, hairline rules and stamped
labels** — not font weight alone. Data is monospace; labels are letter-spaced
uppercase sans.

---

## 2. Layout — the five zones

`#command-header` spans the top; `#console` is a 3-column CSS grid; `#data-pad`
slides in from the right as an overlay.

```
┌──────────────────────────── ZONE 1 · COMMAND HEADER ───────────────────────────┐
│ brand + CLASSIFIED stamp · uplink · conn lamp · DISPATCH / REPLAY · readout strip │
├───────────────┬───────────────────────────────┬──────────────────────────────────┤
│  ZONE 3       │        ZONE 2                  │   ZONE 5 · OPS STACK             │
│  TRANSMISSION │     TACTICAL HOLOTABLE         │   roster · troop · threat ·      │
│  SPINE        │     (centerpiece SVG)          │   logistics · dead-letter ·      │
│  (comm packet │     nodes + beams + threat     │   audit                          │
│   feed)       │     sector + fleet route       │                                  │
└───────────────┴───────────────────────────────┴──────────────────────────────────┘
                          ZONE 4 · DECODED DATA PAD  (right-side overlay, .open)
```

| Zone | Element | Role |
|------|---------|------|
| **1 — Command Header** | `header#command-header` | Mission status, theater, phase, threat, context, A2A protocol, live UTC clock, uplink indicator, connection lamp, and the `DISPATCH MISSION` / `REPLAY` / `STOP` controls + replay progress. Gains `.red-alert` on HIGH threat. |
| **2 — Tactical Holotable** | `section#holotable-zone` | The centerpiece. `svg#holotable` (720×720) draws the agent comm graph (language-shaped nodes), animated beams for live A2A traffic, the growing/pulsing threat sector, and the Hoth fleet route. `canvas#holotable-fx` layers radar/noise. `#mission-stamp` reveals "REINFORCEMENTS DEPLOYED" on completion. |
| **3 — Transmission Spine** | `section#spine-zone` | The live timeline as a vertical "spine" of comm packets (`ol#spine`). Each packet is keyboard-focusable and opens the data pad. |
| **4 — Decoded Data Pad** | `aside#data-pad` | The message inspector. Slides in (`.open`) to decode a selected transmission: route/corr/trace/version metadata + tabs (Summary / Headers / Message / Task / Artifacts / Raw) with a line-numbered JSON viewer. Full-screen on mobile. |
| **5 — Ops Stack** | `aside#ops-stack` | Vertical stack of console-insert modules: Agent Roster, Troop Movement, Threat Assessment (risk heatmap), Logistics, Dead-Letter Queue, Audit Log. |

**Responsive (`≤1100px`)**: the grid collapses to one column — **holotable first /
full-width**, ops-stack below, the spine becomes a scrollable feed at the bottom,
and the data-pad opens as a **full-screen overlay**. `clamp()` scales header padding
and type. At `≤640px` readouts wrap, the stamp/uplink label hide, and the grids
collapse to single column.

---

## 3. Color system (CSS custom properties)

All colors are defined once on `:root` in `echo-command.css`. Muted, cold,
battlefield — never pure black, pure white, or neon.

| Variable | Hex | Use |
|----------|-----|-----|
| `--bg-void` | `#070a0e` | App background (deep space charcoal) |
| `--bg-bunker` | `#0d1218` | Behind panels |
| `--panel` | `#121922` | Console panel face |
| `--panel-2` | `#0f151d` | Inset / recessed surfaces |
| `--panel-edge` | `#243240` | Borders / cut edges |
| `--grid` | `rgba(120,170,200,.10)` | Map grid / underlays |
| `--scan` | `rgba(150,200,225,.045)` | Scanline overlay |
| `--ink` | `#c6d3df` | Primary text (aged off-white) |
| `--ink-dim` | `#7a8a99` | Secondary text |
| `--ink-faint` | `#4a5a68` | Faint labels / ticks |
| `--ice` | `#8fc2e0` | Signal / intelligence accent (Hoth ice) |
| `--radar` | `#4fd6e6` | Radar cyan — sweeps, live beams, focus |
| `--amber` | `#e0a838` | Working / caution |
| `--alert` | `#e0543a` | Failed / high threat / dead-letter |
| `--rebel` | `#d6803a` | Command accent / primary button |
| `--green` | `#79b39a` | Nominal / completed (dim gray-green) |
| `--ok` | `#5fbf86` | Success confirmation |

**Language identity** (holotable shapes + roster badges):
`--lang-python: var(--rebel)` (command/coordination), `--lang-typescript:
var(--ice)` (signal/intelligence), `--lang-go: var(--green)` (tactical/execution).

**Structure tokens**: `--line-thin/--line-mid`, `--radius: 2px` (corners are
*clipped*, not rounded), `--gap`/`--pad: 14px`, motion `--t-fast/med/slow`, and the
mono/sans font stacks. `*-rgb` channel vars (`--radar-rgb`, `--amber-rgb`,
`--alert-rgb`, `--ice-rgb`) exist for alpha mixing in gradients/shadows.

**Rule: color is never the only signal.** Every state also carries a text label
and/or glyph (e.g. packets show `WORKING`/`FAILED` text, threat shows
`LOW/MOD/HIGH`, the connection lamp pairs with `LIVE/STANDBY/LINK ERROR`).

---

## 4. Typography

- **Data / readouts** → `--font-mono` (`ui-monospace, "SF Mono", "Cascadia Mono",
  …`). Timestamps, ids, JSON, numeric stats, packet routes.
- **Labels / headings** → `--font-sans` (`ui-sans-serif, system-ui, …`), **UPPERCASE
  with wide letter-spacing** (`0.16em–0.28em`). Section titles, panel labels, button
  text, micro-labels.

`.micro-label` (`9.5px`, `0.22em`, faint) is the standard caption above value
groups. The clock, beams and live ids lean on the mono stack so columns align.

---

## 5. Panel & visual primitives

These primitives are defined in `§2` of the CSS and reused across every module.

| Primitive | What it is |
|-----------|------------|
| `.panel` | The console insert. `--panel` face, 1px `--panel-edge` border, **clipped corners via `clip-path`** (top-left + bottom-right notch). Composed of `.panel__brackets` (corner ticks), `.panel__rivets` (dots), `.panel__label`, `.panel__body`. |
| `.panel__label` | Stamped uppercase mono label bar with a leading tick glyph (`▸`/`◆`/`▲`), a hairline accent rule, and an optional right-aligned `.badge` or `.panel__label-meta`. |
| `.panel__body` | Recessed, scrollable content area (custom thin scrollbars). |
| `.stamp` | Stenciled, slightly-rotated, outlined mission label ("CLASSIFIED", "REINFORCEMENTS DEPLOYED") with a hatched fill and `screen` blend. |
| `.scanlines` | Fixed full-screen overlay: a faint repeating-linear-gradient of scanlines + a slow vertical light sweep (`ec-sweep`). `pointer-events:none`. |
| `.warn-strip` | Diagonal amber/charcoal hazard stripes for alert contexts. |
| `.meter` / `.meter__fill` | **Segmented** horizontal meter (fuel/signal). Tick guides are masked into the fill; band color via `.meter--ok/--warn/--low`. |
| `.reticle` | Targeting brackets (two L-shaped corners) for active elements. |
| `.badge` | Small stamped mono metadata chip (counts, tags, status). |

Body also carries a faint global **map-grid** underlay (`body::before`, masked to
fade downward) for the "tactical overlay" feel without distracting from content.

---

## 6. Component patterns (shared CSS vocabulary)

These class names are **normative** — the JS modules toggle them; the CSS defines
them.

**Connection lamp** — `.conn-lamp.conn--idle | --live | --error` on `#ch-conn-dot`
(paired with `#ch-conn` text).

**Comm packet** (`#spine`) — `.packet` base + state modifier
`.packet--submitted | --working | --completed | --failed | --artifact |
--dead-letter` (colored left rail + node tick + `.packet__state` label). Transient:
`.packet--new` (slide-in), `.packet--active` (gentle pulse), `.packet--flash`
(warning flash), `.is-selected` (cyan reticle highlight). Parts: `.packet__time`,
`.packet__route`, `.packet__skill`, `.packet__state`, `.packet__text`,
`.packet__corr`, `.packet__proto`. Artifact packets get a "data fragment" hatch;
dead-letters get a hazard hatch.

**Holotable nodes** — `.ht-node` + language shape:
`.ht-node--python` (diamond), `--typescript` (triangle), `--go` (hexagon),
`--command` (larger center, with reticle). `.ht-node.is-active` highlights with a
drop-shadow + reticle pop. **Beams**: `.ht-beam` (`--artifact`, `--dead-letter`)
animate a dashed arc + travelling `.ht-pulse`, then fade. **Threat sector**:
`.ht-threat.threat--low|--mod|--high|--unknown` (HIGH pulses). **Route**:
`.ht-route`, `.ht-stop.is-done|.is-active`.

**Roster** — `.roster-row` (`--python/--typescript/--go` left rail), health dot
`.health--healthy|--unknown|--down` + text, `.lang-badge.lang--python|…`, and
`.roster-card-link` (opens the raw agent card in a new tab).

**Fleet pips** — `.pip.pip--done|.pip--active` segments of `#fleet-track`.

**Threat band / meter band** — `.threat--*` and `.meter--*` carry both color and a
text label so meaning survives color-blindness / grayscale.

**Mission stamp** — `#mission-stamp.show` reveals the `.stamp` over the holotable.

**Data pad** — `#data-pad.open`; tabs `.dp-tab.active`; the JSON viewer
`.json-viewer > .json-line > (.json-num + .json-code)` with collapsible
`.json-collapsible.collapsed` sections and token classes (`.jk/.js/.jn/.jb/.jp`).

**Dead-letter** — `.deadletter-row` (hazard hatch) / `.deadletter-nominal`;
`#deadletter-tag.alert` flashes when the queue is non-empty.

---

## 7. Animation principles

Motion is **diegetic and subtle** — it should read as a live signal feed, not
decoration. All signature motion is gated behind `prefers-reduced-motion`.

| Keyframe | Used for |
|----------|----------|
| `ec-radar-sweep` | Rotating radar sweep on the holotable. |
| `ec-sweep` | Slow vertical scanline light sweep. |
| `ec-beam-dash` + `ec-beam-fade` | Travelling dash + fade of A2A beams. |
| `ec-slide-in` | New comm packet entering the spine (`.packet--new`). |
| `ec-pulse` | Gentle pulse on active packets / pips / route stop. |
| `ec-flash` | Warning flash for failed / dead-letter events. |
| `ec-decode-bars` | Working-state decode bars (the `.decode-bars` glyph). |
| `ec-uplink-blink` | Blinking encrypted uplink + live connection lamp. |
| `ec-redalert` | Red-alert inner glow on the header at HIGH threat. |
| `ec-threat-pulse` | Pulsing HIGH threat sector / gauge. |
| `ec-reticle-pop` | Reticle appearing on an activated node. |
| `ec-boot-flicker` / `ec-boot-prog` | CRT boot flicker + boot progress. |

Transitions use `--t-fast/med/slow`. No element uses heavy `blur()`; glows are kept
to thin `drop-shadow`/`box-shadow` rings only.

**Boot sequence**: `#boot-overlay` appends short status lines ~250ms apart
(`INITIALIZING…` → `LINK STABLE.`) then auto-dismisses (`.is-done`). **Data loads in
parallel during boot** — fetching is never blocked behind the animation. It is
skippable (click `#boot-skip`, `Esc`, or `Enter`) and shows instantly under
reduced-motion.

---

## 8. Accessibility

- **Focus**: every interactive element has a strong `:focus-visible` ring (2px
  `--radar`, offset, + a soft halo). Focus rings are never removed.
- **Keyboard**: spine packets are `tabindex=0` — `Enter`/`Space` open the inspector,
  `Up`/`Down` move focus. Data-pad tabs are buttons (Tab/arrow navigable). `Esc`
  closes the data pad and skips boot.
- **ARIA**: all icon buttons are labelled (`#btn-run`, `#dp-close`, `#dp-copy`,
  `#boot-skip`, roster card links). Live regions use `aria-live="polite"` on
  `#command-header`, `#spine`, the boot `#boot-log`, and `#toast`. Decorative SVG/FX
  layers are `aria-hidden`; the holotable SVG has an `aria-label`.
- **Reduced motion**: `@media (prefers-reduced-motion: reduce)` disables sweeps,
  beam travel, pulses, slide-ins, blinks, the red-alert pulse and boot flicker
  (animations set to none / instant; progress shown at 100%).
- **Color independence**: no information is conveyed by color alone — states always
  pair a hue with a text label and/or glyph.
- **Color-scheme**: declared `dark`; the palette holds adequate contrast for primary
  text (`--ink` on `--panel`) and all state colors carry text backup.

---

## 9. Feature map

All ten demo features (plus threat/logistics/dead-letter) live in this layout:

| # | Feature | Home |
|---|---------|------|
| 1 | Mission Status | Command header + `#mission-stamp` + `final_summary` |
| 2 | Agent Directory | `#mod-roster` |
| 3 | Live Timeline | `#spine` (transmission spine) |
| 4 | Message Inspector | `#data-pad` |
| 5 | Troop Movement | `#mod-troop` + holotable route |
| 6 | Comm Graph | `#holotable` (nodes + beams + legend) |
| 7 | Replay | `Echo.replay` + `#btn-replay` + `#replay-fill` |
| 8 | Audit Log | `#mod-audit` |
| 9 | Raw JSON | `#data-pad` "raw" tab (line-numbered) |
| 10 | Live SSE | `app.js` `connectSSE` → header lamp + spine + holotable |
| + | Threat heatmap | `#mod-threat` (risk band) + holotable threat sector |
| + | Logistics | `#mod-logistics` (segmented fuel meter) |
| + | Dead-letter | `#mod-deadletter` |

Data comes only from the live APIs (`/api/mission`, `/api/agents`, `/api/timeline`,
`/api/messages/{ref}`, `/api/troop-movement`, `/api/artifacts`, `/api/audit`,
`/api/dead-letters`, `/api/status-updates`, `/api/replay`, and the SSE stream at
`/api/events/stream`). Mission results are never hardcoded — before data arrives the
UI shows graceful `STANDBY` / `—` placeholders.
