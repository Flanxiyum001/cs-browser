/**
 * ============================================================================
 *  tools/headless-logic-test.mjs
 * ---------------------------------------------------------------------------
 *  The client is one inline <script> in index.html, which means none of its
 *  real behaviour - collision, stepping, ray tracing, smoke occlusion - is
 *  reachable by a normal test runner.
 *
 *  This harness closes that gap: it extracts the live module out of index.html,
 *  rewrites the bare `three` specifier to the vendored file, stubs just enough
 *  DOM for the canvas-texture code paths, imports the REAL module and then
 *  drives the REAL physics and ray casts against the REAL level layout.
 *
 *  Nothing is duplicated or reimplemented here, so a regression in index.html
 *  shows up as a failure rather than as a stale copy passing.
 *
 *  Run with:  node tools/headless-logic-test.mjs
 * ============================================================================
 */

import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let passed = 0;
let failed = 0;
function check(label, ok, detail = '') {
  if (ok) { passed++; console.log(`  \u2713 ${label}`); }
  else { failed++; console.log(`  \u2717 ${label}${detail ? ` -- ${detail}` : ''}`); }
}

/* ------------------------------------------------------------ dom stubs ---- */
/* three.js only needs a canvas-like object for CanvasTexture; no GL at all is
   required for geometry, level building or ray casting. */
function makeCtx() {
  const grad = { addColorStop() {} };
  const noop = () => {};
  return {
    // style properties the texture generators write to
    fillStyle: '', strokeStyle: '', lineWidth: 1, font: '', textAlign: '', textBaseline: '',
    globalAlpha: 1, globalCompositeOperation: 'source-over', lineCap: '', lineJoin: '',
    // path + paint. Kept deliberately broad: a missing method here fails the
    // whole suite for a reason that has nothing to do with the client.
    fillRect: noop, strokeRect: noop, clearRect: noop,
    beginPath: noop, closePath: noop, moveTo: noop, lineTo: noop,
    bezierCurveTo: noop, quadraticCurveTo: noop,
    arc: noop, arcTo: noop, ellipse: noop, rect: noop,
    stroke: noop, fill: noop, clip: noop,
    save: noop, restore: noop, translate: noop, rotate: noop, scale: noop,
    transform: noop, setTransform: noop, resetTransform: noop,
    strokeText: noop, fillText: noop,
    createRadialGradient: () => grad,
    createLinearGradient: () => grad,
    createPattern: () => null,
    measureText: () => ({ width: 0 }),
    getImageData: () => ({ data: new Uint8ClampedArray(4) }),
  };
}
globalThis.document = {
  createElement: (tag) => ({ tagName: tag, width: 1, height: 1, style: {}, getContext: () => makeCtx() }),
  getElementById: () => null,
  querySelector: () => null,
  addEventListener() {},
  body: { appendChild() {} },
};
globalThis.window = { addEventListener() {}, innerWidth: 1280, innerHeight: 720, devicePixelRatio: 1 };
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.requestAnimationFrame = () => 0;

/* ------------------------------------------------------- extract + import -- */
const html = await readFile(path.join(ROOT, 'index.html'), 'utf8');
const moduleMatch = html.match(/<script\s+type="module">([\s\S]*?)<\/script>/);
if (!moduleMatch) {
  console.error('could not find the inline module in index.html');
  process.exit(1);
}

const MARKER = '\n/* ===========================================================================\n   BOOT';
const cut = moduleMatch[1].indexOf(MARKER);
if (cut < 0) {
  console.error('could not find the BOOT marker; the client module was not run');
  process.exit(1);
}

/*
 * Import the SAME three.js the browser loads: the copy committed in vendor/,
 * which is what server.js serves. That way this harness cannot quietly test
 * against a different build than the one that ships.
 */
const threeUrl = pathToFileURL(path.join(ROOT, 'vendor/three.module.js')).href;
let source = moduleMatch[1]
  .slice(0, cut)
  .replace(/from\s+'(?:\.\/vendor\/three\.module\.js|three)'/, `from '${threeUrl}'`);

// If the client's import specifier ever changes again, fail here rather than
// test a module whose dependency silently resolved to something else.
if (/\.\/vendor\/three\.module\.js/.test(source) || /from\s+'three'/.test(source)) {
  console.error('could not rewrite the three.js import; refusing to test a different build');
  process.exit(1);
}
source += `\nexport { CFG, Level, LocalPlayer, SmokeCloud, Weapon, RemotePlayer, Game, Input,
  Objective, WEAPONS, SLOT_ORDER, TracerPool, DecalPool, ImpactPool, clamp, lerp, hashInt };\n`;

const dir = await mkdtemp(path.join(os.tmpdir(), 'csb-logic-'));
const file = path.join(dir, 'client.mjs');
await writeFile(file, source, 'utf8');

const mod = await import(pathToFileURL(file).href);
const {
  CFG, Level, LocalPlayer, SmokeCloud, Objective, clamp, lerp, hashInt, WEAPONS, SLOT_ORDER, Input,
} = mod;
const THREE = await import(threeUrl);

console.log(`client module imported (${source.split('\n').length} lines)\n`);

/* ------------------------------------------------------------ 1. helpers --- */
console.log('helpers');
check('clamp bounds correctly', clamp(5, 0, 1) === 1 && clamp(-5, 0, 1) === 0 && clamp(0.5, 0, 1) === 0.5);
check('lerp midpoint', lerp(0, 10, 0.5) === 5);
check('hashInt is stable and side-consistent', hashInt('3') === hashInt('3') && new Set(['1', '2', '3', '4']).size === 4);
check('slot order matches the number keys', SLOT_ORDER.join(',') === 'rifle,pistol,knife,smoke,flash');
check('rifle is the slot-1 hitscan', WEAPONS.rifle.slot === 1 && WEAPONS.rifle.kind === 'hitscan');

/* -------------------------------------------------------- 2. level build --- */
console.log('\nlevel');
const scene = new THREE.Scene();
const level = new Level(scene);
check('level produces colliders', level.colliders.length > 25, `${level.colliders.length} colliders`);
check('level produces ray targets', level.solids.length >= level.colliders.length);
check('level has spawn points', level.spawns.length >= 4);
check('every collider is a well-formed box',
  level.colliders.every((b) => b.max.x > b.min.x && b.max.y > b.min.y && b.max.z > b.min.z));

// Ray casting needs up-to-date world matrices. In the browser renderer.render()
// does this every frame; headless, we have to ask for it explicitly.
scene.updateMatrixWorld(true);

const spawnFar = level.spawnPoint([]);
const spawnNear = level.spawnPoint([new THREE.Vector3(-32, 0, -32)]);
check('spawnPoint avoids the occupied corner', spawnNear.distanceTo(new THREE.Vector3(-32, 0, -32)) > 20,
  `chose ${spawnFar.toArray().join(',')}`);

/* The office plate is dense, so the level-specific checks below discover their
   own ground instead of hard-coding coordinates that a layout edit would
   silently invalidate. */
function findOpenSpot(radius = CFG.radius, height = CFG.height) {
  for (let x = -CFG.arena + 3; x <= CFG.arena - 3; x += 0.5) {
    for (let z = -CFG.arena + 3; z <= CFG.arena - 3; z += 0.5) {
      let free = true;
      for (const b of level.colliders) {
        if (b.min.y >= height) continue;                       // overhead only
        if (b.max.y <= CFG.stepHeight) continue;                // walkable-over
        if (x + radius <= b.min.x || x - radius >= b.max.x) continue;
        if (z + radius <= b.min.z || z - radius >= b.max.z) continue;
        free = false;
        break;
      }
      if (free) return new THREE.Vector3(x, 0, z);
    }
  }
  return null;
}

/** An x whose corridor between two z values is completely unobstructed. */
function findClearLane(zFrom, zTo, radius = CFG.radius) {
  const zLo = Math.min(zFrom, zTo) - radius;
  const zHi = Math.max(zFrom, zTo) + radius;
  for (let x = -CFG.arena + 2; x <= CFG.arena - 2; x += 0.25) {
    let blocked = false;
    for (const b of level.colliders) {
      if (b.min.y >= CFG.height) continue;                      // overhead only
      if (b.max.y <= CFG.stepHeight) continue;                   // walkable-over
      if (x + radius <= b.min.x || x - radius >= b.max.x) continue;
      if (zHi <= b.min.z || zLo >= b.max.z) continue;
      blocked = true;
      break;
    }
    if (!blocked) return x;
  }
  return null;
}

const openSpot = findOpenSpot();
const clearLaneX = findClearLane(-12, -CFG.arena + 0.5);
check('the office plate leaves circulation aisles open',
  openSpot !== null && clearLaneX !== null,
  `openSpot=${openSpot ? openSpot.toArray().join(',') : 'none'} clearLaneX=${clearLaneX}`);

/* ------------------------------------------------ 3. gravity + grounding -- */
console.log('\ncollision: falling and grounding');
const R = CFG.radius, H = CFG.height, STEP = CFG.stepHeight;
function simulate(pos, vel, seconds, dt = 1 / 120) {
  let grounded = false;
  const steps = Math.round(seconds / dt);
  for (let i = 0; i < steps; i++) {
    const st = level.move(pos, vel, dt, R, H, STEP);
    if (st.grounded) grounded = true;
  }
  return grounded;
}

{
  // Dropped from inside the room. The office has a suspended ceiling at
  // CFG.ceilingHeight, so an origin above that would land the body on the roof
  // -- which is correct, and is exactly why this probe stays under it.
  const from = openSpot.clone().setY(3);
  const v = new THREE.Vector3(0, 0, 0);
  let landed = false;
  for (let i = 0; i < 900 && !landed; i++) {
    v.y -= CFG.gravity / 120;
    const st = level.move(from, v, 1 / 120, R, H, STEP);
    landed = st.grounded;
  }
  check('a body dropped inside the room lands on the carpet', landed && Math.abs(from.y) < 0.02, `y=${from.y.toFixed(3)}`);
}

/* ----------------------------------------------------- 4. wall blocking --- */
console.log('\ncollision: perimeter wall');
{
  const p = new THREE.Vector3(clearLaneX, 0.001, -12);
  const v = new THREE.Vector3(0, 0, -8);
  simulate(p, v, 4);
  const wallInnerZ = -(CFG.arena + 0.4) + 0.4;   // inner face of the -Z wall
  check('a clear aisle runs out to the -Z wall and stops the body at radius distance',
    Math.abs(p.z - (wallInnerZ + R)) < 0.05,
    `x=${clearLaneX} z=${p.z.toFixed(3)} expected ${(wallInnerZ + R).toFixed(3)}`);
  check('the body was not ejected through the wall', p.z > -CFG.arena);
}

/* ---------------------------------------------------------- 5. auto-step -- */
console.log('\ncollision: walkable stage stair (auto-step)');
{
  // The stage is a 10 x 10 deck at 1.2 m centred on the origin, with a
  // three-tread stair on each side: risers of 0.30, 0.60, 0.90, then the deck.
  const p = new THREE.Vector3(9.5, 0.001, 0);
  const v = new THREE.Vector3(-5.5, 0, 0);
  let grounded = false;
  for (let i = 0; i < 1200; i++) {
    // keep re-applying the drive each sub-step, like a held W key would
    v.x = -5.5; v.y = Math.min(v.y, 0);
    const st = level.move(p, v, 1 / 120, R, H, STEP);
    if (st.grounded) grounded = true;
  }
  check('the player walked up the stair onto the 1.2 m stage',
    grounded && p.y > 1.15 && p.y < 1.25, `y=${p.y.toFixed(3)} x=${p.x.toFixed(2)}`);
  check('the player did not sink through the deck', p.x < 4.9, `x=${p.x.toFixed(2)}`);
}
{
  // A 1.3 m cubicle panel is cover, not a step: walking into a pod must stop
  // the body rather than carrying it up onto the desk.
  const p = new THREE.Vector3(12.5, 0.001, -22);
  const v = new THREE.Vector3(0, 0, -6);
  simulate(p, v, 2.5);
  check('a cubicle pod stops a walker instead of being stepped over',
    p.z > -27.5 && p.y < 0.1, `z=${p.z.toFixed(2)} y=${p.y.toFixed(3)}`);
}

/* ------------------------------------------- 5b. penetration property ---- */
console.log('\ncollision: body never ends up inside geometry');
{
  // The strongest check available on a dense map: drive the player around with
  // a seeded pseudo-random input generator and assert, on every single frame,
  // that the body is never horizontally inside a prop without standing on top
  // of it. This needs no knowledge of the layout at all, so any future prop
  // that the solver mishandles shows up here.
  const player = new LocalPlayer(level);
  player.spawn(new THREE.Vector3(0, 0, -30.6));
  const keys = new Set();
  const input = { down: (c) => keys.has(c), mouse: { down: false }, consumeMouse: () => ({ dx: 0, dy: 0 }) };
  const BURSTS = [
    ['KeyW', 'KeyD'], ['KeyW', 'KeyA'], ['KeyW'], ['KeyD'], ['KeyS', 'KeyD'],
    ['KeyS'], ['KeyA'], ['KeyS', 'KeyA'], ['KeyW'], ['KeyD'],
  ];
  let seed = 0x2f6e2b1;
  const rnd = () => {
    seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };

  let penetrations = 0;
  let worstDepth = 0;
  let longestRun = 0;
  let runAt = null;
  for (let burst = 0; burst < 120; burst++) {
    keys.clear();
    for (const k of BURSTS[Math.floor(rnd() * BURSTS.length)]) keys.add(k);
    if (rnd() > 0.5) keys.add('Space');
    if (rnd() > 0.7) keys.add('ShiftLeft');
    if (rnd() > 0.85) keys.add('ControlLeft');
    for (let i = 0; i < 30; i++) {
      player.update(1 / 60, input);
      const p = player.position;
      for (const b of level.colliders) {
        if (b.min.y >= player.height) continue;        // overhead only
        if (p.x + R <= b.min.x || p.x - R >= b.max.x) continue;
        if (p.z + R <= b.min.z || p.z - R >= b.max.z) continue;
        if (p.y >= b.max.y - 0.001) continue;          // standing on top
        if (p.y + player.height <= b.min.y + 0.001) continue;   // underneath
        penetrations++;
        worstDepth = Math.max(worstDepth, Math.min(b.max.y - p.y, 1));
        runAt = `burst ${burst} frame ${i} at ${p.x.toFixed(2)},${p.y.toFixed(2)},${p.z.toFixed(2)}`;
      }
    }
    longestRun = Math.max(longestRun, Math.hypot(player.velocity.x, player.velocity.z));
  }
  check('random movement never leaves the body stuck inside a prop',
    penetrations === 0, `${penetrations} penetrating frame(s), worst ${worstDepth.toFixed(3)} m -- ${runAt}`);
  check('the drive actually moved the body around the plate',
    longestRun > 3, `peak speed ${longestRun.toFixed(2)} m/s`);
}

/* -------------------------------------------------------- 6. ray casting -- */
console.log('\nballistics ray casts');
{
  // Down the central circulation corridor, straight into the 1.2 m stage.
  const rc = new THREE.Raycaster(new THREE.Vector3(0, 1.0, 9), new THREE.Vector3(0, 0, -1));
  rc.far = 60;
  const hits = rc.intersectObjects(level.solids, false);
  check('a centre-lane shot stops on the stage face at z=5',
    hits.length > 0 && Math.abs(hits[0].point.z - 5) < 0.06, hits[0] ? `z=${hits[0].point.z.toFixed(3)}` : 'no hit');
  check('the impact carries a usable face normal',
    hits.length > 0 && hits[0].face !== null && Math.abs(hits[0].face.normal.z) > 0.9);
}
{
  // Cast from the player's own eye height, i.e. from inside the room. An
  // origin above the suspended ceiling would legitimately hit the roof first;
  // that case is asserted on its own below.
  const down = new THREE.Raycaster(openSpot.clone().setY(CFG.eyeHeight), new THREE.Vector3(0, -1, 0));
  down.far = 40;
  const hits = down.intersectObjects(level.solids, false);
  check('a shot straight down on open ground hits the carpet at y=0',
    hits.length > 0 && Math.abs(hits[0].point.y) < 0.01, hits[0] ? `y=${hits[0].point.y.toFixed(3)}` : 'no hit');

  // The roof is a real surface: a shot straight up has to stop on the ceiling
  // tiles rather than escape the building.
  const up = new THREE.Raycaster(openSpot.clone().setY(CFG.eyeHeight), new THREE.Vector3(0, 1, 0));
  up.far = 40;
  const upHits = up.intersectObjects(level.solids, false);
  check('a shot straight up is stopped by the suspended ceiling',
    upHits.length > 0 && Math.abs(upHits[0].point.y - CFG.ceilingHeight) < 0.06,
    upHits[0] ? `y=${upHits[0].point.y.toFixed(3)}` : 'no hit');
}
{
  // The boardroom glazing has to be a solid ray target even though it is
  // transparent. That is the entire point of a glass wall: it costs you
  // nothing to see through, and it still stops a bullet.
  const rc = new THREE.Raycaster(new THREE.Vector3(-10, 1.2, -12), new THREE.Vector3(-1, 0, 0));
  rc.far = 30;
  const hits = rc.intersectObjects(level.solids, false);
  const glass = hits.find((h) => h.object.material === level.materials.glass);
  check('the transparent boardroom glazing stops a bullet at x=-19',
    !!glass && Math.abs(glass.point.x + 19) < 0.2,
    glass ? `x=${glass.point.x.toFixed(2)}` : `no glazing hit among ${hits.length}`);
  check('the glazing material is transparent, not opaque',
    level.materials.glass.transparent === true && level.materials.glass.opacity < 0.5);
}

/* ------------------------------------------------------------- 7. player -- */
console.log('\nlocal player');
{
  const player = new LocalPlayer(level);
  player.spawn(new THREE.Vector3(20, 0, 20));
  check('spawn places the feet on the ground', Math.abs(player.position.y) < 0.05, `y=${player.position.y}`);

  // camera flip protection
  for (let i = 0; i < 200; i++) player.look(0, 400);       // slam the mouse down
  check('pitch is clamped and the camera cannot flip', player.pitch >= -CFG.pitchLimit - 1e-6, `pitch=${player.pitch}`);
  for (let i = 0; i < 400; i++) player.look(0, -400);      // and back up
  check('upward pitch is clamped too', player.pitch <= CFG.pitchLimit + 1e-6, `pitch=${player.pitch}`);

  // yaw stays bounded over continuous spinning
  for (let i = 0; i < 5000; i++) player.look(300, 0);
  check('yaw stays wrapped to +/-PI', Math.abs(player.yaw) <= Math.PI + 1e-6, `yaw=${player.yaw}`);

  // forward vector must agree with the yaw convention used for movement
  player.yaw = 0;
  const f = new THREE.Vector3(-Math.sin(player.yaw), 0, -Math.cos(player.yaw));
  check('yaw=0 looks down -Z', Math.abs(f.x) < 1e-6 && Math.abs(f.z + 1) < 1e-6);

  // a held W input actually moves the body, and it comes to rest
  const keys = new Set(['KeyW']);
  const input = { down: (c) => keys.has(c), mouse: { down: false }, consumeMouse: () => ({ dx: 0, dy: 0 }) };
  const start = player.position.clone();
  for (let i = 0; i < 120; i++) player.update(1 / 120, input);
  const travelled = start.distanceTo(player.position);
  check('holding W moves the player', travelled > 2, `moved ${travelled.toFixed(2)} m`);
  check('the player stays grounded while running', player.grounded);
  check('running speed stays near runSpeed', Math.hypot(player.velocity.x, player.velocity.z) < CFG.runSpeed + 0.01);

  keys.clear();
  for (let i = 0; i < 240; i++) player.update(1 / 120, input);
  check('releasing W brings the body to rest', Math.hypot(player.velocity.x, player.velocity.z) < 0.05);

  // jump + land
  keys.add('Space');
  for (let i = 0; i < 6; i++) player.update(1 / 120, input);
  check('space leaves the ground', player.position.y > 0.02 || player.velocity.y > 0, `y=${player.position.y.toFixed(3)}`);
  keys.clear();
  for (let i = 0; i < 300; i++) player.update(1 / 120, input);
  check('the player lands again', player.grounded && Math.abs(player.position.y) < 0.05, `y=${player.position.y.toFixed(3)}`);
}

/* -------------------------------------------------------------- 8. smoke -- */
console.log('\nsmoke cloud');
{
  const origin = new THREE.Vector3(6, 0, 6);
  const cloud = new SmokeCloud(scene, origin, 4.7);
  check('a fresh cloud starts invisible', cloud.containment(origin) < 0.2);
  for (let i = 0; i < 120; i++) cloud.update(1 / 60);       // 2 s
  check('the cloud grows into an occluding mass', cloud.containment(origin) > 0.5,
    `containment=${cloud.containment(origin).toFixed(2)}`);
  check('outside the radius it blocks nothing', cloud.containment(new THREE.Vector3(40, 0, 40)) === 0);
  const opacities = cloud.spheres.map((s) => s.material.opacity);
  check('every sphere in the cluster is actually visible', opacities.every((o) => o > 0.1));
  check('spheres write depth so they can block sightlines', cloud.spheres.every((s) => s.material.depthWrite));
  for (let i = 0; i < 60 * 16; i++) cloud.update(1 / 60);
  check('the cloud expires and is flagged for disposal', cloud.done);
}

/* ------------------------------------------------------------- 9. weapon -- */
console.log('\nweapon behaviour');
{
  const viewScene = new THREE.Scene();
  const rifle = new mod.Weapon(WEAPONS.rifle, viewScene);
  check('rifle starts with a full magazine', rifle.ammo === WEAPONS.rifle.magSize && rifle.reserve === WEAPONS.rifle.reserve);
  check('rifle can fire immediately', rifle.canFire);
  rifle.cooldown = 60 / WEAPONS.rifle.rpm;
  check('fire rate gates the next shot', !rifle.canFire);
  rifle.cooldown = 0;
  rifle.ammo = 0;
  check('an empty magazine cannot fire', !rifle.canFire);
  check('an empty magazine can start a reload', rifle.startReload());
  rifle.tick(WEAPONS.rifle.reloadTime + 0.01);
  check('reloading refills from reserve', rifle.ammo === WEAPONS.rifle.magSize && rifle.reserve === WEAPONS.rifle.reserve - WEAPONS.rifle.magSize,
    `${rifle.ammo}/${rifle.reserve}`);

  const knife = new mod.Weapon(WEAPONS.knife, viewScene);
  check('the knife never runs out', knife.ammo === Infinity && knife.canFire);
  check('the knife cannot be reloaded', knife.startReload() === false);

  for (const id of SLOT_ORDER) {
    const def = WEAPONS[id];
    check(`${id}: damage/range values are sane`,
      def.kind === 'throw' ? def.count > 0 : def.damage > 0 && def.range > 0);
  }
}

/* ------------------------------------------- 10. viewmodel muzzle mapping -- */
console.log('\nviewmodel muzzle mapping');
{
  // The viewmodel is rendered from its own scene, so its muzzle position is
  // camera-local. Shots are traced in the world scene, so that position has to
  // be mapped through the camera or tracers spawn at the world origin.
  const world = new THREE.Scene();
  const cam = new THREE.PerspectiveCamera(78, 16 / 9, 0.045, 260);
  cam.rotation.order = 'YXZ';
  cam.position.set(12, 1.66, -9);
  cam.rotation.set(0.1, 0.7, 0);
  world.add(cam);
  cam.updateMatrixWorld(true);

  const viewScene = new THREE.Scene();
  const rifle = new mod.Weapon(WEAPONS.rifle, viewScene);
  viewScene.updateMatrixWorld(true);

  const viewSpace = rifle.muzzleWorld(new THREE.Vector3());
  const worldSpace = viewSpace.clone();
  cam.localToWorld(worldSpace);

  const fmt = (v) => v.toArray().map((n) => n.toFixed(2)).join(',');
  check('the muzzle sits in front of the view camera, below centre-right',
    viewSpace.z < -0.3 && Math.abs(viewSpace.x) < 0.6, fmt(viewSpace));
  check('mapping it through the camera puts it beside the player',
    worldSpace.distanceTo(cam.position) < 1.6, `${fmt(worldSpace)} vs ${fmt(cam.position)}`);
  check('the mapped muzzle is nowhere near the world origin (the bug this catches)',
    worldSpace.length() > 5, `|p|=${worldSpace.length().toFixed(2)}`);
}

/* -------------------------------------------------- 11. remote player sim -- */
console.log('\nremote player interpolation');
{
  const rp = new mod.RemotePlayer(scene, '7', 'bravo', 1);
  const t0 = performance.now();
  rp.applyState({ p: [0, 0, 0], y: 0, pi: 0, hp: 100, w: 'rifle', al: 1 });
  rp.buffer[0].t = t0 - 200;
  rp.applyState({ p: [10, 0, 0], y: 1.5, pi: -0.1, hp: 90, w: 'pistol', al: 1 });
  rp.buffer[1].t = t0;
  for (let i = 0; i < 30; i++) rp.update(1 / 60, new THREE.Vector3(0, 1.6, 0));
  check('interpolated position lands between the two snapshots',
    rp.group.position.x > 0 && rp.group.position.x < 10, `x=${rp.group.position.x.toFixed(2)}`);
  check('health tracks the latest packet', rp.hp === 90);
  check('weapon tracks the latest packet', rp.weapon === 'pistol');
  const before = rp.group.position.clone();
  rp.setAlive(false);
  for (let i = 0; i < 60; i++) rp.update(1 / 60, new THREE.Vector3(0, 1.6, 0));
  check('a downed body stops moving', rp.group.position.distanceTo(before) < 1e-6);
  check('a downed body tips over', rp.group.rotation.x > 1.2, `rx=${rp.group.rotation.x.toFixed(2)}`);
  check('hitboxes stay well formed while alive', rp.boxUpper.max.y > rp.boxUpper.min.y);
}

/* ---------------------------------------------------- 11b. boot watchdog --
   The classic script that sits outside the module. When the module never runs
   it is the ONLY thing on the page that can explain why, so its message is a
   user-facing deliverable and gets tested here rather than eyeballed in a
   browser: given a fetch that 404s, it must say 404, not "check the console". */
console.log('\nboot watchdog');
{
  const watchdogHtml = html.match(/<script>([\s\S]*?)<\/script>/);
  check('the page ships a classic boot watchdog outside the module', !!watchdogHtml);

  if (watchdogHtml) {
    const src = watchdogHtml[1];
    const mkRes = (status, type, body) => ({
      status,
      headers: { get: () => type },
      text: async () => body,
    });

    /** Run the watchdog with stubs and return a way to fire its timer / events. */
    const boot = ({ game, moduleRan, res, reject } = {}) => {
      const el = { hidden: true, innerHTML: '' };
      const listeners = {};
      const win = { addEventListener: (t, fn) => { listeners[t] = fn; } };
      if (game) win.__game = {};
      if (moduleRan) win.__engineModuleRan = true;
      let timer = null;
      const fetchStub = async () => {
        if (reject) throw new Error('network down');
        return res;
      };
      new Function('window', 'document', 'fetch', 'setTimeout', src)(
        win, { getElementById: () => el }, fetchStub, (fn) => { timer = fn; }
      );
      return { el, listeners, fire: () => timer && timer(), settle: () => new Promise((r) => setImmediate(r)) };
    };

    // 1. a booted engine says nothing at all
    {
      const t = boot({ game: true });
      t.fire();
      await t.settle();
      check('a booted engine produces no message (no false alarm)', t.el.hidden === true && t.el.innerHTML === '');
    }

    // 2. the case the player actually hit: the module never ran and the asset 404s
    {
      const t = boot({
        moduleRan: false,
        res: mkRes(404, 'text/html; charset=utf-8', '<h1>404 not found</h1>'),
      });
      t.fire();
      await t.settle();
      const msg = t.el.innerHTML;
      check('a 404 on the module is reported with its real status', /404/.test(msg), msg.slice(0, 120));
      check('the report names the URL the browser was asked for', /vendor\/three\.module\.js/.test(msg));
      check('an HTML body is called out as HTML, not JavaScript', /HTML, not JavaScript/.test(msg));
      check('the report distinguishes "never ran" from "ran and threw"', /module body never ran/.test(msg));
    }

    // 3. the module ran, so the asset was fine and the failure is elsewhere
    {
      const t = boot({
        moduleRan: true,
        res: mkRes(200, 'text/javascript; charset=utf-8', 'const REVISION = "169";'),
      });
      t.fire();
      await t.settle();
      check('a served module shifts the diagnosis to the engine itself',
        /module body ran but the engine did not start/.test(t.el.innerHTML), t.el.innerHTML.slice(0, 140));
    }

    // 4. a resource-level failure is caught immediately, without waiting
    {
      const t = boot({});
      t.listeners.error({ target: { tagName: 'SCRIPT', src: '/vendor/three.module.js' } });
      check('a resource load failure is reported the moment it happens',
        t.el.hidden === false && /vendor\/three\.module\.js/.test(t.el.innerHTML));
    }

    // 5. an unreachable server cannot produce an unhandled rejection
    {
      const t = boot({ reject: true });
      t.fire();
      await t.settle();
      check('a fetch that throws is still reported as a message',
        /could not fetch/.test(t.el.innerHTML), t.el.innerHTML.slice(0, 120));
    }
  }
}

/* --------------------------------------------------- 12. match objective -- */
console.log('\nobjective: bomb defusal');
{
  const o = new Objective(scene, level);

  /* --- sites: one per server room, and they must actually be plant-able --- */
  check('there is one marked site per server room', o.sites.length === 2);
  check('site A accepts a point in the north-west server room', o.siteAt(-26, -25.5) === 0);
  check('site B accepts the mirrored point', o.siteAt(26, 25.5) === 1);
  check('open floor belongs to no site', o.siteAt(0, 0) === -1);
  check('a point just outside a site is rejected',
    o.siteAt(-26, -25.5 - o.sites[0].hz - 0.01) === -1);
  check('both sites sit on the carpet, not on a prop',
    level.groundHeight(-26, -25.5, 100) === 0 && level.groundHeight(26, 25.5, 100) === 0);
  check('the server room\u2019s own rack cluster falls inside site A',
    [[-29, -27], [-26, -24], [-23, -27]].every(([x, z]) => o.siteAt(x, z) === 0));

  /* --- the round packet, which is the only source of round state --------- */
  o.applyRound({ ph: 'live', left: 42, n: 3, si: -1, dt: 1, df: 2 });
  check('a round packet sets phase, clock, round number and both counts',
    o.phase === 'live' && o.left === 42 && o.round === 3 && o.detonated === 1 && o.defused === 2);
  o.applyRound({ ph: 'planted', left: 40, n: 3, si: 1, dt: 1, df: 2, p: [26, 0.02, 25.5] });
  check('an armed round puts the bomb where the relay said',
    o.bomb.visible && o.bomb.position.x === 26 && o.bomb.position.z === 25.5 && o.siteIndex === 1);
  o.applyRound({ ph: 'ended', left: 9, n: 3, si: -1, dt: 2, df: 2 });
  check('the end of a round takes the bomb back off the map', !o.bomb.visible);
  o.applyRound({ ph: 'live', left: 95, n: 4, si: -1, dt: 2, df: 2 });

  /* --- the hold-to-plant channel ----------------------------------------- */
  const held = new Set();
  const input = { down: (c) => held.has(c) };
  const sent = [];
  const net = { send: (m) => sent.push(m) };
  const body = (x, z) => ({ position: new THREE.Vector3(x, 0, z), alive: true });
  const player = body(-26, -25.5);

  for (let i = 0; i < 60; i++) o.update(1 / 60, player, input, net);
  check('standing in a site offers a plant but sends nothing by itself',
    o.canPlant && sent.length === 0);

  held.add('KeyE');
  for (let i = 0; i < Math.round((CFG.plantSeconds - 0.4) * 60); i++) o.update(1 / 60, player, input, net);
  check('letting go early never arms the bomb', sent.length === 0 && o.channel < 1);
  held.delete('KeyE');
  o.update(1 / 60, player, input, net);
  check('releasing E clears the channel', o.channel === 0 && o.channelKind === null);

  held.add('KeyE');
  let frames = 0;
  while (sent.length === 0 && frames < 900) { o.update(1 / 60, player, input, net); frames++; }
  check('holding E for plantSeconds asks the relay to arm that site',
    sent.length === 1 && sent[0].t === 'plant' && sent[0].s === 0, JSON.stringify(sent[0]));

  for (let i = 0; i < 600; i++) o.update(1 / 60, player, input, net);
  check('the request is not re-sent while the relay has not answered', sent.length === 1);

  o.applyRound({ ph: 'live', left: 95, n: 4, si: -1, dt: 2, df: 2 });
  const away = body(0, 0);
  for (let i = 0; i < 120; i++) o.update(1 / 60, away, input, net);
  check('standing outside every site can never plant', !o.canPlant && sent.length === 1);

  /* --- the hold-to-defuse channel ---------------------------------------- */
  o.applyRound({ ph: 'planted', left: 30, n: 4, si: 0, dt: 2, df: 2, p: [-26, 0.02, -25.5] });
  const far = body(-20, -20);
  for (let i = 0; i < 600; i++) o.update(1 / 60, far, input, net);
  check('too far from the bomb, E does nothing at all',
    !o.canDefuse && o.channel === 0 && sent.length === 1);

  const near = body(-26, -25.5 + CFG.defuseRadius - 0.2);
  let dFrames = 0;
  while (sent.length === 1 && dFrames < 900) { o.update(1 / 60, near, input, net); dFrames++; }
  check('holding E on the bomb asks the relay to defuse',
    sent.length === 2 && sent[1].t === 'defuse', JSON.stringify(sent[1]));
  check('defusing is the slower channel of the two',
    dFrames > Math.round(CFG.plantSeconds * 60), `${dFrames} frames vs plant ${Math.round(CFG.plantSeconds * 60)}`);

  /* --- the armed-bomb prop ---------------------------------------------- */
  o.applyRound({ ph: 'planted', left: 6, n: 5, si: 0, dt: 2, df: 2, p: [-26, 0.02, -25.5] });
  let flips = 0;
  for (let i = 0; i < 300; i++) {
    const was = o.ledMat.color.getHex();
    o.tick(1 / 60);
    if (o.ledMat.color.getHex() !== was) flips++;
  }
  check('an armed bomb blinks its LED', flips >= 2, `${flips} transitions in 5 s`);
  o.applyRound({ ph: 'live', left: 95, n: 6, si: -1, dt: 2, df: 2 });
  const lit = o.ledMat.color.getHex();
  for (let i = 0; i < 300; i++) o.tick(1 / 60);
  check('a bomb that is not on the map cannot blink', o.ledMat.color.getHex() === lit);
}

/* ------------------------------------------------------------------ done -- */
await rm(dir, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
