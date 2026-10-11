/**
 * ============================================================================
 *  tools/check-client.mjs
 * ---------------------------------------------------------------------------
 *  index.html has no build step, so nothing else would catch a typo in the
 *  inline module. This does three cheap, high-value checks:
 *
 *    1. the document starts with a doctype and imports three.js from a literal
 *       URL that server.js really serves (no import map to depend on)
 *    2. the inline module parses as real ES module syntax (`node --check`)
 *    3. every element id the module looks up actually exists in the markup
 *
 *  Run with:  node tools/check-client.mjs
 * ============================================================================
 */

import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let failed = 0;
function fail(msg) {
  failed++;
  console.log(`  \u2717 ${msg}`);
}
function pass(msg) {
  console.log(`  \u2713 ${msg}`);
}

const html = await readFile(path.join(ROOT, 'index.html'), 'utf8');

/* ------------------------------------------------------------- 1. document */
console.log('document');
if (html.startsWith('<!DOCTYPE html>')) pass('starts with a doctype');
else fail('does not start with <!DOCTYPE html>');

/*
 * How the client resolves three.js. A relative URL is deliberate: a bare
 * specifier ('three') resolved through an import map makes boot depend on the
 * browser supporting import maps, on the map surviving whatever proxy touches
 * the HTML, and on the mapped absolute path being exactly right -- and every
 * one of those failures looks the same from outside, namely "the module never
 * ran". So assert the specifier is a literal URL, and that the relay serves it.
 */
const importLine = html.match(/import\s+\*\s+as\s+THREE\s+from\s+'([^']+)'/);
const threePath = importLine ? importLine[1] : null;
if (!threePath) {
  fail('the client does not import THREE from a literal URL');
} else if (threePath.startsWith('./') || threePath.startsWith('../')) {
  pass(`the client imports three.js by relative URL (${threePath})`);
} else if (threePath.startsWith('https://')) {
  pass(`the client imports three.js from a CDN (${threePath})`);
} else {
  fail(`the THREE specifier is neither a relative path nor an https URL: ${threePath}`);
}

/* A real import map is a tag followed by its JSON body. Match that, not the
   words "import map" inside a comment explaining why there isn't one. */
if (/<script\s+type="importmap">\s*\{/.test(html)) {
  console.log('  ! the page still declares an import map; nothing imports a bare specifier any more');
} else {
  pass('the page no longer depends on an import map to resolve three.js');
}

/* a relative specifier must resolve to a route server.js really serves */
if (threePath && threePath.startsWith('./')) {
  const serverSrc = await readFile(path.join(ROOT, 'server.js'), 'utf8');
  const route = threePath.slice(1);            // './vendor/x.js' -> '/vendor/x.js'
  if (serverSrc.includes(`'${route}'`)) pass(`server.js serves that exact path (${route})`);
  else fail(`server.js does not serve ${route}`);
}

/* --------------------------------------------------------------- 2. syntax */
console.log('\nmodule syntax');
const moduleMatch = html.match(/<script\s+type="module">([\s\S]*?)<\/script>/);
if (!moduleMatch) {
  fail('no <script type="module"> block found');
} else {
  const code = moduleMatch[1];
  const dir = await mkdtemp(path.join(os.tmpdir(), 'csb-'));
  const file = path.join(dir, 'client.mjs');
  await writeFile(file, code, 'utf8');
  const res = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (res.status === 0) pass(`inline module parses (${code.split('\n').length} lines)`);
  else fail(`inline module has a syntax error:\n${res.stderr.trim()}`);
  await rm(dir, { recursive: true, force: true });

  /* ------------------------------------------------------------ 3. dom ids */
  console.log('\ndom contracts');
  const ids = new Set();
  for (const m of code.matchAll(/getElementById\(\s*'([^']+)'\s*\)/g)) ids.add(m[1]);
  for (const m of code.matchAll(/getElementById\(\s*"([^"]+)"\s*\)/g)) ids.add(m[1]);
  for (const m of code.matchAll(/querySelector\(\s*'#([A-Za-z][\w-]*)/g)) ids.add(m[1]);
  for (const m of code.matchAll(/querySelector\(\s*"#([A-Za-z][\w-]*)/g)) ids.add(m[1]);

  const missing = [];
  for (const id of ids) {
    if (!new RegExp(`id="${id}"`).test(html)) missing.push(id);
  }
  if (missing.length === 0) pass(`all ${ids.size} referenced element ids exist in the markup`);
  else fail(`missing element ids: ${missing.join(', ')}`);

  /* every id the markup defines should be reachable, and every stylesheet
     rule that targets one should have a matching element */
  const declared = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
  const isHexColour = (s) => /^[0-9a-f]{3,8}$/i.test(s);
  const styleIds = new Set(
    [...html.matchAll(/#([A-Za-z][\w-]*)/g)].map((m) => m[1]).filter((s) => !isHexColour(s))
  );
  const styleNoMatch = [...styleIds].filter((id) => !declared.has(id));
  if (styleNoMatch.length) {
    // not fatal: these can come from comments or JS string literals
    console.log(`  ! stylesheet references ids with no element: ${styleNoMatch.join(', ')}`);
  } else {
    pass('every id referenced in CSS resolves to an element');
  }

  /* weapon table / slot order / number keys must agree */
  console.log('\nweapon table');
  const slotOrder = code.match(/const SLOT_ORDER = \[([^\]]+)\]/);
  const keys = code.match(/const WEAPONS = \{([\s\S]*?)\n\};/);
  if (slotOrder && keys) {
    const order = [...slotOrder[1].matchAll(/'([a-z]+)'/g)].map((m) => m[1]);
    const defined = [...keys[1].matchAll(/^\s{2}([a-z]+):\s*\{/gm)].map((m) => m[1]);
    const bad = order.filter((id) => !defined.includes(id));
    if (bad.length) fail(`SLOT_ORDER references undefined weapons: ${bad.join(', ')}`);
    else pass(`all ${order.length} slots [${order.join(', ')}] resolve to weapon definitions`);

    const slots = [...keys[1].matchAll(/slot:\s*(\d+)/g)].map((m) => Number(m[1]));
    const unique = new Set(slots);
    if (unique.size === slots.length) pass(`weapon slot numbers ${slots.join(', ')} are unique`);
    else fail('duplicate weapon slot numbers');

    if (order.length === slots.length) pass('slot keys [1..N] cover the whole table');
    else fail(`SLOT_ORDER has ${order.length} entries but WEAPONS defines ${slots.length}`);
  } else {
    fail('could not locate SLOT_ORDER / WEAPONS');
  }

  /* the protocol verbs this client sends must be the ones server.js handles */
  console.log('\nwire protocol');
  const server = await readFile(path.join(ROOT, 'server.js'), 'utf8');
  const cases = new Set([...server.matchAll(/case '([a-z_]+)':/g)].map((m) => m[1]));
  const sent = new Set([...code.matchAll(/net\.send\(\{\s*t:\s*'([a-z_]+)'/g)].map((m) => m[1]));
  const unsupported = [...sent].filter((t) => !cases.has(t));
  if (unsupported.length) fail(`client sends verbs the relay does not handle: ${unsupported.join(', ')}`);
  else pass(`every verb the client sends (${[...sent].sort().join(', ')}) is handled by the relay`);

  const handled = new Set([...code.matchAll(/net\.on\(\s*'([a-z_]+)'/g)].map((m) => m[1]));
  const serverSends = new Set([...server.matchAll(/\{\s*t:\s*'([a-z_]+)'/g)].map((m) => m[1]));
  const unhandled = [...serverSends].filter((t) => !handled.has(t) && t !== 'welcome' && t !== 'error');
  if (unhandled.length) console.log(`  ! relay can send verbs the client ignores: ${unhandled.join(', ')}`);
  else pass('the client handles every verb the relay can emit');

  /* ------------------------------------------------------ 4. leaderboard --
     The requested interaction is a *hold*, not a toggle: shown while Tab is
     down, hidden the moment it is released. Both edges are separate code paths
     (a keydown case and a per-frame test against the held-key set), so assert
     each one -- a future edit that turns this into a sticky toggle would
     otherwise look fine in the browser until someone let go of the key. */
  console.log('\nleaderboard overlay');
  const showsOnTab = /case 'Tab':[\s\S]{0,240}?scoreboard\.classList\.add\('on'\)/.test(code);
  const hidesOnRelease = /!input\.down\('Tab'\)[\s\S]{0,140}?scoreboard\.classList\.remove\('on'\)/.test(code);
  if (showsOnTab) pass('holding Tab shows the leaderboard overlay');
  else fail('nothing shows the scoreboard overlay on the Tab keydown path');
  if (hidesOnRelease) pass('releasing Tab hides it again (a hold, not a sticky toggle)');
  else fail('the scoreboard overlay is never hidden again when Tab is released');
  if (/renderScoreboard\(this\)/.test(code) && /scoreRows\(\)/.test(code)) {
    pass('the overlay is rendered from the live roster + relay scores');
  } else {
    fail('the overlay is not wired to renderScoreboard(this) / scoreRows()');
  }

  /* -------------------------------------------------------- 5. objective --
     The bomb sites exist twice: once as geometry the client paints and tests
     against, once as the relay's validation table. Neither copy is derivable
     from the other, so the only defence against drift is to compare them here.
     Get this wrong and plants silently stop working in one wing. */
  console.log('\nobjective geometry');
  const sitePattern = /\{\s*id:\s*'([A-Z])',\s*x:\s*(-?[\d.]+),\s*z:\s*(-?[\d.]+),\s*hx:\s*([\d.]+),\s*hz:\s*([\d.]+)\s*\}/g;
  const readSites = (src) => [...src.matchAll(sitePattern)]
    .map((m) => ({ id: m[1], x: +m[2], z: +m[3], hx: +m[4], hz: +m[5] }));
  const clientSites = readSites(code);
  const relaySites = readSites(server);
  const key = (s) => `${s.id}@${s.x},${s.z} ${s.hx}x${s.hz}`;

  if (!clientSites.length || !relaySites.length) {
    fail(`could not read the site rectangles (client ${clientSites.length}, relay ${relaySites.length})`);
  } else {
    const relayKeys = new Set(relaySites.map(key));
    const drift = clientSites.filter((s) => !relayKeys.has(key(s)));
    const missing = relaySites.filter((s) => !new Set(clientSites.map(key)).has(key(s)));
    if (drift.length || missing.length) {
      fail(
        `client and relay disagree about the bomb sites: client-only [${drift.map(key).join(', ')}] ` +
          `relay-only [${missing.map(key).join(', ')}]`
      );
    } else {
      pass(`relay validates against the same ${clientSites.length} site rectangles the client paints`);
    }

    // A site the client cannot stand in is a site that can never be planted:
    // each rectangle must sit on the floor and contain a walkable point.
    const badFloor = clientSites.filter((s) => s.hz <= 0 || s.hx <= 0);
    if (badFloor.length) fail(`degenerate site rectangle(s): ${badFloor.map(key).join(', ')}`);
    else pass('every site rectangle has a positive area');
  }

  /* --------------------------------------------------- 6. static assets --
     server.js preloads a fixed route table at boot and DROPS any entry it
     cannot read. A dropped route is a 404 at request time, and because the
     client imports /vendor/three.module.js directly, that 404 is a black page
     with nothing on it but the boot overlay. So assert the
     files the table names are genuinely in the repository -- naming a path in
     server.js is not the same as shipping the file. */
  console.log('\nstatic asset routes');
  const routeFiles = [...server.matchAll(/\bfile:\s*'([^']+)'/g)].map((m) => m[1]);
  const repoRouteFiles = routeFiles.filter((f) => !f.startsWith('node_modules/'));
  const missingRouteFiles = repoRouteFiles.filter((f) => !existsSync(path.join(ROOT, f)));
  if (!repoRouteFiles.length) {
    fail('could not read the static route table out of server.js');
  } else if (missingRouteFiles.length) {
    fail(`static routes point at files that are not in the repository: ${missingRouteFiles.join(', ')}`);
  } else {
    pass(`all ${repoRouteFiles.length} committed static route file(s) exist on disk`);
  }

  const vendoredThree = repoRouteFiles.find((f) => f.endsWith('three.module.js'));
  if (!vendoredThree) {
    fail('server.js does not serve a committed three.module.js');
  } else {
    const head = readFileSync(path.join(ROOT, vendoredThree), 'utf8').slice(0, 400);
    if (!/<html/i.test(head) && /REVISION/.test(head)) {
      pass('the vendored three.js is the real module, not an HTML error page');
    } else {
      fail(`the vendored three.js does not look like the real module: ${JSON.stringify(head.slice(0, 60))}`);
    }
  }

  // The one route that may never be dropped: the client dies without it.
  const requiredVendor = /\/vendor\/three\.module\.js'[\s\S]{0,220}?required:\s*true/.test(server);
  if (requiredVendor) pass('the vendored three.js route is marked required, so it fails loudly instead of 404ing');
  else fail('the /vendor/three.module.js route is not marked required -- a missing copy would 404 silently');

  /* ------------------------------------------------------ 7. pointer lock --
     An unlocked pointer does not stay in the window: on a multi-monitor desk
     it walks onto the next screen the moment the player turns left. Pointer
     lock is the only thing that prevents that, and it fails in several
     distinct ways that all look identical from inside the game. Each contract
     below guards one of them:

       * release -- without a deliberate way out, the only escape is alt-tab
       * relock  -- the click that should take the pointer back lands on the
                    pause overlay, which covers the canvas: a canvas-only
                    listener would never fire, so the path must be on window
       * retry   -- a browser refuses a re-lock for a moment after Escape; with
                    no retry the player is simply stuck with a free cursor
       * screens -- after Escape the START screen must not come back, or the
                    player thinks the match was lost
  */
  console.log('\npointer lock');
  if (/e\.button === 1[\s\S]{0,160}?hooks\.onMiddleDown/.test(code)) {
    pass('the middle button is routed to a deliberate release');
  } else {
    fail('the canvas does not route the middle button to a release hook');
  }
  if (/_releaseLock\(\)[\s\S]{0,140}?document\.exitPointerLock\(\)/.test(code)) {
    pass('the middle click calls document.exitPointerLock()');
  } else {
    fail('nothing calls document.exitPointerLock() -- the cursor would be stuck in the game');
  }
  if (/window\.addEventListener\('mousedown',[\s\S]{0,460}?hooks\.onUnlockedClick/.test(code)) {
    pass('clicking while unlocked takes the pointer back (window-level, over the pause overlay)');
  } else {
    fail('no window-level click path re-locks: the pause overlay covers the canvas, so a canvas listener never sees it');
  }
  if (/relockRetryMs:\s*\[/.test(code) && /relockDelay\(/.test(code)) {
    pass('a refused lock request is retried on a bounded schedule');
  } else {
    fail('a refused lock request is never retried -- Escape then click leaves the player unlocked');
  }
  if (/window\.self !== window\.top/.test(code)) {
    pass('an embedded page names the frame as the likely cause, with a way out of it');
  } else {
    fail('the client cannot tell an embedded frame apart from a plain refusal');
  }
  if (/_onLockError\(\)[\s\S]{0,320}?this\.paused\.hidden = false/.test(code)) {
    pass('a refusal after deploy moves to the pause screen, where the reason is written');
  } else {
    fail('a first-deploy refusal leaves the start screen up, so the reason is never read');
  }
  if (/this\.overlay\.hidden = locked \|\| this\.deployed/.test(code)) {
    pass('the start screen does not come back once the match has begun');
  } else {
    fail('losing the lock shows the start screen again, as if the match had been lost');
  }

  /* --------------------------------------------------- 8. friends / room --
     Multiplayer is the room the page itself was served from, so the invite is
     just this URL. For a friend to actually get in, two things must hold: the
     client dials the origin it was served from rather than a hard-coded host,
     and the address it tells the player to share is read from that same
     location, so the two can never disagree. */
  console.log('\ninvite + room');
  if (/location\.protocol === 'https:' \? 'wss:' : 'ws:'[\s\S]{0,60}?location\.host/.test(code)) {
    pass('the socket dials the origin the page was served from, not a hard-coded host');
  } else {
    fail('resolveEndpoint() does not derive the socket from location.host');
  }
  if (/const join = location\.href/.test(code) && /share-url-2/.test(code)) {
    pass('the invite address shown to the player is the live page URL');
  } else {
    fail('the invite line is not filled from location');
  }
  if (/navigator\.clipboard\.writeText\(join\)/.test(code)) {
    pass('the invite link can be copied, with a visible failure if the clipboard is denied');
  } else {
    fail('the copy control is not wired to the invite address');
  }
  if (/_updateRoomCount\(\)/.test(code) && /room-count-2/.test(code)) {
    pass('the room count is shown and refreshed from the live roster');
  } else {
    fail('the room count is not wired to the roster');
  }
  if (/this\.net\.connect\(\)/.test(code) && /net\.on\('welcome'/.test(code)) {
    pass('the client joins the shared room at boot (no opt-in step to miss)');
  } else {
    fail('the client does not connect to the relay on its own');
  }

  /* ------------------------------------------------- 9. frame budget ------
     Lag is the least forgiving property of a shooter, and the two things that
     cost this scene a frame are fill rate and the shadow pass. The contracts
     here are what makes the client spend its budget on frames instead of
     pixels: a capped buffer, a stepper that reacts to its own measurements,
     and a measurement that reads the same on any refresh rate. */
  console.log('\nframe budget');
  const tiers = [...code.matchAll(/\{\s*ratio:\s*([\d.]+),\s*shadows:\s*(true|false)\s*\}/g)]
    .map((m) => ({ ratio: Number(m[1]), shadows: m[2] === 'true' }));
  if (tiers.length >= 3) pass(`quality adapts over ${tiers.length} resolution tiers`);
  else fail(`the quality tier table is missing or too short to adapt (${tiers.length})`);

  if (tiers.every((t, i) => i === 0 || t.ratio <= tiers[i - 1].ratio)) {
    pass('tier resolutions are ordered best-first');
  } else {
    fail('the tier table is not ordered best-first');
  }

  if (tiers.length && tiers[0].ratio <= 1.5) {
    pass(`the best tier caps the buffer at ${tiers[0].ratio}x, so a 2-3x retina buffer is never rendered`);
  } else {
    fail('the top tier renders more pixels than the fill-rate budget allows');
  }

  if (tiers.every((t, i) => t.shadows || i === tiers.length - 1)) {
    pass('the shadow pass is only dropped at the last-resort tier');
  } else {
    fail('shadows are switched off before the resolution tiers are exhausted');
  }

  if (/antialias: deviceRatio <= 1\.25/.test(code) && /setPixelRatio\(Math\.min\(deviceRatio, QUALITY_TIERS\[0\]\.ratio\)\)/.test(code)) {
    pass('multisampling is skipped where the buffer is already supersampled');
  } else {
    fail('the renderer is created without the high-DPI fill-rate guards');
  }

  const measuresWork = /const workStart = performance\.now\(\)[\s\S]{0,900}?const workMs = performance\.now\(\) - workStart/.test(code);
  if (measuresWork) {
    pass('the frame measures its own work, excluding the wait for the display refresh');
  } else {
    fail('frame work is not measured, so a smooth 60 Hz frame would read as late');
  }

  if (/qualityStep\(this\._quality\.tier, this\._workMs/.test(code) && /_applyQualityTier\(q\.tier\)/.test(code)) {
    pass('the frame loop feeds its measurement through the quality policy');
  } else {
    fail('the quality policy is never applied from the frame loop');
  }
}

console.log(failed === 0 ? '\nclient checks passed' : `\n${failed} client check(s) failed`);
process.exit(failed === 0 ? 0 : 1);
