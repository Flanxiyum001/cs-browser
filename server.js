/**
 * ============================================================================
 *  cs-browser  ::  server.js
 * ----------------------------------------------------------------------------
 *  Ultra-light, CLIENT-AUTHORITATIVE relay for the browser tactical FPS.
 *
 *  DESIGN CONTRACT
 *  ---------------
 *  This process is deliberately dumb. It performs:
 *      * player session bookkeeping (short id allocation, name, score rows)
 *      * blind fan-out of already-serialised packets to every other socket
 *      * static delivery of the client (index.html + the vendored three.js
 *        module) directly out of RAM
 *
 *  It performs NO:
 *      * simulation tick, no requestAnimationFrame loop, no fixed step
 *      * physics, no collision, no raycasting, no ballistics
 *      * world state reconciliation, no lag compensation, no snapshots
 *
 *  Consequently a whole match costs roughly "one JSON.stringify per event"
 *  plus "N socket writes", which is what keeps a Railway Hobby instance
 *  comfortably inside its CPU budget.
 *
 *  TRUST MODEL (read this before shipping anything competitive)
 *  ------------------------------------------------------------
 *  Movement, aim, hit detection and damage are all computed on the shooter's
 *  machine and merely broadcast. That is the price of a near-zero-cost relay.
 *  A modified client can therefore move faster than intended or claim free
 *  hits. Acceptable for friends/private matches; for public ranked play you
 *  would move aim and hits server-side, which is a much heavier design.
 *
 *  WIRE PROTOCOL  (JSON, compact keys -- see README.md for the full table)
 *  ---------------------------------------------------------------------
 *  client -> server : hello move fire hit death respawn smoke_deploy
 *                     flash_trigger plant defuse ping leave
 *  server -> client : welcome join round planted defused detonated move fire
 *                     hit death respawn smoke_deploy flash_trigger leave pong
 *
 *  Optimisation notes are inline where they matter.
 * ============================================================================
 */

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';

const ROOT = path.dirname(fileURLToPath(import.meta.url));

/* ---------------------------------------------------------------------------
 * Runtime tuning
 * ------------------------------------------------------------------------ */
const CFG = {
  port: Number(process.env.PORT || 8080),
  host: process.env.HOST || '0.0.0.0',

  /** Hard ceiling so one instance can never be turned into a CPU sink. */
  maxPlayers: Number(process.env.MAX_PLAYERS || 32),

  /** Any single client packet above this is dropped before it is even parsed. */
  maxPayload: 4 * 1024,

  /**
   * Per-client inbound budget. Movement streams at ~20 Hz plus the occasional
   * event, so 120/s is ~6x headroom for a legitimate client while still
   * cutting off a flood after a handful of abusive seconds.
   */
  ratePerSecond: Number(process.env.RATE_LIMIT || 120),
  rateStrikes: 40,

  /**
   * If a socket's outbound queue grows past this, we skip packets for that
   * socket instead of buffering without bound (a stalled tab must not be able
   * to grow server memory). 256 KiB is ~10s of backlog at realistic rates.
   */
  maxBuffered: 256 * 1024,

  /** Idle sockets are reaped by a ping/pong sweep. */
  heartbeatMs: 30_000,

  /** Set STATS=0 to silence the periodic footprint log. */
  stats: process.env.STATS !== '0',
  statsMs: 60_000,
};

const OPEN = WebSocket.OPEN;

/* ---------------------------------------------------------------------------
 * Match objective -- bomb defusal
 *
 * The relay owns the round clock, because a shared clock is the one piece of
 * state clients cannot each hold locally without disagreeing about it. It is
 * still a relay: the *client* runs the hold-to-plant channel, and this process
 * only re-checks the request against the last pose it received, so asking to
 * plant from the other side of the map is simply ignored. No simulation, no
 * per-frame work -- one packet per second per client for the whole round.
 *
 * Keep this block in step with CFG / Level._buildSites in index.html:
 * tools/check-client.mjs compares the SITES list below against the client's
 * and fails if the two ever drift apart.
 * ------------------------------------------------------------------------ */
const ROUND = {
  liveSeconds: 95,
  fuseSeconds: 40,
  intermissionSeconds: 9,
  defuseRadius: 1.9,
  /** Forgiven metres on a plant/defuse: the inbound pose stream is 20 Hz and
   *  is only sent when the pose actually changes, so it is never exact. */
  slack: 1.5,
};

/** Mirror of Level._buildSites in index.html -- the relay's copy. */
const SITES = [
  { id: 'A', x: -26, z: -25.5, hx: 4.2, hz: 3.6 },
  { id: 'B', x:  26, z:  25.5, hx: 4.2, hz: 3.6 },
];

const objective = {
  phase: 'live',            // live | planted | ended
  left: ROUND.liveSeconds,
  round: 1,
  siteIndex: -1,
  detonated: 0,
  defused: 0,
};

const siteId = (i) => (SITES[i] ? SITES[i].id : null);
const sitePos = (i) => [SITES[i].x, 0.02, SITES[i].z];

/** The single round packet: phase, time left, armed site and the counts. */
function roundSnapshot() {
  const snap = {
    t: 'round',
    ph: objective.phase,
    left: Math.max(0, objective.left),
    n: objective.round,
    si: objective.siteIndex,
    sd: siteId(objective.siteIndex),
    dt: objective.detonated,
    df: objective.defused,
  };
  // The bomb position is only meaningful while it is armed; sending it in any
  // other phase would re-arm the prop on every client.
  if (objective.phase === 'planted' && objective.siteIndex >= 0) snap.p = sitePos(objective.siteIndex);
  return snap;
}

function broadcastRound() {
  broadcastRaw(JSON.stringify(roundSnapshot()));
}

/** Close the round, announce why, then idle until the intermission is up. */
function endRound(kind, by = null) {
  const site = objective.siteIndex;
  objective.phase = 'ended';
  objective.left = ROUND.intermissionSeconds;
  objective.siteIndex = -1;
  if (kind === 'detonated') broadcastAll({ t: 'detonated', si: site, sd: siteId(site) });
  else if (kind === 'defused') broadcastAll({ t: 'defused', by, si: site, sd: siteId(site) });
  broadcastRound();
}

function openRound() {
  objective.round += 1;
  objective.phase = 'live';
  objective.left = ROUND.liveSeconds;
  objective.siteIndex = -1;
  broadcastRound();
}

/**
 * One second of match clock. A single interval for the whole process -- exactly
 * like the heartbeat -- so the objective costs one small packet per client per
 * second and one integer decrement.
 */
function objectiveTick() {
  objective.left -= 1;
  if (objective.left > 0) { broadcastRound(); return; }
  if (objective.phase === 'ended') { openRound(); return; }
  if (objective.phase === 'planted') { objective.detonated += 1; endRound('detonated'); return; }
  endRound('timeout');
}

/** Last pose inside the site rectangle (plus slack), or "looks like a lie". */
function poseInSite(client, site) {
  const p = client.pose && client.pose.p;
  if (!Array.isArray(p)) return false;
  return Math.abs(p[0] - site.x) <= site.hx + ROUND.slack
      && Math.abs(p[2] - site.z) <= site.hz + ROUND.slack;
}

function poseNearBomb(client) {
  const site = SITES[objective.siteIndex];
  const p = client.pose && client.pose.p;
  if (!site || !Array.isArray(p)) return false;
  return Math.hypot(p[0] - site.x, p[2] - site.z) <= ROUND.defuseRadius + ROUND.slack;
}

/* ---------------------------------------------------------------------------
 * Static assets -- preloaded into memory at boot.
 *
 * Serving from RAM removes disk I/O from the request path entirely and costs
 * ~1.4 MB of RSS (almost all of it the three.js module). It also means the
 * game keeps being served even if the container's filesystem is read-only.
 * ------------------------------------------------------------------------ */
const STATIC_ROUTES = new Map([
  /*
   * `live: true` means "read from disk on every request".
   *
   * The client is the one file you will edit constantly, so caching it in RAM
   * would silently serve a stale game until the server restarted. A page load
   * happens once per player, so reading ~110 KB per load costs nothing
   * measurable, and it makes reload-after-edit instant.
   */
  ['/', { file: 'index.html', type: 'text/html; charset=utf-8', live: true }],
  ['/index.html', { file: 'index.html', type: 'text/html; charset=utf-8', live: true }],
  ['/game', { file: 'index.html', type: 'text/html; charset=utf-8', live: true }],
  /*
   * The vendored three.js build is large, immutable and never edited, so it is
   * the one thing worth holding in RAM: no disk I/O on the request path, and
   * it still serves on a read-only container filesystem.
   */
  /*
   * The client's inline module does `import * as THREE from 'three'`, and the
   * import map resolves that to this path. So this route is NOT optional: if it
   * 404s, the browser refuses to run the page's module and the game sits on its
   * boot screen forever with nothing in the console but a failed request.
   *
   * It is served from the copy committed in vendor/ first, which makes the
   * deploy independent of node_modules being installed at runtime, and only
   * falls back to the installed package. `required: true` makes a missing copy
   * a loud boot failure instead of a silent 404 at request time.
   */
  [
    '/vendor/three.module.js',
    {
      file: 'vendor/three.module.js',
      fallback: 'node_modules/three/build/three.module.js',
      type: 'text/javascript; charset=utf-8',
      required: true,
    },
  ],
  /*
   * The minified variant is a genuine optional build: the client imports the
   * readable one, and this exists only as a lighter alternative. It is served
   * from the installed package and simply does not exist on a host without
   * node_modules, which is why it is not `required` and why there is no
   * committed copy to name here.
   */
  [
    '/vendor/three.module.min.js',
    {
      file: 'node_modules/three/build/three.module.min.js',
      type: 'text/javascript; charset=utf-8',
    },
  ],
]);

/** @type {Map<string, {file: string, type: string, live?: boolean, body?: Buffer, etag?: string}>} */
const routes = new Map();

/**
 * First path in the list that exists, or null. The vendored copy is committed
 * to the repository so it wins on any host, and node_modules is only the
 * fallback for a checkout that has not committed it yet.
 */
async function loadFirst(candidates) {
  for (const rel of candidates) {
    if (!rel) continue;
    try {
      return { file: rel, body: await readFile(path.join(ROOT, rel)) };
    } catch {
      // try the next location
    }
  }
  return null;
}

async function preloadAssets() {
  const missingRequired = [];

  for (const [route, spec] of STATIC_ROUTES) {
    const entry = { ...spec };
    routes.set(route, entry);
    if (spec.live) continue;

    const loaded = await loadFirst([spec.file, spec.fallback]);
    if (!loaded) {
      routes.delete(route);
      if (spec.required) missingRequired.push(`${route} (looked for ${spec.file})`);
      continue;
    }
    entry.body = loaded.body;
    entry.servedFrom = loaded.file;
    // Weak content fingerprint: good enough for a file we already pin forever.
    entry.etag = `"${loaded.body.length.toString(36)}-${loaded.file.length.toString(36)}"`;
  }

  /*
   * A relay that cannot serve the client's own module is not partially broken,
   * it is broken: the page will sit on its boot screen with a 404 in the
   * network tab. Crash at boot with the cause instead, because that is visible
   * in a deploy log where a lazy 404 never is.
   */
  if (missingRequired.length) {
    throw new Error(
      `required static asset missing: ${missingRequired.join(', ')} - ` +
      'commit the vendored build in vendor/ or install dependencies (bun install)'
    );
  }

  // Fail fast and loudly if the client itself is missing.
  try {
    await readFile(path.join(ROOT, 'index.html'));
  } catch (err) {
    throw new Error(`client missing: index.html (${err.message})`);
  }

  // One line per pinned route, so a deploy log proves what is being served and
  // from where -- this is the evidence a 404 here can never fake.
  for (const [route, entry] of routes) {
    if (entry.live) continue;
    console.log(`  asset  : ${route} <- ${entry.servedFrom} (${entry.body.length} bytes)`);
  }
}

/* ---------------------------------------------------------------------------
 * HTTP layer -- tiny byte-in / byte-out static host plus a health probe.
 * Railway (and most PaaS health checks) hit GET /health; answering in one
 * allocation with no JSON.stringify keeps it free.
 * ------------------------------------------------------------------------ */
const HEALTH_BODY = Buffer.from('{"ok":true}');

const server = createServer(async (req, res) => {
  try {
    // Only GET/HEAD are ever meaningful here.
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { allow: 'GET, HEAD' });
      res.end();
      return;
    }

    const route = (req.url || '/').split('?')[0];
    const isHead = req.method === 'HEAD';

    if (route === '/health' || route === '/healthz') {
      res.writeHead(200, {
        'content-type': 'application/json',
        'content-length': HEALTH_BODY.length,
        'cache-control': 'no-store',
      });
      res.end(isHead ? undefined : HEALTH_BODY);
      return;
    }

    if (route === '/favicon.ico') {
      res.writeHead(204);
      res.end();
      return;
    }

    // A fixed route table -- no path is ever taken from the request, so no
    // amount of ../ in the URL can reach the filesystem.
    const entry = routes.get(route);
    if (!entry) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('not found');
      return;
    }

    if (entry.live) {
      const body = await readFile(path.join(ROOT, entry.file));
      res.writeHead(200, {
        'content-type': entry.type,
        'content-length': body.length,
        // Always fresh: a deploy or a local edit must never be masked by a
        // cached copy of the client.
        'cache-control': 'no-store',
        // Do not let a browser guess a type: an ES module served as anything
        // else is refused outright, which is the black-screen failure mode.
        'x-content-type-options': 'nosniff',
      });
      res.end(isHead ? undefined : body);
      return;
    }

    // Immutable vendored asset: conditional fetch -> 304, no body copy.
    if (req.headers['if-none-match'] === entry.etag) {
      res.writeHead(304, { etag: entry.etag });
      res.end();
      return;
    }

    res.writeHead(200, {
      'content-type': entry.type,
      'content-length': entry.body.length,
      'cache-control': 'public, max-age=31536000, immutable',
      etag: entry.etag,
      'x-content-type-options': 'nosniff',
    });
    res.end(isHead ? undefined : entry.body);
  } catch (err) {
    // A thrown handler must never take the relay down with it.
    if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('internal error');
    console.error('[http]', err);
  }
});

server.keepAliveTimeout = 65_000;
server.headersTimeout = 70_000;

/* ---------------------------------------------------------------------------
 * WebSocket layer
 * ------------------------------------------------------------------------ */
const wss = new WebSocketServer({
  noServer: true,
  // The upgrade handler below accepts ANY path, which keeps the relay working
  // behind proxies that rewrite the route (Railway, Cloudflare, ngrok).
  perMessageDeflate: false, // gzip burns CPU for <200 byte packets: net loss
  maxPayload: CFG.maxPayload,
  clientTracking: true,
});

server.on('upgrade', (req, socket, head) => {
  if (players.size >= CFG.maxPlayers) {
    // 1013 = "try again later"; refuse the upgrade instead of allocating state.
    socket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

/**
 * A connected player. Kept as a flat object on purpose: V8 keeps monomorphic
 * shapes cheap and the whole roster is walked on every broadcast.
 */
let idCounter = 0;

/** id -> client record */
const players = new Map();
const usedIds = new Set();

function allocId() {
  let id;
  do {
    // base36 counter => 1, 2, ... 9, a, b ... z, 10 ... : short and unique
    // for far longer than any single process lifetime.
    id = (++idCounter).toString(36);
  } while (usedIds.has(id));
  usedIds.add(id);
  return id;
}

function makeClient(ws) {
  return {
    id: allocId(),
    ws,
    name: '',
    ready: false, // has sent `hello`
    alive: true,
    kills: 0,
    deaths: 0,
    /** latest `move` packet, replayed to newcomers so they see the room */
    pose: null,
    /* --- per-client rate limiting (fixed 1s window, no float math) --- */
    windowStart: 0,
    windowCount: 0,
    strikes: 0,
    /* --- per-client backpressure accounting --- */
    droppedPackets: 0,
    /* --- liveness --- */
    lastSeen: 0,
    isAlive: true,
  };
}

/** Server tick counter: purely a monotonic sanity value for clients. */
let serverTick = 0;

/* ---------------------------------------------------------------------------
 * Fan-out
 * ------------------------------------------------------------------------ */

/**
 * Broadcast one already-serialised string.
 *
 * This is the hot path: serialising once and sharing the same immutable string
 * across every recipient is the single biggest saving in the whole server.
 */
function broadcastRaw(raw, exceptId) {
  for (const c of players.values()) {
    if (c.id === exceptId) continue;
    const ws = c.ws;
    if (ws.readyState !== OPEN) continue;
    if (ws.bufferedAmount > CFG.maxBuffered) {
      c.droppedPackets++;
      continue;
    }
    ws.send(raw);
  }
}

/**
 * Relay a client-originated event to everyone else.
 *
 * The `msg` object is the freshly parsed inbound packet; we tag it in place
 * with `t` and `id` and serialise once, avoiding an intermediate copy for
 * every recipient.
 */
function relayOthers(msg, senderId) {
  msg.id = senderId;
  broadcastRaw(JSON.stringify(msg), senderId);
}

/** Send to every connected player, sender included. */
function broadcastAll(msg, exceptId) {
  broadcastRaw(JSON.stringify(msg), exceptId);
}

function send(ws, msg) {
  if (ws.readyState !== OPEN) return;
  if (ws.bufferedAmount > CFG.maxBuffered) return;
  ws.send(JSON.stringify(msg));
}

/* ---------------------------------------------------------------------------
 * Roster / score helpers
 * ------------------------------------------------------------------------ */

/** Compact roster so a joining player can render the room on frame one. */
function rosterSnapshot() {
  const out = [];
  for (const c of players.values()) {
    out.push({ i: c.id, n: c.name, s: c.pose, a: c.alive ? 1 : 0 });
  }
  return out;
}

function scoreRows() {
  const rows = [];
  for (const c of players.values()) rows.push([c.id, c.kills, c.deaths]);
  return rows;
}

function dropPlayer(c, announce) {
  if (!players.delete(c.id)) return;
  usedIds.delete(c.id);
  if (announce) broadcastAll({ t: 'leave', id: c.id, s: scoreRows() });
}

/* ---------------------------------------------------------------------------
 * Connection lifecycle
 * ------------------------------------------------------------------------ */
wss.on('connection', (ws) => {
  const client = makeClient(ws);
  client.lastSeen = Date.now();
  players.set(client.id, client);

  ws.on('message', (data, isBinary) => {
    // Binary frames are not part of the protocol; ignore without parsing.
    if (isBinary) return;
    // Fixed one-second window rate limit. A counter compare per packet is
    // far cheaper than a token bucket's float math, and the window boundary
    // being coarse does not matter when the budget has 6x headroom.
    const now = Date.now();
    if (now - client.windowStart >= 1000) {
      client.windowStart = now;
      client.windowCount = 0;
    }
    if (++client.windowCount > CFG.ratePerSecond) {
      if (++client.strikes > CFG.rateStrikes) {
        ws.close(1008, 'rate limit');
      }
      return;
    }
    client.lastSeen = now;

    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return; // malformed packet: drop silently, never crash the relay
    }
    if (msg === null || typeof msg !== 'object') return;

    switch (msg.t) {
      /* ---- identity ---------------------------------------------------- */
      case 'hello': {
        const isFirstHello = !client.ready;
        client.name = sanitiseName(msg.n);
        client.ready = true;
        // The welcome is re-sent every time so a reconnect or a rename always
        // gets a fresh roster snapshot; only the first one is announced.
        send(ws, {
          t: 'welcome',
          id: client.id,
          tick: ++serverTick,
          srv: { max: CFG.maxPlayers, rate: CFG.ratePerSecond },
          players: rosterSnapshot(),
          scores: scoreRows(),
        });
        if (isFirstHello) {
          broadcastAll({ t: 'join', id: client.id, n: client.name }, client.id);
          console.log(`[+] ${client.id} "${client.name}" joined (${players.size} in room)`);
        }
        // A newcomer needs the live round state on frame one, otherwise it
        // would sit on its own default clock until the next transition.
        send(ws, roundSnapshot());
        break;
      }

      /* ---- movement / aim stream (~20 Hz, the bulk of all traffic) ------ */
      case 'move': {
        // Kept only as the "last known pose" replay for late joiners.
        client.pose = msg;
        if (msg.al !== undefined) client.alive = msg.al !== 0;
        relayOthers(msg, client.id);
        break;
      }

      /* ---- weapon triggers (relayed verbatim, no simulation) ------------ */
      case 'fire':
        relayOthers(msg, client.id);
        break;

      /* ---- damage report from the shooter ------------------------------- */
      // `v` victim, `dmg` damage, `hp` victim health after the shot, `hs` head
      case 'hit':
        relayOthers(msg, client.id);
        break;

      /* ---- utility lifecycle -------------------------------------------- */
      // smoke_deploy : `p` [x,y,z] impact point, `r` cloud radius
      // flash_trigger: `p` [x,y,z] burst point, `d` [dx,dy,dz] view vector
      case 'smoke_deploy':
      case 'flash_trigger':
        relayOthers(msg, client.id);
        break;

      /* ---- match objective ------------------------------------------------ */
      // plant : `s` the site index the client believes it is standing in. The
      //         request is only honoured when the last pose we received is
      //         actually inside that site, so the steady clock cannot be abused
      //         from across the map.
      case 'plant': {
        if (objective.phase !== 'live') break;
        const site = SITES[msg.s];
        if (!site || !poseInSite(client, site)) break;
        objective.phase = 'planted';
        objective.left = ROUND.fuseSeconds;
        objective.siteIndex = msg.s;
        console.log(`[objective] ${client.id} armed site ${site.id} (${objective.left}s fuse)`);
        broadcastAll({
          t: 'planted', by: client.id, si: msg.s, sd: site.id,
          p: sitePos(msg.s), fuse: ROUND.fuseSeconds,
        });
        broadcastRound();
        break;
      }

      // defuse: only valid standing on the armed bomb, and only once it is armed
      case 'defuse': {
        if (objective.phase !== 'planted' || objective.siteIndex < 0) break;
        if (!poseNearBomb(client)) break;
        const sd = siteId(objective.siteIndex);
        objective.defused += 1;
        console.log(`[objective] ${client.id} defused site ${sd}`);
        endRound('defused', client.id);
        break;
      }

      /* ---- death / respawn / scoreboard --------------------------------- */
      case 'death': {
        const victim = players.get(client.id);
        const killer = typeof msg.by === 'string' ? players.get(msg.by) : undefined;
        if (victim) {
          victim.alive = false;
          victim.deaths++;
        }
        if (killer && killer !== victim) killer.kills++;
        broadcastAll({ t: 'death', id: client.id, by: msg.by || null, s: scoreRows() });
        break;
      }
      case 'respawn': {
        client.alive = true;
        client.pose = null;
        broadcastAll({ t: 'respawn', id: client.id, p: msg.p, s: scoreRows() }, client.id);
        break;
      }

      /* ---- latency probe ------------------------------------------------- */
      case 'ping':
        send(ws, { t: 'pong', c: msg.c, tick: ++serverTick });
        break;

      /* ---- explicit leave (close event is the fallback) ------------------ */
      case 'leave':
        dropPlayer(client, true);
        ws.close(1000, 'left');
        break;

      default:
        // Unknown verbs are swallowed, never forwarded. An open relay that
        // echoes anything it does not understand is an amplification vector.
        break;
    }
  });

  ws.on('pong', () => {
    client.isAlive = true;
    client.lastSeen = Date.now();
  });

  ws.on('error', () => {
    // Socket errors are terminal for that peer; the close handler cleans up.
  });

  ws.on('close', () => {
    dropPlayer(client, true);
    console.log(`[-] ${client.id} left (${players.size} in room)`);
  });
});

/* ---------------------------------------------------------------------------
 * Heartbeat sweep -- reclaims sockets from crashed tabs / dead NAT entries.
 * One timer for the entire server, not one per client.
 * ------------------------------------------------------------------------ */
/* ---------------------------------------------------------------------------
 * Match clock -- one shared second-tick for the whole process. Unref'd so it
 * can never hold the process open on its own.
 * ------------------------------------------------------------------------ */
const objectiveTimer = setInterval(objectiveTick, 1000);
objectiveTimer.unref();

const heartbeat = setInterval(() => {
  const cutoff = Date.now() - CFG.heartbeatMs * 2;
  for (const c of players.values()) {
    if (c.ws.readyState !== OPEN) continue;
    if (!c.isAlive) {
      c.ws.terminate();
      continue;
    }
    c.isAlive = false;
    c.ws.ping();
    if (c.lastSeen < cutoff) c.ws.terminate();
  }
}, CFG.heartbeatMs);
heartbeat.unref();

/* ---------------------------------------------------------------------------
 * Optional footprint log -- one line a minute proves the relay's cost.
 * ------------------------------------------------------------------------ */
let statsTimer = null;
if (CFG.stats) {
  statsTimer = setInterval(() => {
    const mem = process.memoryUsage();
    console.log(
      `[stats] players=${players.size} rss=${(mem.rss / 1048576).toFixed(1)}MB ` +
        `heap=${(mem.heapUsed / 1048576).toFixed(1)}MB`
    );
  }, CFG.statsMs);
  statsTimer.unref();
}

/* ---------------------------------------------------------------------------
 * Inbound validation helpers
 * ------------------------------------------------------------------------ */
function sanitiseName(raw) {
  if (typeof raw !== 'string') return `PLAYER-${idCounter}`;
  // Strip control characters, clamp length, keep it render-safe (the client
  // still escapes it before touching innerHTML).
  return raw.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 16) || `PLAYER-${idCounter}`;
}

/* ---------------------------------------------------------------------------
 * Boot / shutdown
 * ------------------------------------------------------------------------ */
async function main() {
  await preloadAssets();

  server.listen(CFG.port, CFG.host, () => {
    console.log(`cs-browser relay listening on http://${CFG.host}:${CFG.port}`);
    console.log(`  client : http://localhost:${CFG.port}/`);
    console.log(`  socket : ws://localhost:${CFG.port}/`);
  });
}

function shutdown(signal) {
  console.log(`${signal} received, draining...`);
  clearInterval(heartbeat);
  clearInterval(objectiveTimer);
  if (statsTimer) clearInterval(statsTimer);
  for (const c of players.values()) c.ws.close(1001, 'server shutting down');
  server.close(() => process.exit(0));
  // Don't hang a deploy forever on a stuck socket.
  setTimeout(() => process.exit(0), 4000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('uncaughtException', (err) => console.error('[uncaught]', err));

main().catch((err) => {
  console.error('fatal:', err);
  process.exit(1);
});
