# cs-browser

A lightweight browser tactical FPS in the spirit of Counter-Strike 1.6, built on
Three.js (WebGL 2.0, no WebGPU) with a deliberately dumb WebSocket relay for
multiplayer.

Three files matter:

| file | role |
| --- | --- |
| `server.js` | the whole backend: short-id session bookkeeping + blind packet fan-out + static hosting |
| `index.html` | the whole client: engine, level, weapons, utilities, HUD — one self-contained page |
| `vendor/three.module.js` | the pinned three.js build, committed so the page works without an install step |
| `tools/` | verification harnesses (see [Verifying](#verifying)) |

There is no bundler, no build step, no framework, no asset files and no
third-party network calls at runtime.

---

## The network model

This is a **strict client-authoritative** design, and that is the single decision
that keeps hosting cost near zero.

`server.js` never runs a simulation loop. It has no tick, no physics, no
collision, no raycasting, no snapshots and no reconciliation. The entire match
cost is roughly *one `JSON.stringify` per event* plus *N socket writes*, because
each outbound packet is serialised once and the same immutable string is handed
to every recipient:

```js
function relayOthers(msg, senderId) {
  msg.id = senderId;                                   // tag in place, no copy
  broadcastRaw(JSON.stringify(msg), senderId);         // serialise ONCE
}
```

Everything else in the server exists to protect that property:

* **Serialisation amortised across recipients.** A 20 Hz movement stream for 8
  players is ~160 writes/second against 8 strings/second of actual work.
* **Compression disabled.** `perMessageDeflate: false` — gzipping sub-200-byte
  packets costs more CPU than it saves in bandwidth, and CPU is the budget.
* **Backpressure guard.** A socket whose `bufferedAmount` passes 256 KiB is
  skipped rather than buffered, so one stalled tab cannot grow server memory.
* **Rate limiting.** A cheap 1-second window counter with a strike counter, so a
  flooding client is dropped instead of absorbed.
* **One heartbeat timer for the whole server**, not one per connection, plus a
  `maxPlayers` ceiling and a 4 KiB `maxPayload` cap.
* **Static assets served from RAM**, preloaded at boot: the request path never
  touches the disk, and the client keeps being served even on a read-only
  container filesystem.

### The cost of that model

Movement, aim, **hit detection and damage are all computed on the shooter's
machine** and merely broadcast. A modified client can therefore move faster than
intended or claim free hits. That is the correct trade for private matches
between friends and it is exactly what you asked for — but if you ever open this
to public ranked play, aim and hits have to move server-side, and the relay stops
being cheap. This is stated plainly in the header comment of `server.js` so
nobody rediscovers it the hard way.

---

## Run it locally

```bash
bun install          # or: npm install
node server.js       # or: bun start
```

Then open <http://localhost:8080>. Open a second tab to see another player.

The server hosts **both** the game and the socket, on one port, so there is
nothing else to run and nothing to configure.

Environment knobs (all optional):

| var | default | meaning |
| --- | --- | --- |
| `PORT` | `8080` | listen port (injected automatically by most hosts) |
| `HOST` | `0.0.0.0` | bind address |
| `MAX_PLAYERS` | `32` | hard connection ceiling per instance |
| `RATE_LIMIT` | `120` | inbound packets/second allowed per client |
| `STATS` | `1` | set `0` to silence the once-a-minute footprint log |

---

## Deploying to Railway

### Option A — one service (recommended, and the cheapest)

`server.js` serves the game *and* relays packets, so a single Railway service is
the whole product.

1. Push this repository to GitHub.
2. Railway → **New Project** → **Deploy from GitHub repo** → pick the repository.
3. Railway/Nixpacks installs dependencies and runs the `Procfile`
   (`web: node server.js`). Nothing else to configure.
4. **Settings → Networking → Generate Domain.**
5. Open the generated URL. Done — the client dials `wss://` on its own origin.

**You do not edit anything.** The client resolves its socket like this:

```
explicit WS_ENDPOINT  ->  ?server= query param  ->  the page's own origin
```

Same-origin is step 3, so a single-service deploy is zero-config by design.

### Option B — static client + relay on Railway

If you host `index.html` somewhere static (GitHub Pages, Netlify, a CDN) and keep
only the relay on Railway, the client can no longer guess the endpoint and you
**must** set it by hand.

Open `index.html` and find the `NETWORK CONFIG` block at the top of the module:

```js
const WS_ENDPOINT = null;
```

Set it to the Railway domain, with `wss://`:

```js
const WS_ENDPOINT = 'wss://cs-browser-production.up.railway.app/';
```

Two things to remember in this mode:

* Use `wss://`, not `ws://`. Browsers block insecure WebSockets from an
  `https://` page as mixed content.
* `/vendor/three.module.js` is served by `server.js`. If you are not running it
  in front of the client, point the engine's own import at a CDN instead — one
  line at the top of the module in `index.html`:

  ```js
  import * as THREE from 'https://unpkg.com/three@0.169.0/build/three.module.js';
  ```

You can also point any build at a relay at runtime without editing the file, by
opening `index.html?server=wss://your-relay.example.com`.

### Automatic deploys (GitHub Actions)

`.github/workflows/deploy.yml` runs on every push to `main`: it typechecks, runs
all three harnesses, and only then deploys the same commit to Railway. A
`workflow_dispatch` trigger lets you redeploy by hand.

It uses the Railway CLI rather than a marketplace action, because the published
"deploy to Railway" actions wrap an old pinned CLI on a frozen container tag.
The workflow installs `@railway/cli` from npm, links the target explicitly
(a CI run is not interactive, so `railway up` has nothing to attach the upload
to otherwise), and then pushes.

One-time setup, in **Settings → Secrets and variables → Actions**:

| kind | name | where it comes from |
| --- | --- | --- |
| secret | `RAILWAY_TOKEN` | Railway → your project → **Settings → Tokens**. A *project* token |
| variable | `RAILWAY_PROJECT_ID` | the project id |
| variable | `RAILWAY_ENVIRONMENT_ID` | environment id or name, e.g. `production` |
| variable | `RAILWAY_SERVICE_ID` | the service to deploy |

Do **not** also set `RAILWAY_API_TOKEN`: the CLI accepts one token variable at a
time, and that one is account-scoped where this pipeline wants project-scoped.
The deploy job fails with the name of whatever is missing, so a half-configured
repository tells you what to add instead of failing inside the CLI.

---

## Match objective

Every round is a bomb-defusal round, played on two marked sites — one in each
mirrored server room, over the rack cluster.

* The round clock is **95 s**. When it runs out with nothing planted, the round
  is a timeout and the next one opens after a 9 s intermission.
* Stand inside a site, **hold `E` for 3 s**, and the bomb is armed. The relay
  picks the bomb position (the site centre), not the client.
* Once armed the fuse is **40 s**. Stand on the bomb (1.9 m) and **hold `E` for
  5.5 s** to defuse it.
* The HUD strip at the top shows the clock, what the round is waiting for and
  your own plant/defuse channel; `hold Tab` adds the round number, the phase and
  the running totals to the scoreboard.

**The relay is not a spectator here.** `plant` and `defuse` are the only two
verbs it evaluates rather than forwards: it checks the relevant request against
*the last pose it received from that client* — inside the site rectangle for a
plant, within reach of the armed bomb for a defuse — and ignores anything else.
The client runs the hold channel and owns nothing but the request, so the usual
"a modified client can lie about movement" caveat does not extend to arming a
bomb from the other side of the map.

Because the site rectangles exist twice — once as geometry the client paints and
tests against, once as the relay's validation table — `tools/check-client.mjs`
compares the two copies and fails the build if they ever drift apart.

---

## Controls

| key | action |
| --- | --- |
| `W A S D` | move |
| `Space` | jump |
| `Shift` / `Ctrl` | walk / crouch |
| mouse | look (pointer lock) |
| left click | fire / swing / throw |
| `R` | reload |
| `1` `2` `3` `4` `5` | rifle · pistol · knife · smoke · flashbang |
| hold `Tab` | scoreboard (incl. round state) |
| hold `E` | plant the bomb inside a site / defuse the armed bomb |
| middle click / `Esc` | release the pointer (pause) — then click anywhere to take it back |

---

## Playing with friends

There is no lobby, no code and no host setup, because the relay that served the
page **is** the room: a friend who opens the same URL is in the same match. The
start and pause screens show the address to hand over, a button to copy it, and
how many operatives are in the room right now.

* Same origin means same match — a deployed Railway URL, a LAN address or a
  forwarded port all work equally.
* `?server=ws://host:port/` points the client at a *different* relay than the one
  serving the page, which is what the split deploy option below uses.
* Everyone sees the same roster, scoreboard, round clock and bomb state, and the
  relay — not the shooter — validates plants and defuses. See
  [Wire protocol](#wire-protocol).

---

## The cursor, and the frame budget

**The cursor is not allowed to leave the window.** On a multi-monitor desk an
unlocked pointer walks onto the next screen the moment you turn left, so pointer
lock is treated as part of the controls rather than as a nicety:

* **click anywhere**, or `resume`, takes the pointer back. That listener is on the
  window, not the canvas: the pause overlay covers the canvas, so a canvas
  listener would never see the click.
* **middle click** releases it deliberately, and so does `Esc`, which the browser
  owns and no page can intercept.
* a **refused request is retried** on a bounded schedule (`relockRetryMs`). The
  most common refusal is a browser declining a re-lock for a moment right after
  `Esc` — a legal request made too early — and without the retry the player is
  simply stuck with a free cursor.
* when it keeps failing, the pause screen **names the cause** instead of going
  quiet. A page embedded in a frame can be refused pointer lock outright
  (permissions policy, or a sandboxed iframe), and from inside the game that is
  indistinguishable from a broken build, so the client detects the frame and
  offers to open itself in its own tab.

**Lag is spent on frames, not pixels.** The loop measures its own work —
simulation plus both render passes, which excludes the idle wait for the display
refresh, so the budget reads the same at 60 Hz and at 240 Hz — and moves through
four quality tiers:

| tier | drawing buffer | shadows |
| --- | --- | --- |
| 0 | min(devicePixelRatio, 1.5) | yes |
| 1 | 1.25 | yes |
| 2 | 1.0 | yes |
| 3 | 0.75 | no |

Resolution is the dial that moves because it is the only one that can change
without recompiling a shader; the shadow pass is dropped only at the last tier
for the same reason. Stepping down takes 900 ms of late frames; stepping back up
takes three times that, so a quiet moment between two firefights is not mistaken
for headroom. At most one step per 2.5 s, so the resolution can never chase the
load it is measuring. `antialias` is skipped where the buffer is already
supersampled, and the canvas is created without alpha or a read-back buffer.

---

## Weapons and utilities

Slot 1 **rifle** — 33 damage, 600 RPM, full auto, 30/90, long-range hitscan with
tracers and bullet holes on impact.

Slot 2 **pistol** — 26 damage, semi-automatic, 20/80.

Slot 3 **knife** — 55 damage melee within 2.1 m, swings on a hold.

Slot 4 **smoke grenade** — click throws a simulated ball under gravity. On first
surface contact it broadcasts `smoke_deploy` and every client grows a cloud: a
cluster of transparent spheres that keep `depthWrite` on, which is what makes
them genuinely **occlude sightlines** rather than merely tint them, softened by
billboards so the cluster never reads as a pile of balls. Standing inside one
greys the screen proportionally to depth, which is the client-side meaning of
"blocking player vision paths". The same clouds also cut flash line-of-sight.

Slot 5 **flashbang** — detonates on impact or after a 2 s fuse. Intensity is
resolved *locally* per viewer from angle, distance and a line-of-sight ray, with
a ringing tone that scales with how badly you were looking at it. Behind you,
through a wall, or behind smoke means no effect.

Headshots are real: `_trace()` intersects three hitboxes per body and applies the
weapon's `headMul` / `limbMul` multiplier.

Adding a sixth weapon is a data change — append to the `WEAPONS` table and
`SLOT_ORDER`, and optionally add a case to `buildViewModel()`.

---

## Wire protocol

JSON with compact keys. `server.js` relays these verbatim; it only stamps `id`.

**client → server**

| `t` | payload | relayed |
| --- | --- | --- |
| `hello` | `n` display name | answers `welcome`, announces `join` |
| `move` | `p[x,y,z]`, `y` yaw, `pi` pitch, `w` weapon, `hp`, `al` alive, `c` crouch | to others |
| `fire` | `w` weapon, `o[x,y,z]` origin, `d[x,y,z]` direction | to others |
| `hit` | `v` victim, `dmg`, `hp` victim health after, `w`, `hs` headshot | to others |
| `smoke_deploy` | `p[x,y,z]`, `r` radius | to others |
| `flash_trigger` | `p[x,y,z]` | to others |
| `death` | `by` attacker, `w` weapon | to everyone (updates scores) |
| `respawn` | `p[x,y,z]` | to others |
| `plant` | `s` site index the client is standing in | **validated, not relayed** — see below |
| `defuse` | — | **validated, not relayed** — see below |
| `ping` | `c` client stamp | answers `pong` |
| `leave` | — | to everyone |

**server → client** — `welcome` (id + roster + scores), `join`, `round`,
`planted`, `defused`, `detonated`, `move`, `fire`, `hit`, `smoke_deploy`,
`flash_trigger`, `death`, `respawn`, `leave`, `pong`.

`plant` and `defuse` are the two verbs the relay evaluates instead of
forwarding: it checks the request against the last `move` pose it holds for that
client, and answers with `planted` / `defused` (to everyone) plus a fresh `round`
snapshot. `round` carries `ph` phase, `left` seconds, `n` round number, `si`
armed site index, `sd` its letter, `p[x,y,z]` the bomb position *while armed*,
and `dt` / `df` the running detonation and defusal counts. It is broadcast on
every transition and once a second in between — one small packet per client per
second for the whole match clock — and is also sent directly to a client the
moment it says `hello`, so a late joiner is on the right clock on frame one.

Notification of a leave happens on both paths: an explicit `leave` verb and the
socket `close` event, so a crashed tab still cleans up.

Because `hit` is monotonic-guarded on the receiving end, a reordered or
duplicated packet can never heal a player.

---

## Verifying

Three harnesses, each independent of the others:

```bash
npm run check
```

* **`tools/check-client.mjs`** — static analysis of `index.html`. It holds the
  behaviours a player notices immediately: that the pointer is released by the
  middle button, re-acquired by a click that lands on the pause overlay (a
  window-level listener, because the overlay covers the canvas), retried when
  the browser refuses, and reported honestly when it cannot be granted at all;
  that the invite line is filled from `location` — the same origin the socket
  dials — so a friend who opens the page really is in the room; and that the
  quality tier table is ordered best-first, capped at 1.5x, and wired into the
  loop. Beyond that it asserts the
  engine's `import` is a literal URL (a relative path, or a CDN) rather than a
  bare specifier that would need import-map support, resolves to a path
  `server.js` actually serves, parses the inline
  module as real ESM (there is no bundler to catch a typo), cross-checks every
  DOM id the module looks up against the markup, validates the weapon table
  against `SLOT_ORDER`, proves every protocol verb the client sends is one the
  relay handles, and compares the client's bomb-site rectangles against the
  relay's copy of them. It also verifies that every file named in `server.js`'s
  static route table really exists in the repository: naming a path there is not
  the same as shipping the file, and a route that cannot be read is dropped at
  boot and 404s at request time — which is a black page with nothing on it but
  the boot overlay.

* **`tools/headless-logic-test.mjs`** — **runs the real client module.** It
  extracts the live `<script>` out of `index.html`, rewrites the bare `three`
  specifier, stubs just enough DOM for the canvas-texture code paths, imports
  the actual module and drives the actual code: gravity and grounding, perimeter
  collisions, walking up the stair onto the vantage deck, waist-high cover still
  blocking, hitscan ray casts against the real level, pitch-clamp camera-flip
  protection, yaw wrapping, run/stop/jump cycles, smoke growth and expiry, weapon
  reload arithmetic, remote-player interpolation, the boot watchdog's diagnosis
  (run under stubs: a 404 must be reported as a 404, and a booted engine must
  produce no message at all), and the objective: site hits
  and misses, the round packet, the hold-to-plant / hold-to-defuse channels
  (including that releasing early or standing outside the zone sends nothing),
  and the armed bomb's blink. It also drives the pointer-lock and quality
  policies frame by frame (the retry schedule's bounds; the stepper settling on
  the floor under load, climbing back with headroom, ignoring a single spike and
  never oscillating) and the input wiring itself, under a small event registry:
  a middle click reaches the release hook, a click is answered exactly once even
  though the browser bubbles it, and mouse motion is ignored while the pointer is
  unlocked. Nothing is reimplemented, so a regression in `index.html` fails here
  instead of silently passing against a stale copy.

* **`tools/smoke-test.mjs`** — boots the relay on an isolated port and drives two
  real WebSocket clients through the entire protocol: id allocation and
  uniqueness, roster snapshots, movement fan-out **and sender exclusion**,
  weapon and damage relay, utility lifecycle, score bookkeeping, the latency
  probe, robustness against malformed and unknown packets, and leave on both the
  explicit and the socket-close path. The objective is exercised end to end: a
  plant with no pose inside a site is ignored, a plant from inside one is
  accepted and fanned out with the relay's own bomb position, a defuse from
  across the room is refused while one standing on the bomb is accepted, the
  round snapshot flips phase and drops the bomb position when the round ends,
  and a late joiner is handed the live round state on arrival. It also checks
  the static host serves the game shell and the vendored three.js build — status,
  `text/javascript` content-type, `nosniff`, and that the bytes are the real
  library rather than an HTML error page — and that the *served* page carries the
  things a second player needs on the wire: the invite address, the copy control,
  the room counter and the stated way to release the pointer. Then it tears the
  child down.

---

## Layout

```
server.js                 relay + static host (the entire backend)
index.html                client (the entire frontend)
vendor/
  three.module.js         the pinned three.js build, served at /vendor/three.module.js
Procfile                  Railway/Nixpacks process declaration
package.json              ws + three, run and check scripts
.github/workflows/
  deploy.yml              verify (typecheck + harnesses) then deploy to Railway
tools/
  check-client.mjs        static contract checks on index.html
  headless-logic-test.mjs behavioural tests against the real client module
  smoke-test.mjs          end-to-end relay protocol test
```

`index.html` is organised into numbered sections — config, math, audio, network
client, level, effects, weapons, player models, local player + input, HUD, game
loop — so a specific subsystem is findable without a search.
