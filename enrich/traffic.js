'use strict';
/*
 * Traffic enrichment (TxDOT AADT). Loads data/layers/traffic/aadt.ndjson, flatbush-indexes the segments, and
 * per candidate parcel computes TWO signals from the same segment scan:
 *
 *   frontage_aadt  MAX AADT among segments within ~50m (BUFFER_M) of the parcel — "busiest road the parcel
 *   frontage_road  fronts / sits on". NULL if no AADT road within 50m.
 *
 *   near_road_frontier  The "closest road at each busyness level" STAIRCASE (Pareto frontier) of main roads
 *                       within NEAR_ROAD_CAP_FT of the parcel EDGE — a JSON array of [ft, aadt, name], sorted
 *                       by distance, keeping a road only if it is BUSIER than every closer road (so a road that
 *                       is both farther AND not busier than one already kept is dropped — useless for any
 *                       filter). This lets "a road >= Y AADT within <= X ft" be answered EXACTLY for ANY X,Y
 *                       (services/geo.js oml_near_road UDF): a 10k road at 600ft is still found when you ask for
 *                       700ft even though a 20k road sits at 1500ft. Typically 1-4 entries (capped at FRONTIER_MAX).
 *   near_road_ft        Convenience scalars = the NEAREST main road (frontier[0]) for display. The TxDOT AADT
 *   near_road_aadt      network is counted/on-system roads only (residential side streets excluded), so "nearest
 *   near_road_name      AADT road" = the nearest MAIN road you'd turn off of.
 *
 * NULL is stored as-is; the UI decides whether to include null parcels.
 */
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { CANDIDATE_SQL } = require('../services/candidate');
const Flatbush = require('flatbush');
const turf = require('@turf/turf');

const ROOT = path.join(__dirname, '..');
const NDJSON = path.join(ROOT, 'data', 'layers', 'traffic', 'aadt.ndjson');
const DB_PATH = path.join(ROOT, 'db', 'parcels.db');
const BUFFER_M = 50;             // frontage buffer (~164 ft)
const NEAR_ROAD_CAP_FT = 2640;   // 1/2 mile: max stored distance to a main road. Filter at any value <= this;
                                 // raising it is purely additive (only adds farther parcels, never changes closer ones).
const FRONTIER_MAX = 24;         // hard cap on staircase entries. Real staircases run ~1-4 (max observed 8 over
                                 // 97k parcels, geometric decay), so 24 is far above any real case and never
                                 // truncates the busiest entry — it only guards a pathological dense interchange.
const FT_PER_DEG_LAT = 364000;   // ~ feet per degree latitude (110540 m * 3.28084)

function roadName(p, n, rn) {
  p = (p || '').toString().trim();
  n = (n || '').toString().trim();
  if (p && n) return `${p} ${n}`;
  return (rn || '').toString().trim() || null;
}

function load() {
  const lines = fs.readFileSync(NDJSON, 'utf8').split('\n');
  const segs = [];
  for (const l of lines) {
    if (!l) continue;
    const o = JSON.parse(l);
    if (!o.g || o.g.type !== 'LineString' || !(o.a > 0)) continue;
    segs.push({ feat: turf.feature(o.g), aadt: o.a, name: roadName(o.p, o.n, o.rn) });
  }
  const idx = new Flatbush(segs.length);
  for (const s of segs) { const b = turf.bbox(s.feat); idx.add(b[0], b[1], b[2], b[3]); }
  idx.finish();
  return { segs, idx };
}

function ensureCols(db) {
  const have = new Set(db.prepare('PRAGMA table_info(parcels)').all().map((c) => c.name));
  if (!have.has('near_road_ft')) db.prepare('ALTER TABLE parcels ADD COLUMN near_road_ft INTEGER').run();
  if (!have.has('near_road_aadt')) db.prepare('ALTER TABLE parcels ADD COLUMN near_road_aadt INTEGER').run();
  if (!have.has('near_road_name')) db.prepare('ALTER TABLE parcels ADD COLUMN near_road_name TEXT').run();
  if (!have.has('near_road_frontier')) db.prepare('ALTER TABLE parcels ADD COLUMN near_road_frontier TEXT').run();
}

// All outer-ring boundary points of a (Multi)Polygon, DENSIFIED so consecutive points are <= maxFt apart
// (equirectangular approx). Densifying long edges makes edge-to-road distance accurate: a road touching the
// MIDDLE of a long parcel edge would otherwise be mis-measured to a far corner vertex (badly overestimated on
// big parcels). Covers every polygon of a MultiPolygon, so distance is consistent with the frontage buffer.
function boundaryPoints(geom, maxFt) {
  const polys = geom.type === 'Polygon' ? [geom.coordinates]
    : geom.type === 'MultiPolygon' ? geom.coordinates : [];
  const out = [];
  for (const poly of polys) {
    const ring = poly && poly[0];
    if (!ring || ring.length < 4) continue;
    for (let i = 0; i < ring.length - 1; i++) {
      const a = ring[i], b = ring[i + 1];
      out.push(a);
      const latMid = (a[1] + b[1]) / 2;
      const dx = (b[0] - a[0]) * FT_PER_DEG_LAT * Math.cos(latMid * Math.PI / 180);
      const dy = (b[1] - a[1]) * FT_PER_DEG_LAT;
      const len = Math.sqrt(dx * dx + dy * dy);
      const n = Math.floor(len / maxFt); // interior points to insert on this edge
      for (let k = 1; k <= n; k++) { const t = k / (n + 1); out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]); }
    }
  }
  return out;
}

// Build the staircase: sort candidate (dist,aadt,name) by distance asc (busier first on ties), keep a road only
// when it beats the busiest seen at any closer distance. Result is a short increasing-AADT frontier.
function buildFrontier(pts) {
  pts.sort((a, b) => a.d - b.d || b.aadt - a.aadt);
  const fr = [];
  let bestA = -1;
  for (const p of pts) {
    if (p.aadt > bestA) { fr.push([Math.round(p.d), p.aadt, p.name]); bestA = p.aadt; if (fr.length >= FRONTIER_MAX) break; }
  }
  return fr;
}

function main() {
  console.time('traffic');
  const { segs, idx } = load();
  console.log('AADT segments indexed:', segs.length);

  const db = new Database(DB_PATH);
  ensureCols(db);
  const rows = db.prepare(`SELECT id, geom_json FROM parcels WHERE ${CANDIDATE_SQL}`).all();
  const upd = db.prepare('UPDATE parcels SET frontage_aadt=?, frontage_road=?, near_road_ft=?, near_road_aadt=?, near_road_name=?, near_road_frontier=? WHERE id=?');
  let withFront = 0, withNear = 0, multi = 0, maxLen = 0, done = 0;

  const tx = db.transaction((items) => {
    for (const r of items) {
      let aadt = null, fname = null, nearFt = null, nearAadt = null, nearName = null, frJson = null;
      try {
        const geom = JSON.parse(r.geom_json);
        const pf = turf.feature(geom);

        // --- frontage: busiest road within 50m of the parcel ---
        let probe = pf;
        try { const buf = turf.buffer(pf, BUFFER_M, { units: 'meters' }); if (buf) probe = buf; } catch (e) { /* unbuffered */ }
        const fb = turf.bbox(probe);
        let best = -1;
        for (const ci of idx.search(fb[0], fb[1], fb[2], fb[3])) {
          if (segs[ci].aadt > best && turf.booleanIntersects(probe, segs[ci].feat)) { best = segs[ci].aadt; fname = segs[ci].name; }
        }
        if (best >= 0) aadt = best;

        // --- nearby main roads: collect every AADT road within the cap of the parcel EDGE, build the staircase ---
        const bpts = boundaryPoints(geom, 75); // densified boundary so edge-to-road distance is accurate
        if (bpts.length) {
          const b = turf.bbox(pf);
          const latMid = (b[1] + b[3]) / 2;
          const padLat = NEAR_ROAD_CAP_FT / FT_PER_DEG_LAT;
          const padLng = NEAR_ROAD_CAP_FT / (FT_PER_DEG_LAT * Math.max(0.2, Math.cos(latMid * Math.PI / 180)));
          const sb = [b[0] - padLng, b[1] - padLat, b[2] + padLng, b[3] + padLat]; // bbox-search padded by cap = complete
          const pts = [];
          for (const ci of idx.search(sb[0], sb[1], sb[2], sb[3])) {
            const line = segs[ci].feat;
            let d = Infinity;
            for (const p of bpts) { const dk = turf.pointToLineDistance(p, line, { units: 'feet' }); if (dk < d) d = dk; }
            if (d <= NEAR_ROAD_CAP_FT) pts.push({ d, aadt: segs[ci].aadt, name: segs[ci].name });
          }
          const fr = buildFrontier(pts);
          if (fr.length) {
            frJson = JSON.stringify(fr);
            nearFt = fr[0][0]; nearAadt = fr[0][1]; nearName = fr[0][2]; // nearest main road = frontier[0]
            if (fr.length > 1) multi++;
            if (fr.length > maxLen) maxLen = fr.length;
          }
        }
      } catch (e) { /* leave nulls */ }
      upd.run(aadt, fname, nearFt, nearAadt, nearName, frJson, r.id);
      if (aadt != null) withFront++;
      if (nearFt != null) withNear++;
      if (++done % 5000 === 0) console.log(`  ${done}/${rows.length}`);
    }
  });
  tx(rows);
  db.close();

  console.log('\nparcels with frontage AADT (<=50m):', withFront);
  console.log(`parcels with >=1 main road within ${NEAR_ROAD_CAP_FT}ft:`, withNear);
  console.log(`  of those, with >1 road on the staircase: ${multi}; longest staircase: ${maxLen} (cap ${FRONTIER_MAX})`);
  console.timeEnd('traffic');
}
main();
