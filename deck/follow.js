/**
 * Smooth follow for the cyberdeck (runs inside the embed page, injected by deck/vite.deck.config.mjs for ?embed=1).
 *
 * The deck's position arrives a few times a second through the globe's own server (/deck/pos, a loopback proxy to the
 * cyberdeck app on :8130). The marker and the chase camera show where the deck is NOW:
 *
 *   - each fix is placed at the moment the GPS took it (`fix_t`, the receiver's own UTC), not when it reached the Pi;
 *   - between fixes the position is carried forward from the last fix at its speed and course (dead reckoning, at most
 *     EXTRAPOLATE_S), so a 1 Hz receiver at highway speed no longer leaves the marker 40-60 m behind;
 *   - the drawn position eases toward that estimate (CORRECT_S) so a new fix never makes it jump, and snaps only when the
 *     error is large (a lost fix coming back).
 *
 * (Before 2026-10-20 the marker was drawn ~1.4 fix intervals in the PAST, interpolating between fixes stamped with their
 * arrival time: behind the real car at speed, then ahead of it when a stalled fix was extrapolated at the old speed.)
 *
 *   camera modes (from the deck's MAP SET tab): chase = behind the deck looking along the heading; top = straight down;
 *   free = the camera is left alone (marker still drawn). While chase/top is on, camera flights from posted views are
 *   cancelled so settings changes (layers, pins) do not yank the camera away.
 *
 * Needs globalThis.__gevEmbed = { viewer } (one line in src/app/embed.js on the cyberdeck branch).
 */
import * as Cesium from 'cesium';
import { setScopeMaskEnabled, isScopeMaskEnabled } from '/src/scopeMask.js';

const POLL_MS = 200;            // the deck's /gev/pos is cheap
const EXTRAPOLATE_S = 2.5;      // carry the last fix forward at most this long; after that hold it (a stop or a lost fix)
const CORRECT_S = 0.35;         // the drawn position eases toward the estimate with this time constant
const SNAP_M = 150;             // ... unless it is this far off: then it jumps
const ARRIVAL_LAG_S = 0.25;     // when the deck sends no fix_t: assume the fix is this old on arrival
const MIN_SPEED_MPH = 4;        // below this the GPS course is noise: hold the last heading, do not extrapolate
const RANGE_EASE_S = 2.5;       // the chase distance follows speed slowly - a stop or a burst of speed no longer snaps the zoom
const HEADING_EASE_S = 0.8;     // the view turns with the road smoothly instead of jumping to each GPS course
const M_PER_DEG = 111320;
const GROUND_EVERY_MS = 300;    // how often the ground under the deck is re-sampled from the rendered map
const GEOID_N = -29;            // ellipsoid - sea level (EGM96) around north Alabama; only for the GPS-altitude fallback
const ABOVE_GROUND_M = 1.5;     // the marker / camera target sits this far above the ground

function waitForEmbed() {
  return new Promise((resolve) => {
    const tick = () => (globalThis.__gevEmbed?.viewer ? resolve(globalThis.__gevEmbed) : setTimeout(tick, 250));
    tick();
  });
}

async function main() {
  const { viewer } = await waitForEmbed();
  const scene = viewer.scene;
  // The deck's screen is the whole map: GEV's signature circular "scope" mask (scopeMask.js, on by default) blacks out everything
  // outside a keyhole circle. Off in the deck view, and kept off if the app's restored state turns it back on.
  const scopeOff = () => { try { if (isScopeMaskEnabled()) setScopeMaskEnabled(false); } catch { /* older app build */ } };
  scopeOff(); setInterval(scopeOff, 2000);

  // fix = the latest real fix {lat, lon, tMs (when the GPS took it, epoch ms), mph, course}; disp = what is drawn
  const state = { heading: 0, mph: 0, mode: 'chase', fix: false, active: false, lastT: 0, lastFixMs: 0, pitchTop: -89,
                  lastLat: NaN, lastLon: NaN, fixData: null, disp: null, lagS: null, ground: null, groundSrc: '', groundAt: 0, altMsl: null };
  const drawn = new Cesium.Cartesian3();
  const marker = viewer.entities.add({
    id: 'cyberdeck-vehicle',
    position: new Cesium.CallbackProperty(() => (state.disp ? Cesium.Cartesian3.fromDegrees(state.disp.lon, state.disp.lat, (state.ground ?? 0) + ABOVE_GROUND_M, undefined, drawn) : undefined), false),
    point: { pixelSize: 14, color: Cesium.Color.CYAN, outlineColor: Cesium.Color.BLACK, outlineWidth: 2, disableDepthTestDistance: Number.POSITIVE_INFINITY },
    label: { text: 'cyberdeck', font: '13px sans-serif', pixelOffset: new Cesium.Cartesian2(0, -20), fillColor: Cesium.Color.WHITE, outlineColor: Cesium.Color.BLACK, outlineWidth: 3, style: Cesium.LabelStyle.FILL_AND_OUTLINE, disableDepthTestDistance: Number.POSITIVE_INFINITY },
    show: false,
  });

  async function poll() {
    try {
      const r = await fetch('/deck/pos', { cache: 'no-store' });
      if (!r.ok) throw new Error(String(r.status));
      const p = await r.json();
      state.mode = p.camera || 'chase'; state.active = !!p.nav_active; state.fix = !!p.fix;
      syncRoute(p.nav_active ? (p.route_t ?? null) : null);
      // one update per REAL fix: a new time and a new place (the deck repeats the last fix while it waits for the next)
      if (p.fix && Number.isFinite(p.lat) && Number.isFinite(p.lon) && p.t && p.t !== state.lastT && !(p.lat === state.lastLat && p.lon === state.lastLon)) {
        const tMs = Number.isFinite(p.fix_t) ? p.fix_t * 1000 : (p.t - ARRIVAL_LAG_S) * 1000;
        state.lagS = Number.isFinite(p.fix_lag_s) ? p.fix_lag_s : null;
        state.altMsl = Number.isFinite(p.alt_msl) ? p.alt_msl : state.altMsl;
        state.lastT = p.t; state.lastFixMs = performance.now(); state.lastLat = p.lat; state.lastLon = p.lon;
        state.mph = Number(p.mph) || 0;
        if (Number.isFinite(p.heading) && state.mph >= MIN_SPEED_MPH) state.heading = p.heading;
        state.fixData = { lat: p.lat, lon: p.lon, tMs, mph: state.mph, course: state.heading };
        if (!state.disp) state.disp = { lat: p.lat, lon: p.lon };
        marker.show = true;
      }
    } catch {
      /* the deck app is away; keep the last fix */
    }
  }
  setInterval(poll, POLL_MS); poll();

  // where the deck is now: the last fix carried forward along its course at its speed
  function estimate(nowMs) {
    const f = state.fixData; if (!f) return null;
    const dt = Math.max(0, Math.min(EXTRAPOLATE_S, (nowMs - f.tMs) / 1000));
    if (f.mph < MIN_SPEED_MPH || !dt) return { lat: f.lat, lon: f.lon };
    const d = f.mph * 0.44704 * dt, h = Cesium.Math.toRadians(f.course);
    return { lat: f.lat + (d * Math.cos(h)) / M_PER_DEG, lon: f.lon + (d * Math.sin(h)) / (M_PER_DEG * Math.cos(Cesium.Math.toRadians(f.lat))) };
  }

  // The ground under the deck. Height 0 is the ellipsoid, which around here is ~200 m BELOW the real ground: the chase camera ended
  // up inside the photorealistic tiles (a black screen with only the dot - owner's photo 2026-10-20). Sample the rendered map;
  // when it cannot answer yet, use the GPS altitude (sea level -> ellipsoid); keep the last good value otherwise.
  const scratchCarto = new Cesium.Cartographic();
  function updateGround(nowMs) {
    if (!state.disp || nowMs - state.groundAt < GROUND_EVERY_MS) return;
    state.groundAt = nowMs;
    let h;
    try {
      if (scene.sampleHeightSupported) {
        Cesium.Cartographic.fromDegrees(state.disp.lon, state.disp.lat, 0, scratchCarto);
        h = scene.sampleHeight(scratchCarto, [marker]);
      }
    } catch { h = undefined; }
    if (Number.isFinite(h)) {
      state.ground = state.ground == null || state.groundSrc !== 'map' ? h : state.ground + (h - state.ground) * 0.3; state.groundSrc = 'map';
    } else if (Number.isFinite(state.altMsl) && state.groundSrc !== 'map') {
      state.ground = state.altMsl + GEOID_N - ABOVE_GROUND_M; state.groundSrc = 'gps';
    }
  }

  // ---- the route as a progress bar (owner 2026-10-20): the route the deck is navigating (/deck/route), draped on the map around
  // the deck - orange for the road still ahead, light amber for the road already driven, split exactly at the deck's position.
  // Only ROUTE_BEHIND_M .. ROUTE_AHEAD_M is draped (the whole 100+ km route draped every frame made the Pi stutter), re-cut
  // every ROUTE_RECUT_M of progress; the split itself is one material uniform per frame, so the line is not rebuilt as it moves.
  const ROUTE_AHEAD_M = 5000, ROUTE_BEHIND_M = 1500, ROUTE_RECUT_M = 250;
  const AHEAD = Cesium.Color.fromCssColorString('#ff8c1a').withAlpha(0.95), BEHIND = Cesium.Color.fromCssColorString('#ffd58a').withAlpha(0.8);
  new Cesium.Material({ fabric: { type: 'DeckRouteProgress', uniforms: { ahead: AHEAD, behind: BEHIND, split: -1.0 }, source: `
    czm_material czm_getMaterial(czm_materialInput materialInput) {
      czm_material m = czm_getDefaultMaterial(materialInput);
      float w = smoothstep(split - 0.002, split + 0.002, materialInput.st.s);
      vec4 c = mix(behind, ahead, w);
      m.diffuse = c.rgb; m.emission = c.rgb * 0.35; m.alpha = c.a;
      return m;
    }` } });
  const route = { t: null, pts: null, cum: null, win: null, hint: 0, lastAlong: -1e9, entity: null, fetching: false };
  function ProgressMat() { this._definitionChanged = new Cesium.Event(); }
  Object.defineProperties(ProgressMat.prototype, { isConstant: { get: () => false }, definitionChanged: { get() { return this._definitionChanged; } } });
  ProgressMat.prototype.getType = () => 'DeckRouteProgress';
  ProgressMat.prototype.equals = function (o) { return this === o; };
  ProgressMat.prototype.getValue = function (time, result) {
    result = result || {}; result.ahead = AHEAD; result.behind = BEHIND;
    const along = routeAlong();
    result.split = route.win && along != null && route.win[1] > route.win[0] ? (along - route.win[0]) / (route.win[1] - route.win[0]) : -1.0;
    return result;
  };
  const kx = (lat) => M_PER_DEG * Math.cos(Cesium.Math.toRadians(lat));
  function routeAlong() {                                              // the deck's distance along the route (projected on the nearest segment)
    const d = state.disp, p = route.pts; if (!d || !p) return null;
    const k = kx(d.lat); let best = null, bd = Infinity;
    for (let i = Math.max(1, route.hint - 3); i < Math.min(p.length, route.hint + 5); i++) {
      const ax = p[i - 1][1] * k, ay = p[i - 1][0] * M_PER_DEG, bx = p[i][1] * k, by = p[i][0] * M_PER_DEG, px = d.lon * k, py = d.lat * M_PER_DEG;
      const vx = bx - ax, vy = by - ay, L2 = vx * vx + vy * vy || 1, t = Math.max(0, Math.min(1, ((px - ax) * vx + (py - ay) * vy) / L2));
      const ex = ax + t * vx - px, ey = ay + t * vy - py, dd = ex * ex + ey * ey;
      if (dd < bd) { bd = dd; best = route.cum[i - 1] + t * (route.cum[i] - route.cum[i - 1]); }
    }
    return best;
  }
  function recut() {                                                    // move the draped window along with the deck
    const d = state.disp, p = route.pts; if (!d || !p || p.length < 2) return;
    const k = kx(d.lat), near = (lo, hi) => { let b = -1, bd = Infinity; for (let i = Math.max(0, lo); i < Math.min(p.length, hi); i++) {
      const dx = (p[i][1] - d.lon) * k, dy = (p[i][0] - d.lat) * M_PER_DEG, dd = dx * dx + dy * dy; if (dd < bd) { bd = dd; b = i; } } return [b, Math.sqrt(bd)]; };
    let [i, dist] = near(route.hint - 50, route.hint + 400); if (dist > 300) [i, dist] = near(0, p.length);
    if (i < 0) return; route.hint = i;
    const along = route.cum[i]; if (route.entity && Math.abs(along - route.lastAlong) < ROUTE_RECUT_M) return;
    route.lastAlong = along;
    let a = i, b = i; while (a > 0 && along - route.cum[a] < ROUTE_BEHIND_M) a--; while (b < p.length - 1 && route.cum[b] - along < ROUTE_AHEAD_M) b++;
    if (b - a < 1) return;
    const positions = Cesium.Cartesian3.fromDegreesArray(p.slice(a, b + 1).flatMap((q) => [q[1], q[0]]));
    if (!route.entity) route.entity = viewer.entities.add({ id: 'cyberdeck-route', polyline: { positions, width: 8, material: new ProgressMat(), clampToGround: true, classificationType: Cesium.ClassificationType.BOTH } });
    else route.entity.polyline.positions = positions;
    route.win = [route.cum[a], route.cum[b]];
  }
  async function syncRoute(routeT) {
    if (routeT === route.t || route.fetching) return;
    if (!routeT) { route.t = null; route.pts = null; route.win = null; if (route.entity) { viewer.entities.remove(route.entity); route.entity = null; } return; }
    route.fetching = true;
    try {
      const r = await (await fetch('/deck/route', { cache: 'no-store' })).json();
      const p = (r.points || []).filter((q) => Number.isFinite(q[0]) && Number.isFinite(q[1]));
      if (p.length >= 2) {
        const cum = new Float64Array(p.length);
        for (let i = 1; i < p.length; i++) cum[i] = cum[i - 1] + Math.hypot((p[i][1] - p[i - 1][1]) * kx(p[i][0]), (p[i][0] - p[i - 1][0]) * M_PER_DEG);
        Object.assign(route, { t: r.route_t ?? routeT, pts: p, cum, hint: 0, lastAlong: -1e9 });
        recut();
      }
    } catch { /* try again on the next poll */ } finally { route.fetching = false; }
  }
  globalThis.__deckRoute = route;

  // ---- road info markers (owner 2026-10-20): ALPR / Flock cameras, Alabama DOT events, Rad's own detections and the owner's reports,
  // from the deck's /gev/alerts (roadinfo.py). One point + label each, clamped onto the map, kept in step every 3 s.
  const MARK = {
    flock: ['#ff4fd8', 'FLOCK'], alpr: ['#ff4fd8', 'ALPR'], crash: ['#ff3030', 'CRASH'], closure: ['#ff3030', 'CLOSED'],
    incident: ['#ffe14f', null], roadwork: ['#c98a3a', 'WORK'], detection: ['#b45cff', null],
    police: ['#4f8bff', 'POLICE'], emergency: ['#4f8bff', 'EMERGENCY'], hazard: ['#ffe14f', 'HAZARD'],
  };
  const marks = new Map();
  async function syncMarks() {
    let a; try { a = await (await fetch('/deck/alerts', { cache: 'no-store' })).json(); } catch { return; }
    const seen = new Set();
    for (const it of a.items || []) {
      if (!Number.isFinite(it.lat) || !Number.isFinite(it.lon)) continue;
      seen.add(it.id); if (marks.has(it.id)) continue;
      const [css, word] = MARK[it.kind] || ['#ffffff', null];
      const color = Cesium.Color.fromCssColorString(css);
      marks.set(it.id, viewer.entities.add({
        position: Cesium.Cartesian3.fromDegrees(it.lon, it.lat, 0),
        point: { pixelSize: it.kind === 'flock' || it.kind === 'alpr' ? 10 : 13, color, outlineColor: Cesium.Color.BLACK, outlineWidth: 2,
                 heightReference: Cesium.HeightReference.CLAMP_TO_GROUND, disableDepthTestDistance: Number.POSITIVE_INFINITY,
                 distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 40000) },
        label: { text: word || it.title || it.kind, font: 'bold 12px sans-serif', fillColor: color, outlineColor: Cesium.Color.BLACK, outlineWidth: 3,
                 style: Cesium.LabelStyle.FILL_AND_OUTLINE, pixelOffset: new Cesium.Cartesian2(0, -16), heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
                 disableDepthTestDistance: Number.POSITIVE_INFINITY, distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 6000) },
      }));
    }
    for (const [id, e] of marks) if (!seen.has(id)) { viewer.entities.remove(e); marks.delete(id); }
  }
  setInterval(syncMarks, 3000); syncMarks();
  setInterval(recut, 1000);

  const hpr = new Cesium.HeadingPitchRange();
  let lastFrameMs = 0;
  function frame() {
    const t = performance.now(), dt = lastFrameMs ? Math.min(0.5, (t - lastFrameMs) / 1000) : 0; lastFrameMs = t;
    const est = estimate(Date.now());
    updateGround(t);
    if (est && state.disp) {
      const dy = (est.lat - state.disp.lat) * M_PER_DEG, dx = (est.lon - state.disp.lon) * M_PER_DEG * Math.cos(Cesium.Math.toRadians(est.lat));
      if (Math.hypot(dx, dy) > SNAP_M) { state.disp = { ...est }; }
      else { const k = 1 - Math.exp(-dt / CORRECT_S); state.disp.lat += (est.lat - state.disp.lat) * k; state.disp.lon += (est.lon - state.disp.lon) * k; }
    }
    const mode = state.mode;
    if (!state.fix || !state.disp || (mode !== 'chase' && mode !== 'top')) return;
    if (t - state.lastFixMs > 15000) return;                             // no fix for 15 s: let go of the camera
    viewer.camera.cancelFlight();
    // range grows with speed so the road ahead stays in view; the chase sits behind and above, "top" looks straight down.
    // Both the range and the heading ease toward their targets (exponential, frame-rate independent) instead of snapping.
    const target = mode === 'top' ? 600 + Math.min(1200, state.mph * 15) : 260 + Math.min(560, state.mph * 8);
    if (!Number.isFinite(state.viewRange) || state.viewMode !== mode) { state.viewRange = target; state.viewHeading = state.heading; state.viewMode = mode; }
    state.viewRange += (target - state.viewRange) * (1 - Math.exp(-dt / RANGE_EASE_S));
    const dh = ((state.heading - state.viewHeading + 540) % 360) - 180;          // shortest way round
    state.viewHeading = (state.viewHeading + dh * (1 - Math.exp(-dt / HEADING_EASE_S)) + 360) % 360;
    hpr.heading = Cesium.Math.toRadians(state.viewHeading);
    hpr.pitch = Cesium.Math.toRadians(mode === 'top' ? state.pitchTop : -32);
    hpr.range = state.viewRange;
    viewer.camera.lookAt(Cesium.Cartesian3.fromDegrees(state.disp.lon, state.disp.lat, (state.ground ?? 0) + ABOVE_GROUND_M), hpr);
  }
  scene.preRender.addEventListener(frame);
  // a view posted by the deck (layers, pins) must not leave the camera locked to the marker's frame
  globalThis.__deckFollow = { state, estimate, stop() { scene.preRender.removeEventListener(frame); viewer.camera.lookAtTransform(Cesium.Matrix4.IDENTITY); } };
  console.info('[cyberdeck] follow ready (dead reckoning from the GPS fix time)');
}

main();
