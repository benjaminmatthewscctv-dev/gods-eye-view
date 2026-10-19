/**
 * Smooth follow for the cyberdeck (runs inside the embed page, injected by deck/vite.deck.config.mjs for ?embed=1).
 *
 * The deck's position arrives a few times a second through the globe's own server (/deck/pos, a loopback proxy to the
 * cyberdeck app on :8130). Fixes go into a Cesium SampledPositionProperty with interpolation and a short forward
 * extrapolation, so the vehicle marker and the chase camera move every frame instead of jumping once per fix.
 *
 *   camera modes (from the deck's MAP SET tab): chase = behind the deck looking along the heading; top = straight down;
 *   free = the camera is left alone (marker still drawn). While chase/top is on, camera flights from posted views are
 *   cancelled so settings changes (layers, pins) do not yank the camera away.
 *
 * Needs globalThis.__gevEmbed = { viewer } (one line in src/app/embed.js on the cyberdeck branch).
 */
import * as Cesium from 'cesium';
import { setScopeMaskEnabled, isScopeMaskEnabled } from '/src/scopeMask.js';

const POLL_MS = 200;            // the deck's /gev/pos is cheap; the deck hub's GPS runs at 5 Hz
const LAG_MIN_MS = 350, LAG_MAX_MS = 2500;   // render behind "now" by ~1.4 fix intervals: 5 Hz deck hub -> ~0.35 s, 1 Hz phone -> ~1.4 s
const EXTRAPOLATE_S = 3.0;      // keep moving (constant velocity) for this long when fixes stall
const MIN_SPEED_MPH = 4;        // below this the GPS course is noise: hold the last heading (2 let stops swing the view)
const RANGE_EASE_S = 2.5;       // the chase distance follows speed slowly - a stop or a burst of speed no longer snaps the zoom
const HEADING_EASE_S = 0.8;     // the view turns with the road smoothly instead of jumping to each GPS course

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
  const position = new Cesium.SampledPositionProperty();
  position.setInterpolationOptions({ interpolationDegree: 1, interpolationAlgorithm: Cesium.LinearApproximation });
  position.forwardExtrapolationType = Cesium.ExtrapolationType.EXTRAPOLATE;
  position.forwardExtrapolationDuration = EXTRAPOLATE_S;
  position.backwardExtrapolationType = Cesium.ExtrapolationType.HOLD;

  const state = { heading: 0, mph: 0, mode: 'chase', fix: false, active: false, lastT: 0, lastFixMs: 0, pitchTop: -89, lastLat: NaN, lastLon: NaN, intervals: [], lagMs: 1400 };
  const marker = viewer.entities.add({
    id: 'cyberdeck-vehicle',
    position,
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
      // one sample per REAL fix: a new time and a new place (the deck repeats the last fix while it waits for the next)
      if (p.fix && Number.isFinite(p.lat) && Number.isFinite(p.lon) && p.t && p.t !== state.lastT && !(p.lat === state.lastLat && p.lon === state.lastLon)) {
        if (state.lastT) { state.intervals.push(p.t - state.lastT); if (state.intervals.length > 8) state.intervals.shift(); }
        const sorted = [...state.intervals].sort((a, b) => a - b); const median = sorted.length ? sorted[sorted.length >> 1] : 1.0;
        state.lagMs = Math.min(LAG_MAX_MS, Math.max(LAG_MIN_MS, median * 1400));
        state.lastT = p.t; state.lastFixMs = performance.now(); state.lastLat = p.lat; state.lastLon = p.lon;
        const when = Cesium.JulianDate.fromDate(new Date(p.t * 1000));
        position.addSample(when, Cesium.Cartesian3.fromDegrees(p.lon, p.lat, 0));
        state.mph = Number(p.mph) || 0;
        if (Number.isFinite(p.heading) && state.mph >= MIN_SPEED_MPH) state.heading = p.heading;
        marker.show = true;
      }
    } catch {
      /* the deck app is away; keep the last samples */
    }
  }
  setInterval(poll, POLL_MS); poll();

  const scratch = new Cesium.Cartesian3();
  const hpr = new Cesium.HeadingPitchRange();
  let lastFrameMs = 0;
  function frame() {
    const mode = state.mode;
    if (!state.fix || (mode !== 'chase' && mode !== 'top')) return;
    if (performance.now() - state.lastFixMs > 15000) return;          // no fix for 15 s: let go of the camera
    const now = Cesium.JulianDate.addSeconds(Cesium.JulianDate.now(), -state.lagMs / 1000, new Cesium.JulianDate());
    const pos = position.getValue(now, scratch);
    if (!pos) return;
    viewer.camera.cancelFlight();
    const t = performance.now(), dt = lastFrameMs ? Math.min(0.5, (t - lastFrameMs) / 1000) : 0; lastFrameMs = t;
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
    viewer.camera.lookAt(pos, hpr);
  }
  scene.preRender.addEventListener(frame);
  // a view posted by the deck (layers, pins) must not leave the camera locked to the marker's frame
  globalThis.__deckFollow = { state, position, stop() { scene.preRender.removeEventListener(frame); viewer.camera.lookAtTransform(Cesium.Matrix4.IDENTITY); } };
  console.info('[cyberdeck] smooth follow ready');
}

main();
