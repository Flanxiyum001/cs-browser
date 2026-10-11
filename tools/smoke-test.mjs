/**
 * ============================================================================
 *  tools/smoke-test.mjs  --  `npm run smoke`
 * ----------------------------------------------------------------------------
 *  Boots server.js on an isolated port, drives two real WebSocket clients
 *  through the entire wire protocol, asserts the relay semantics (fan-out,
 *  sender exclusion, id stamping, score bookkeeping, latency probe, leave
 *  notification) and the static host, then tears the child process down.
 *
 *  Bounded and self-contained: it always exits, and it is the only automated
 *  way to prove the relay still behaves after a change.
 * ============================================================================
 */

import { spawn } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.SMOKE_PORT || 8099);
const BASE = `http://127.0.0.1:${PORT}`;
const WS_URL = `ws://127.0.0.1:${PORT}/`;

let passed = 0;
let failed = 0;

function check(label, ok, detail = '') {
  if (ok) {
    passed++;
    console.log(`  \u2713 ${label}`);
  } else {
    failed++;
    console.log(`  \u2717 ${label}${detail ? ` -- ${detail}` : ''}`);
  }
}

/* ---------------------------------------------------------------- utilities */

/** A socket wrapper that lets us await the next packet matching a predicate. */
function makePeer(label) {
  const ws = new WebSocket(WS_URL);
  const queue = [];
  const waiters = [];

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    const idx = waiters.findIndex((w) => w.pred(msg));
    if (idx >= 0) {
      const [w] = waiters.splice(idx, 1);
      clearTimeout(w.timer);
      w.resolve(msg);
    } else {
      queue.push(msg);
    }
  });

  return {
    label,
    ws,
    open: () => once(ws, 'open'),
    send: (obj) => ws.send(JSON.stringify(obj)),
    /** Consume an already-received packet, else wait briefly for one. */
    next(pred, timeout = 1500) {
      const idx = queue.findIndex(pred);
      if (idx >= 0) return Promise.resolve(queue.splice(idx, 1)[0]);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          const i = waiters.findIndex((w) => w.resolve === resolve);
          if (i >= 0) waiters.splice(i, 1);
          reject(new Error(`${label}: timed out waiting for packet`));
        }, timeout);
        waiters.push({ pred, resolve, timer });
      });
    },
    /** Assert nothing matching shows up within `ms`. */
    async silent(pred, ms = 350) {
      try {
        const got = await this.next(pred, ms);
        return got;
      } catch {
        return null;
      }
    },
    close: () => ws.close(),
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* -------------------------------------------------------------------- child */

async function boot() {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', STATS: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let out = '';
  child.stdout.on('data', (d) => (out += d.toString()));
  child.stderr.on('data', (d) => (out += d.toString()));

  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (out.includes('relay listening')) return { child, log: () => out };
    if (child.exitCode !== null) throw new Error(`server exited early:\n${out}`);
    await sleep(100);
  }
  child.kill('SIGKILL');
  throw new Error(`server never became ready:\n${out}`);
}

/* --------------------------------------------------------------------- main */

async function main() {
  const { child, log } = await boot();
  console.log(`\nrelay booted on :${PORT}\n`);

  try {
    /* ------------------------------------------------------- static host -- */
    console.log('static host');
    const home = await fetch(`${BASE}/`);
    const html = await home.text();
    check('GET / -> 200 html', home.status === 200 && (home.headers.get('content-type') || '').includes('text/html'));
    check(
      'GET / serves the game shell',
      html.startsWith('<!DOCTYPE html>') && html.includes('id="hud"'),
      `len=${html.length}`
    );
    const health = await fetch(`${BASE}/health`);
    check('GET /health -> ok', health.status === 200 && (await health.json()).ok === true);
    /*
     * The client's import statement points here, so this one asset is the
     * difference between a playable page and a black screen with a failed
     * request in it. Check the three things a browser actually cares about:
     * the status, the content-type (a module served as text/html is refused),
     * and that the bytes are the real library rather than a 404 page.
     */
    const vendor = await fetch(`${BASE}/vendor/three.module.js`);
    const vendorType = vendor.headers.get('content-type') || '';
    const vendorBody = await vendor.text();
    check('GET /vendor/three.module.js -> 200', vendor.status === 200, `status=${vendor.status}`);
    check('the vendored module is served as JavaScript',
      vendorType.includes('text/javascript'), `content-type=${vendorType}`);
    check('the vendored module carries x-content-type-options: nosniff',
      vendor.headers.get('x-content-type-options') === 'nosniff');
    check('the vendored module is the real build, not an HTML 404 page',
      !vendorBody.trimStart().startsWith('<') && vendorBody.includes('REVISION'),
      `starts with ${JSON.stringify(vendorBody.slice(0, 24))}`);
    const missing = await fetch(`${BASE}/nope`);
    check('unknown route -> 404', missing.status === 404);

    /* ------------------------------------------------------------ session -- */
    console.log('\nsession + id allocation');
    const a = makePeer('A');
    const b = makePeer('B');
    await a.open();
    await b.open();

    a.send({ t: 'hello', n: 'alpha' });
    const welcomeA = await a.next((m) => m.t === 'welcome');
    check('A receives welcome with short id', typeof welcomeA.id === 'string' && welcomeA.id.length <= 3, `id=${welcomeA.id}`);
    check('welcome carries a roster array', Array.isArray(welcomeA.players));
    check('welcome carries a tick', Number.isInteger(welcomeA.tick));

    b.send({ t: 'hello', n: 'bravo' });
    const welcomeB = await b.next((m) => m.t === 'welcome');
    check('ids are unique per player', welcomeB.id !== welcomeA.id);
    check(
      'B sees A in its roster snapshot',
      welcomeB.players.some((p) => p.i === welcomeA.id)
    );
    const joinSeenByA = await a.next((m) => m.t === 'join');
    check('A is notified that B joined', joinSeenByA.id === welcomeB.id && joinSeenByA.n === 'bravo');

    /* ----------------------------------------------------------- movement -- */
    console.log('\nmovement relay');
    a.send({ t: 'move', p: [1, 2, 3], y: 0.5, pi: -0.2, w: 'rifle', hp: 100, al: 1 });
    const stateAtB = await b.next((m) => m.t === 'move');
    check('B receives A movement', stateAtB.id === welcomeA.id && stateAtB.p[0] === 1 && stateAtB.p[2] === 3);
    check('movement is stamped with the sender id', stateAtB.id === welcomeA.id);
    const echoedToA = await a.silent((m) => m.t === 'move');
    check('sender does NOT receive its own movement echo', echoedToA === null);

    /* ------------------------------------------------------------ weapons -- */
    console.log('\nweapon + damage relay');
    b.send({ t: 'fire', w: 'rifle', o: [0, 1, 0], d: [1, 0, 0] });
    const fireAtA = await a.next((m) => m.t === 'fire');
    check('fire trigger is relayed to the other player', fireAtA.id === welcomeB.id && fireAtA.w === 'rifle');

    b.send({ t: 'hit', v: welcomeA.id, dmg: 34, hp: 66, w: 'rifle', hs: 0 });
    const hitAtA = await a.next((m) => m.t === 'hit');
    check('damage packet reaches the victim', hitAtA.v === welcomeA.id && hitAtA.hp === 66 && hitAtA.dmg === 34);

    /* ------------------------------------------------------------ utility -- */
    console.log('\nutility lifecycle relay');
    b.send({ t: 'smoke_deploy', p: [4, 0, 4], r: 4.5 });
    const smokeAtA = await a.next((m) => m.t === 'smoke_deploy');
    check('smoke_deploy relayed', smokeAtA.id === welcomeB.id && smokeAtA.p[0] === 4 && smokeAtA.r === 4.5);

    b.send({ t: 'flash_trigger', p: [2, 1.6, 2] });
    const flashAtA = await a.next((m) => m.t === 'flash_trigger');
    check('flash_trigger relayed', flashAtA.id === welcomeB.id && flashAtA.p[1] === 1.6);

    /* ---------------------------------------------------------- objective --
       The relay validates both objective requests against the last pose it
       received, so the first thing to prove is that a client which has never
       been *in* a site cannot arm one. B has sent no movement at this point. */
    console.log('\nobjective: bomb sites');
    b.send({ t: 'plant', s: 0 });
    const noPosePlant = await a.silent((m) => m.t === 'planted');
    check('a plant from a client with no pose inside the site is ignored', noPosePlant === null);

    // Walk B into site A (the north-west server room) and ask again.
    b.send({ t: 'move', p: [-26, 0, -25.5], y: 0, pi: 0, w: 'rifle', hp: 100, al: 1 });
    await a.next((m) => m.t === 'move');
    b.send({ t: 'plant', s: 0 });
    const plantedAtA = await a.next((m) => m.t === 'planted');
    check('a plant from inside site A is accepted and relayed to the others',
      plantedAtA.by === welcomeB.id && plantedAtA.si === 0 && plantedAtA.sd === 'A',
      JSON.stringify(plantedAtA));
    check('the relay decides where the bomb sits, not the client',
      Array.isArray(plantedAtA.p) && plantedAtA.p[0] === -26 && plantedAtA.p[2] === -25.5,
      JSON.stringify(plantedAtA.p));
    check('the plant carries the fuse the relay will count down', plantedAtA.fuse > 0);

    const roundPlanted = await a.next((m) => m.t === 'round' && m.ph === 'planted');
    check('the round snapshot flips to planted with the armed site',
      roundPlanted.si === 0 && roundPlanted.sd === 'A' && Array.isArray(roundPlanted.p));
    check('the snapshot counts down the same fuse it announced',
      roundPlanted.left <= plantedAtA.fuse, `left=${roundPlanted.left}`);

    // Defusing from the far side of the room must be refused, exactly as
    // planting from outside the site was.
    a.send({ t: 'move', p: [-26, 0, -18], y: 0, pi: 0, w: 'rifle', hp: 100, al: 1 });
    await b.next((m) => m.t === 'move');
    a.send({ t: 'defuse' });
    const farDefuse = await a.silent((m) => m.t === 'defused');
    check('a defuse from across the room is refused', farDefuse === null);

    a.send({ t: 'move', p: [-26, 0, -24], y: 0, pi: 0, w: 'rifle', hp: 100, al: 1 });
    await b.next((m) => m.t === 'move');
    a.send({ t: 'defuse' });
    const defusedAtB = await b.next((m) => m.t === 'defused');
    check('a defuse standing on the bomb is accepted and relayed',
      defusedAtB.by === welcomeA.id && defusedAtB.sd === 'A', JSON.stringify(defusedAtB));
    const roundEnded = await b.next((m) => m.t === 'round' && m.ph === 'ended');
    check('defusing ends the round and counts the defusal', roundEnded.df >= 1, JSON.stringify(roundEnded));
    // Every client re-arms the bomb prop from `p`, so the end-of-round snapshot
    // must not carry a position or the bomb would come back to life on screen.
    check('the ended snapshot no longer advertises a bomb position', roundEnded.p === undefined);

    // A player joining mid-match has to be told the round state on frame one.
    const late = makePeer('LATE');
    await late.open();
    late.send({ t: 'hello', n: 'late' });
    await late.next((m) => m.t === 'welcome');
    const lateRound = await late.next((m) => m.t === 'round');
    check('a late joiner is told the round state immediately',
      Number.isFinite(lateRound.left) && lateRound.n >= 1 && lateRound.df >= 1,
      JSON.stringify(lateRound));
    late.close();

    /* ---------------------------------------------------------- scoreboard -- */
    console.log('\ndeath + scorebook');
    b.send({ t: 'death', by: welcomeA.id });
    const deathAtA = await a.next((m) => m.t === 'death');
    const rowA = deathAtA.s.find((r) => r[0] === welcomeA.id);
    const rowB = deathAtA.s.find((r) => r[0] === welcomeB.id);
    check('death broadcast includes the killer', deathAtA.by === welcomeA.id);
    check('killer score incremented', rowA && rowA[1] === 1, JSON.stringify(rowA));
    check('victim death score incremented', rowB && rowB[2] === 1, JSON.stringify(rowB));

    b.send({ t: 'respawn', p: [0, 0, 0] });
    const respawnAtA = await a.next((m) => m.t === 'respawn');
    check('respawn relayed to others', respawnAtA.id === welcomeB.id);

    /* ------------------------------------------------------------- latency -- */
    console.log('\nlatency probe');
    a.send({ t: 'ping', c: 42 });
    const pong = await a.next((m) => m.t === 'pong');
    check('ping -> pong echoes the client stamp', pong.c === 42);

    /* --------------------------------------------------------------- junk -- */
    console.log('\nrobustness');
    a.ws.send('not json at all');
    b.send({ t: 'totally-unknown-event', x: 1 });
    b.send({ t: 'move', p: [9, 9, 9] });
    const afterJunk = await a.next((m) => m.t === 'move');
    check('malformed + unknown packets do not break the relay', afterJunk.p[0] === 9);

    /* ---------------------------------------------------------------- leave -- */
    console.log('\nleave notification');
    // Predicates name the peer explicitly: this match used to be any `leave`
    // at all, which silently consumed an earlier peer's departure instead.
    a.send({ t: 'leave' });
    const leaveAtB = await b.next((m) => m.t === 'leave' && m.id === welcomeA.id);
    check('leave broadcast on explicit leave', leaveAtB.id === welcomeA.id);

    const c = makePeer('C');
    await c.open();
    c.send({ t: 'hello', n: 'charlie' });
    const welcomeC = await c.next((m) => m.t === 'welcome');
    c.close();
    const leaveAtB2 = await b.next((m) => m.t === 'leave' && m.id === welcomeC.id);
    check('leave broadcast on socket close', leaveAtB2.id === welcomeC.id);

    b.close();
    await sleep(200);
  } finally {
    child.kill('SIGTERM');
    await Promise.race([once(child, 'exit'), sleep(3000)]);
    if (child.exitCode === null) child.kill('SIGKILL');
    const tail = log().split('\n').filter((l) => l.includes('ERROR') || l.includes('uncaught'));
    if (tail.length) console.log(`\nchild reported:\n${tail.join('\n')}`);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('\nsmoke test crashed:', err);
  process.exit(1);
});
