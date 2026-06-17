'use strict';
/*
 * Backfill parcel shape metrics for every parcel:
 *   width_mean_ft = 2 * Area / Perimeter            (average width, ft — catches road networks)
 *   elongation    = max over significant parts (>=10% area) of  Perimeter^2 / (4 * Area)
 *                   This per-part perimeter ratio is the robust corridor/sliver detector:
 *                   - curvature-robust (a winding road still reads high; oriented-rect under-reads curves)
 *                   - multipart-robust (a MultiPolygon of scattered slivers reads high; whole-hull masks it)
 *                   Real compact/wiggly tracts sit <=25; true roads/corridors >=33, so a cutoff ~30 separates.
 * One-time / re-runnable. Run after each county ingest.
 */
const path = require('path');
const Database = require('better-sqlite3');
const turf = require('@turf/turf');

// width_mean_ft over the full (Multi)Polygon
function meanWidthFt(f) {
  const area = turf.area(f);
  const perim = turf.length(turf.polygonToLine(f), { units: 'meters' });
  return perim > 0 && area > 0 ? Math.round((2 * area / perim) * 3.28084 * 10) / 10 : null;
}
// elongation = max per-part Perimeter^2/(4*Area), over parts that are >=10% of total area
function elongationMetric(g) {
  const polys = g.type === 'MultiPolygon' ? g.coordinates : g.type === 'Polygon' ? [g.coordinates] : [];
  if (!polys.length) return null;
  const parts = polys.map((poly) => {
    const ring = poly[0];
    const area = turf.area(turf.polygon([ring]));
    const perim = turf.length(turf.lineString(ring), { units: 'meters' });
    return { area, ratio: area > 0 ? (perim * perim) / (4 * area) : 0 };
  });
  const total = parts.reduce((s, p) => s + p.area, 0) || 1;
  let best = 1;
  for (const p of parts) { if (p.area < 0.10 * total) continue; if (p.ratio > best) best = p.ratio; }
  return Math.round(best * 10) / 10;
}

const db = new Database(path.join(__dirname, 'parcels.db'));
const cols = new Set(db.prepare('PRAGMA table_info(parcels)').all().map((c) => c.name));
if (!cols.has('width_mean_ft')) db.prepare('ALTER TABLE parcels ADD COLUMN width_mean_ft REAL').run();
if (!cols.has('elongation')) db.prepare('ALTER TABLE parcels ADD COLUMN elongation REAL').run();

const rows = db.prepare('SELECT id, geom_json FROM parcels WHERE geom_json IS NOT NULL').all();
const upd = db.prepare('UPDATE parcels SET width_mean_ft = ?, elongation = ? WHERE id = ?');
let done = 0;
const t0 = Date.now();
const tx = db.transaction((items) => {
  for (const r of items) {
    let mw = null, el = null;
    try {
      const g = JSON.parse(r.geom_json);
      mw = meanWidthFt(turf.feature(g));
      el = elongationMetric(g);
    } catch (e) { /* leave null */ }
    upd.run(mw, el, r.id);
    if (++done % 10000 === 0) console.log(`  ${done}/${rows.length}`);
  }
});
tx(rows);
db.prepare('CREATE INDEX IF NOT EXISTS parcels_width_mean ON parcels(width_mean_ft)').run();
db.prepare('CREATE INDEX IF NOT EXISTS parcels_elongation ON parcels(elongation)').run();
console.log(`shape metrics filled for ${done} parcels in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
db.close();
