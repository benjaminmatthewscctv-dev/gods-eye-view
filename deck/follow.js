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
