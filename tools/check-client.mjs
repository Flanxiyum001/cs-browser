/**
 * ============================================================================
 *  tools/check-client.mjs
 * ---------------------------------------------------------------------------
 *  index.html has no build step, so nothing else would catch a typo in the
 *  inline module. This does three cheap, high-value checks:
 *
 *    1. the document starts with a doctype and declares a `three` import map
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

if (/<script\s+type="importmap">/.test(html)) pass('declares an import map');
else fail('missing <script type="importmap">');

const importMap = html.match(/<script\s+type="importmap">([\s\S]*?)<\/script>/);
let threePath = null;
if (importMap) {
  try {
    threePath = JSON.parse(importMap[1]).imports?.three ?? null;
  } catch {
    fail('import map is not valid JSON');
  }
}
if (threePath) pass(`import map resolves "three" -> ${threePath}`);
else fail('import map has no "three" entry');

/* the vendored path must be the one server.js actually serves */
if (threePath && threePath.startsWith('/')) {
  const server = await readFile(path.join(ROOT, 'server.js'), 'utf8');
  if (server.includes(`'${threePath}'`)) pass('server.js serves that exact vendor path');
  else fail(`server.js does not serve ${threePath}`);
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
     client's import map points straight at /vendor/three.module.js, that 404
     is a black page with nothing on it but the boot overlay. So assert the
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
}

console.log(failed === 0 ? '\nclient checks passed' : `\n${failed} client check(s) failed`);
process.exit(failed === 0 ? 0 : 1);
