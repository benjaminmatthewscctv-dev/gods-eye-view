import * as Cesium from 'cesium';
import { showOsmCredit, hideOsmCredit } from '../data/dataCredits.js';

/**
 * World-space annotation renderer (Direction A).
 *
 * Draws annotations as native Cesium entities anchored to lon/lat. Because they
 * live in the 3D scene they track the camera, sit at the right depth, and are
 * occluded by the photoreal buildings the way a real marker would be.
 *
 * IMPORTANT — drawing on Google Photorealistic 3D Tiles:
 *   The Cesium globe is hidden, so there is no terrain to clamp to. Ground
 *   geometry (areas, rings, connectors) is draped onto the photoreal tiles with
 *   `classificationType: CESIUM_3D_TILE`; points clamp to the tile
 *   surface with `heightReference: CLAMP_TO_GROUND` (which requires the tileset
 *   to have `enableCollision = true`, set in initAnnotations). This keeps marks
 *   sitting ON the world instead of buried at sea level.
 *
 * Live alpha (fade in/out) and pulsing are driven by CallbackProperty so they
 * animate every render without the engine touching them per frame.
 *
 * Renderer contract (shared with the screen-space renderer):
 *   add(anno) / remove(anno) / sync(map) / destroy()
 */

const PALETTE = {
  primary: '#8be9ff',
  amber: '#ffb547',
  cyan: '#39d0ff',
  green: '#5dff9f',
  red: '#ff6b6b',
};

/**
 * What a draped mark is allowed to paint onto.
 *
 * This was CESIUM_3D_TILE, which is right with Google's photoreal tiles under
 * the camera and wrong everywhere else: on a keyless boot (Esri or OSM imagery
 * on Cesium's own globe) there are no 3D tiles to classify against, so every
 * area fill, area outline, route and arrow rendered to nothing. The labels
 * showed and the geometry did not, which reads as a broken feature rather than
 * an unsupported surface — and it hit spoken annotations exactly as hard as
 * hand-drawn ones.
 *
 * BOTH paints onto terrain AND onto 3D tiles, so one value covers both worlds.
 */
const CLASSIFY = Cesium.ClassificationType.BOTH;
const CLAMP = Cesium.HeightReference.CLAMP_TO_GROUND;

export function createWorldAnnotationRenderer(viewer) {
  const dataSource = new Cesium.CustomDataSource('gev-annotations');
  viewer.dataSources.add(dataSource);
  const osmAnnotations = new Set();

  // Register the GevRouteFlow fabric once so Cesium's Material.fromType() can build the
  // material the route pipeline renders. The animated `time` uniform is read straight
  // from performance.now() inside FlowMaterialProperty.getValue (which Cesium calls each
  // rendered frame with the live uniforms object), so the dashes flow with no extra
  // per-frame bookkeeping.
  ensureFlowFabricRegistered();

  function colorFor(anno) {
    return Cesium.Color.fromCssColorString(
      PALETTE[anno.color] || PALETTE.primary,
    );
  }

  // Target-ring radius (meters) scaled to camera height so it reads at any
  // altitude. Read once per frame for BOTH ellipse axes — camera height is
  // constant within a frame, so semiMajor === semiMinor always holds.
  function ringRadius() {
    const h = viewer.camera.positionCartographic?.height ?? 1000;
    return Math.max(14, Math.min(170, h * 0.03));
  }

  // A live color that follows the annotation's fade alpha and an optional pulse.
  function liveColor(anno, base, { alpha = 0.9, pulse = false } = {}) {
    return new Cesium.CallbackProperty(() => {
      const a = (anno.alpha ?? 1) * alpha * (pulse ? pulseFactor() : 1);
      return base.withAlpha(Math.max(0, Math.min(1, a)));
    }, false);
  }

  function add(anno) {
    const base = colorFor(anno);
    // Published to the mark BEFORE anything is added, and mutated in place as
    // each entity lands: a mid-add failure (bad geometry, lost context) must
    // leave the entities that DID land visible to remove(), or the rollback
    // path cannot reach them and they stay on the globe forever.
    const entities = [];
    anno._entities = entities;

    if (
      anno.ring &&
      anno.ring.length >= 3 &&
      anno.footprintKind === 'building'
    ) {
      // Single building → the PRIMARY highlight is an extruded CLASSIFICATION
      // volume that tints the real photogrammetry mesh (dome, walls, roof —
      // everything inside the column) amber and pulses. A flat footprint
      // extrusion is only 2.5D and misses domes; classification colors the
      // actual tiles. A faint wireframe cage rides on top as a secondary cue.
      const buffered = bufferRing(anno.ring, 3);
      const positions = Cesium.Cartesian3.fromDegreesArray(buffered.flat());
      const groundH =
        sampleGroundOutside(viewer.scene, anno.ring) ??
        (Number.isFinite(anno.anchor.height)
          ? anno.anchor.height - (anno.buildingHeight || 25)
          : 0);
      const baseH = groundH - 3;
      // Tall headroom is free: classification only colors where tiles exist, so
      // empty air above the roof isn't tinted — this just guarantees we cover
      // under-tagged building heights.
      const topH = groundH + Math.max(18, anno.buildingHeight || 25) + 24;
      // 1) Classification volume — tints the mesh amber, pulsing.
      entities.push(
        dataSource.entities.add({
          polygon: {
            hierarchy: new Cesium.PolygonHierarchy(positions),
            height: baseH,
            extrudedHeight: topH,
            perPositionHeight: false,
            classificationType: CLASSIFY,
            material: new Cesium.ColorMaterialProperty(
              liveColor(anno, base, { alpha: 0.45, pulse: true }),
            ),
          },
        }),
      );
      // 2) Faint, SIMPLIFIED wireframe cage — secondary, lower opacity. Decimate
      // the footprint so the extruded outline draws ~14 clean verticals, not one
      // per (often 100+) ring vertex.
      const cagePositions = Cesium.Cartesian3.fromDegreesArray(
        decimateRing(buffered, 14).flat(),
      );
      entities.push(
        dataSource.entities.add({
          polygon: {
            hierarchy: new Cesium.PolygonHierarchy(cagePositions),
            height: baseH,
            extrudedHeight: topH,
            perPositionHeight: false,
            fill: false,
            outline: true,
            outlineColor: liveColor(anno, base, { alpha: 0.32, pulse: true }),
          },
        }),
      );
      // 3) Crisp draped base outline so the footprint reads on the ground.
      entities.push(
        dataSource.entities.add({
          polyline: {
            positions,
            width: 3,
            material: new Cesium.PolylineGlowMaterialProperty({
              glowPower: 0.25,
              color: liveColor(anno, base, { alpha: 0.7 }),
            }),
            clampToGround: true,
            classificationType: CLASSIFY,
          },
        }),
      );
    } else if (anno.ring && anno.ring.length >= 3) {
      // Larger area (district / compound / park / state) → flat fill draped on
      // the tiles + a glowing outline. Draping is right here: you can't extrude
      // a whole neighbourhood, and the GIS overlay shows the boundary clearly.
      // A multi-part outline (`anno.polygons`: Hawaii's islands, Berlin as a
      // hole in Brandenburg) draws every part with its holes. All parts share
      // ONE fill and ONE line material, so Cesium batches the whole mark into a
      // ground primitive per kind instead of one per island.
      const parts =
        Array.isArray(anno.polygons) && anno.polygons.length
          ? anno.polygons
          : [[anno.ring]];
      const fillMaterial = new Cesium.ColorMaterialProperty(
        // Synthesized (approximate) areas get a fainter fill so they don't read as solid.
        liveColor(anno, base, {
          alpha: anno.synthesized ? 0.1 : 0.2,
          pulse: true,
        }),
      );
      // Synthesized → DASHED outline (signals "approximate, not an authoritative
      // boundary", research §8.4/§8.6); real footprints → solid glow.
      const lineMaterial = anno.synthesized
        ? new Cesium.PolylineDashMaterialProperty({
            color: liveColor(anno, base, { alpha: 0.95 }),
            dashLength: 24,
          })
        : new Cesium.PolylineGlowMaterialProperty({
            glowPower: 0.35,
            color: liveColor(anno, base, { alpha: 1 }),
          });
      for (const [outer, ...holes] of parts) {
        if (!Array.isArray(outer) || outer.length < 3) continue;
        const rings = [outer, ...holes.filter((h) => h?.length >= 3)];
        entities.push(
          dataSource.entities.add({
            polygon: {
              hierarchy: new Cesium.PolygonHierarchy(
                Cesium.Cartesian3.fromDegreesArray(outer.flat()),
                rings
                  .slice(1)
                  .map(
                    (hole) =>
                      new Cesium.PolygonHierarchy(
                        Cesium.Cartesian3.fromDegreesArray(hole.flat()),
                      ),
                  ),
              ),
              material: fillMaterial,
              classificationType: CLASSIFY,
            },
          }),
        );
        for (const ring of rings) {
          entities.push(
            dataSource.entities.add({
              polyline: {
                positions: Cesium.Cartesian3.fromDegreesArray(
                  closedRing(ring).flat(),
                ),
                width: 6,
                material: lineMaterial,
                clampToGround: true,
                classificationType: CLASSIFY,
              },
            }),
          );
        }
      }
    } else if (
      anno.type === 'route' &&
      Array.isArray(anno.path) &&
      anno.path.length >= 2
    ) {
      // A real path (street-following) draped on the 3D tiles, with dashes that
      // FLOW toward the destination (custom st.s + time material; works on the
      // clamped/classified ground polyline).
      const positions = Cesium.Cartesian3.fromDegreesArray(
        anno.path.flatMap((p) => [p.lon, p.lat]),
      );
      if (globalThis.__gevEmbed) {
        // cyberdeck branch (embedded on the deck's Pi 5): a 126 km draped route with the flowing dash material made the
        // follow camera stutter while navigating (smooth with no route). Here only the stretch around the deck is draped
        // (DECK_AHEAD_M ahead, DECK_BEHIND_M behind, re-cut when the deck has moved DECK_RECUT_M along it) and it reads as
        // a PROGRESS BAR (owner 2026-10-20): orange ahead, light amber for the road already driven, split exactly at the
        // deck's position projected on the route - one uniform per frame, the geometry is not rebuilt as the split moves.
        // Without a deck position the whole route is drawn orange.
        const entity = dataSource.entities.add({
          polyline: {
            positions,
            width: 8,
            material: new ProgressMaterialProperty(anno),
            clampToGround: true,
            classificationType: CLASSIFY,
          },
        });
        entities.push(entity);
        deckTrimRoute(anno, entity);
      } else
      entities.push(
        dataSource.entities.add({
          polyline: {
            positions,
            width: 9,
            material: new FlowMaterialProperty(
              PALETTE[anno.color] || PALETTE.primary,
            ),
            clampToGround: true,
            classificationType: CLASSIFY,
          },
        }),
      );
      osmAnnotations.add(anno);
      showOsmCredit(viewer, anno);
    } else if (anno.type === 'arrow' && anno.to) {
      // Connector draped across the ground from origin to destination.
      const positions = [
        Cesium.Cartesian3.fromDegrees(anno.anchor.lon, anno.anchor.lat),
        Cesium.Cartesian3.fromDegrees(anno.to.lon, anno.to.lat),
      ];
      entities.push(
        dataSource.entities.add({
          polyline: {
            positions,
            width: 16,
            material: new Cesium.PolylineArrowMaterialProperty(
              liveColor(anno, base, { alpha: 0.95 }),
            ),
            clampToGround: true,
            classificationType: CLASSIFY,
          },
        }),
      );
    } else {
      // pin / highlight / label — a camera-proportional target ring + a marker.
      if (anno.type !== 'label') {
        // Radius scales with camera height so the ring reads at any altitude.
        // semiMajor === semiMinor is required AND must hold every frame, so both
        // axes read the SAME ringRadius() (camera height is constant per frame).
        entities.push(
          dataSource.entities.add({
            position: Cesium.Cartesian3.fromDegrees(
              anno.anchor.lon,
              anno.anchor.lat,
            ),
            ellipse: {
              semiMajorAxis: new Cesium.CallbackProperty(ringRadius, false),
              semiMinorAxis: new Cesium.CallbackProperty(ringRadius, false),
              material: new Cesium.ColorMaterialProperty(
                liveColor(anno, base, { alpha: 0.38, pulse: true }),
              ),
              outline: false,
              classificationType: CLASSIFY,
            },
          }),
        );
      }
      entities.push(pointMarker(anno, base));
    }
  }

  // Captions belong to the hybrid renderer's screen-space callouts.
  function pointMarker(anno, base) {
    return dataSource.entities.add({
      position: Cesium.Cartesian3.fromDegrees(anno.anchor.lon, anno.anchor.lat),
      point: {
        pixelSize: anno.type === 'label' ? 8 : 14,
        color: liveColor(anno, base, { alpha: 1 }),
        outlineColor: liveColor(anno, Cesium.Color.WHITE, { alpha: 0.95 }),
        outlineWidth: 3,
        heightReference: CLAMP,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
    });
  }

  // cyberdeck branch: keep only the part of a route near the deck draped on the tiles (see the route branch in add)
  const DECK_AHEAD_M = 5000, DECK_BEHIND_M = 1500, DECK_RECUT_M = 250;
  function deckTrimRoute(anno, entity) {
    const pts = anno.path; const n = pts.length;
    const cum = new Float64Array(n);
    for (let i = 1; i < n; i++) {
      const dy = (pts[i].lat - pts[i - 1].lat) * 111320;
      const dx = (pts[i].lon - pts[i - 1].lon) * 111320 * Math.cos((pts[i].lat * Math.PI) / 180);
      cum[i] = cum[i - 1] + Math.hypot(dx, dy);
    }
    let lastAlong = -1e9, hint = 0;
    anno._deckWin = null;                                     // [along at the window start, along at its end] once cut
    // the deck's distance along the route, projected onto the nearest segment (continuous, so the split glides)
    anno._deckAlong = () => {
      const d = globalThis.__deckFollow?.state?.disp; if (!d) return null;
      const k = Math.cos((d.lat * Math.PI) / 180); let best = null, bd = Infinity;
      for (let i = Math.max(1, hint - 3); i < Math.min(n, hint + 4); i++) {
        const ax = pts[i - 1].lon * 111320 * k, ay = pts[i - 1].lat * 111320, bx = pts[i].lon * 111320 * k, by = pts[i].lat * 111320;
        const px = d.lon * 111320 * k, py = d.lat * 111320, vx = bx - ax, vy = by - ay, L2 = vx * vx + vy * vy || 1;
        const t = Math.max(0, Math.min(1, ((px - ax) * vx + (py - ay) * vy) / L2));
        const ex = ax + t * vx - px, ey = ay + t * vy - py, dd = ex * ex + ey * ey;
        if (dd < bd) { bd = dd; best = cum[i - 1] + t * (cum[i] - cum[i - 1]); }
      }
      return best;
    };
    const cut = () => {
      const d = globalThis.__deckFollow?.state?.disp;
      if (!d || !entity.polyline) return;
      // nearest route point, searched around the last match first (then everywhere if that is far off)
      const near = (lo, hi) => { let best = -1, bd = Infinity; for (let i = Math.max(0, lo); i < Math.min(n, hi); i++) {
        const dy = (pts[i].lat - d.lat) * 111320, dx = (pts[i].lon - d.lon) * 111320 * Math.cos((d.lat * Math.PI) / 180);
        const dd = dx * dx + dy * dy; if (dd < bd) { bd = dd; best = i; } } return [best, Math.sqrt(bd)]; };
      let [i, dist] = near(hint - 50, hint + 400);
      if (dist > 300) [i, dist] = near(0, n);
      if (i < 0) return;
      hint = i;
      const along = cum[i];
      if (Math.abs(along - lastAlong) < DECK_RECUT_M) return;
      lastAlong = along;
      let a = i, b = i;
      while (a > 0 && along - cum[a] < DECK_BEHIND_M) a--;
      while (b < n - 1 && cum[b] - along < DECK_AHEAD_M) b++;
      if (b - a < 1) return;
      entity.polyline.positions = Cesium.Cartesian3.fromDegreesArray(pts.slice(a, b + 1).flatMap((p) => [p.lon, p.lat]));
      anno._deckWin = [cum[a], cum[b]];
    };
    cut();
    anno._deckTrim = setInterval(cut, 1000);
  }

  function remove(anno) {
    if (anno?._deckTrim) { clearInterval(anno._deckTrim); anno._deckTrim = null; }
    hideOsmCredit(viewer, anno);
    osmAnnotations.delete(anno);
    if (!anno?._entities) return;
    for (const entity of anno._entities) {
      try {
        dataSource.entities.remove(entity);
      } catch {
        /* already gone */
      }
    }
    anno._entities = null;
  }

  function sync() {
    // No-op: CallbackProperty drives per-frame alpha/pulse animation.
  }

  function destroy() {
    for (const anno of osmAnnotations) hideOsmCredit(viewer, anno);
    osmAnnotations.clear();
    try {
      viewer.dataSources.remove(dataSource, true);
    } catch {
      /* scene torn down */
    }
  }

  return { add, remove, sync, destroy };
}

function pulseFactor() {
  // 0.6 .. 1.0 sinusoid at ~0.8 Hz
  return 0.8 + 0.2 * Math.sin(performance.now() * 0.005);
}

/**
 * A custom Fabric polyline material whose dashes flow toward the destination.
 * `materialInput.st.s` is the along-line coordinate (0 = origin, 1 = destination),
 * so `fract(s*repeat - time*speed)` scrolls the pattern toward the end. Works on
 * a clamped/classified ground polyline (PolylineMaterialAppearance supports it).
 */
function makeRouteFlowMaterial(colorCss) {
  return new Cesium.Material({
    fabric: {
      type: 'GevRouteFlow',
      uniforms: {
        color: Cesium.Color.fromCssColorString(colorCss).withAlpha(0.95),
        time: 0.0,
        repeat: 64.0, // dash cells along the whole route
        duty: 0.46, // fraction of each cell that is "on"
        speed: 0.55, // cells per second toward the destination
      },
      source: `
        czm_material czm_getMaterial(czm_materialInput materialInput) {
          czm_material m = czm_getDefaultMaterial(materialInput);
          float s = materialInput.st.s;                  // 0 origin -> 1 dest
          float flow = fract(s * repeat - time * speed); // scroll toward dest
          float on = smoothstep(duty + 0.08, duty - 0.08, flow);
          // keep a faint baseline so the whole route stays readable between dashes
          float a = max(on, 0.18);
          m.diffuse = color.rgb;
          m.emission = color.rgb * on * 0.9;             // glow on the lit cells
          m.alpha = color.a * a;
          return m;
        }`,
    },
  });
}

let _flowFabricRegistered = false;
/** Register the GevRouteFlow fabric ONCE so Cesium's `Material.fromType('GevRouteFlow')`
 *  can build the material the render pipeline uses. Constructing one Material with the
 *  fabric caches it under its type name. */
export function ensureFlowFabricRegistered() {
  if (_flowFabricRegistered) return;
  makeRouteFlowMaterial('#ffffff'); // side effect: registers the 'GevRouteFlow' type
  _flowFabricRegistered = true;
}

/**
 * MaterialProperty for the animated route. Cesium builds the rendered Material once
 * from getType() (our registered GevRouteFlow fabric), then EACH FRAME calls
 * getValue(time, material.uniforms) and uses whatever we write INTO that uniforms
 * object — it ignores the return value. So getValue writes color/time/repeat/duty/
 * speed straight onto `result` (the live uniforms). Writing the animated `time` here
 * is what actually makes the dashes flow on the GPU. (The prior versions either
 * returned a standalone Material Cesium never rendered, or treated `result` as a
 * Material — both left the real uniforms untouched, so nothing animated.)
 */
export function FlowMaterialProperty(colorCss) {
  this._color = Cesium.Color.fromCssColorString(colorCss).withAlpha(0.95);
  this._definitionChanged = new Cesium.Event();
}
Object.defineProperties(FlowMaterialProperty.prototype, {
  isConstant: {
    get() {
      return false;
    },
  }, // re-evaluated each frame → it animates
  definitionChanged: {
    get() {
      return this._definitionChanged;
    },
  },
});
FlowMaterialProperty.prototype.getType = function getType() {
  return 'GevRouteFlow';
};
FlowMaterialProperty.prototype.getValue = function getValue(time, result) {
  // `result` IS the live uniforms object Cesium renders — write into it directly.
  // `time` is read straight from the wall clock so the dashes flow every rendered
  // frame (the scene renders continuously; no requestRenderMode here).
  if (!Cesium.defined(result)) result = {};
  result.color = this._color;
  result.time = performance.now() / 1000; // the per-frame animated value
  result.repeat = 64.0;
  result.duty = 0.46;
  result.speed = 0.55;
  return result;
};
FlowMaterialProperty.prototype.equals = function equals(other) {
  return this === other;
};


// cyberdeck branch: the route as a progress bar - st.s runs 0 -> 1 along the drawn polyline; everything before `split` is the
// road already driven (light amber), everything after is still ahead (orange). The split is the deck's own position.
const PROGRESS_AHEAD = Cesium.Color.fromCssColorString('#ff8c1a').withAlpha(0.95);    // orange: still to drive
const PROGRESS_BEHIND = Cesium.Color.fromCssColorString('#ffd58a').withAlpha(0.75);   // light amber: already driven
let _progressFabricRegistered = false;
function ensureProgressFabricRegistered() {
  if (_progressFabricRegistered) return;
  new Cesium.Material({
    fabric: {
      type: 'GevRouteProgress',
      uniforms: { ahead: PROGRESS_AHEAD, behind: PROGRESS_BEHIND, split: -1.0 },
      source: `
        czm_material czm_getMaterial(czm_materialInput materialInput) {
          czm_material m = czm_getDefaultMaterial(materialInput);
          float s = materialInput.st.s;
          float w = smoothstep(split - 0.002, split + 0.002, s);   // 0 behind the deck, 1 ahead (a crisp edge)
          vec4 c = mix(behind, ahead, w);
          m.diffuse = c.rgb; m.emission = c.rgb * 0.35; m.alpha = c.a;
          return m;
        }`,
    },
  });
  _progressFabricRegistered = true;
}
export function ProgressMaterialProperty(anno) {
  ensureProgressFabricRegistered();
  this._anno = anno;
  this._definitionChanged = new Cesium.Event();
}
Object.defineProperties(ProgressMaterialProperty.prototype, {
  isConstant: { get() { return false; } },
  definitionChanged: { get() { return this._definitionChanged; } },
});
ProgressMaterialProperty.prototype.getType = function getType() { return 'GevRouteProgress'; };
ProgressMaterialProperty.prototype.getValue = function getValue(time, result) {
  if (!Cesium.defined(result)) result = {};
  result.ahead = PROGRESS_AHEAD;
  result.behind = PROGRESS_BEHIND;
  const win = this._anno._deckWin, along = this._anno._deckAlong ? this._anno._deckAlong() : null;
  result.split = win && along != null && win[1] > win[0] ? (along - win[0]) / (win[1] - win[0]) : -1.0;   // -1: all orange
  return result;
};
ProgressMaterialProperty.prototype.equals = function equals(other) { return this === other; };

/** The ring with its first vertex repeated at the end, so an outline closes. */
function closedRing(ring) {
  const first = ring[0];
  const last = ring[ring.length - 1];
  return first[0] === last[0] && first[1] === last[1] ? ring : [...ring, first];
}

/** Evenly down-sample a [[lon,lat],...] ring to at most n points (keeps shape). */
function decimateRing(ring, n) {
  if (ring.length <= n) return ring;
  const out = [];
  for (let i = 0; i < n; i++) out.push(ring[Math.floor((i * ring.length) / n)]);
  return out;
}

/**
 * Sample the ground height (m) just OUTSIDE a building footprint. Sampling at
 * the centroid would clamp onto the roof, so we probe several points beyond the
 * footprint radius and take a low percentile (≈ ground). Returns null if the
 * tiles under those points aren't loaded yet.
 */
function sampleGroundOutside(scene, ring) {
  if (
    !scene?.clampToHeightSupported ||
    typeof scene.clampToHeight !== 'function'
  )
    return null;
  let clon = 0;
  let clat = 0;
  for (const [lon, lat] of ring) {
    clon += lon;
    clat += lat;
  }
  clon /= ring.length;
  clat /= ring.length;
  const latS = 111320;
  const lonS = latS * Math.cos(Cesium.Math.toRadians(clat));
  let maxR = 0;
  for (const [lon, lat] of ring) {
    maxR = Math.max(maxR, Math.hypot((lon - clon) * lonS, (lat - clat) * latS));
  }
  const out = maxR * 1.5 + 12;
  const dirs = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
    [0.7, 0.7],
    [-0.7, -0.7],
    [0.7, -0.7],
    [-0.7, 0.7],
  ];
  const samples = [];
  for (const [dx, dy] of dirs) {
    const lon = clon + (dx * out) / lonS;
    const lat = clat + (dy * out) / latS;
    try {
      const c = scene.clampToHeight(Cesium.Cartesian3.fromDegrees(lon, lat, 0));
      if (c) {
        const h = Cesium.Cartographic.fromCartesian(c).height;
        if (Number.isFinite(h) && h > -430 && h < 9000) samples.push(h);
      }
    } catch {
      /* tile not ready */
    }
  }
  if (!samples.length) return null;
  samples.sort((a, b) => a - b);
  return samples[Math.floor(samples.length * 0.3)];
}

/**
 * Inflate a [[lon,lat],...] ring outward from its centroid by `meters`, so an
 * extruded building volume encloses the photogrammetry mesh instead of slicing
 * through its edges. Radial buffer — fine for compact building footprints.
 */
function bufferRing(ring, meters) {
  let clon = 0;
  let clat = 0;
  for (const [lon, lat] of ring) {
    clon += lon;
    clat += lat;
  }
  clon /= ring.length;
  clat /= ring.length;
  const latScale = 111320;
  const lonScale = latScale * Math.cos(Cesium.Math.toRadians(clat));
  return ring.map(([lon, lat]) => {
    const dx = (lon - clon) * lonScale;
    const dy = (lat - clat) * latScale;
    const d = Math.hypot(dx, dy) || 1;
    const k = (d + meters) / d;
    return [clon + (dx * k) / lonScale, clat + (dy * k) / latScale];
  });
}
