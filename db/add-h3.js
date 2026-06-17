'use strict';
/*
 * Precompute each parcel's H3 cell at several resolutions into the parcels table so the web app
 * can render hex-bin choropleths via a plain GROUP BY (no per-request binning). One-time / re-runnable
 * after a parcel re-ingest. Cells are derived from the validated interior point (rep_lat/rep_lng),
 * falling back to the delivered source point. Idempotent: adds columns only if missing, then refills.
 *
 * Resolution guide (H3): r5 ~edge 8.5km (full-MSA view) · r6 ~3.2km · r7 ~1.2km · r8 ~0.46km (county zoom).
 * The frontend picks a resolution by zoom level. See enrich/ for the style this mirrors.
 */
const path = require('path');
const Database = require('better-sqlite3');
const h3 = require('h3-js');

const RES = [5, 6, 7, 8];
const DB_PATH = path.join(__dirname, 'parcels.db');

const db = new Database(DB_PATH);
const t0 = Date.now();

// Add h3_rN columns if they don't already exist.
const existing = new Set(db.prepare('PRAGMA table_info(parcels)').all().map((c) => c.name));
for (const r of RES) {
  const col = `h3_r${r}`;
  if (!existing.has(col)) db.prepare(`ALTER TABLE parcels ADD COLUMN ${col} TEXT`).run();
}

const rows = db.prepare('SELECT id, rep_lat, rep_lng, src_lat, src_lng FROM parcels').all();
const setStmt = db.prepare(
  `UPDATE parcels SET ${RES.map((r) => `h3_r${r}=@h3_r${r}`).join(', ')} WHERE id=@id`
);

let filled = 0;
let skipped = 0;
const fill = db.transaction((all) => {
  for (const row of all) {
    const lat = row.rep_lat ?? row.src_lat;
    const lng = row.rep_lng ?? row.src_lng;
    if (lat == null || lng == null || !Number.isFinite(lat) || !Number.isFinite(lng)) {
      skipped++;
      continue;
    }
    const params = { id: row.id };
    for (const r of RES) params[`h3_r${r}`] = h3.latLngToCell(lat, lng, r);
    setStmt.run(params);
    filled++;
  }
});
fill(rows);

for (const r of RES) {
  db.prepare(`CREATE INDEX IF NOT EXISTS parcels_h3_r${r} ON parcels(h3_r${r})`).run();
}

console.log(`Filled ${filled} parcels${skipped ? `, skipped ${skipped} (no coords)` : ''} in ${((Date.now() - t0) / 1000).toFixed(1)}s.`);
for (const r of RES) {
  const n = db.prepare(`SELECT COUNT(DISTINCT h3_r${r}) n FROM parcels`).get().n;
  console.log(`  res ${r}: ${n} distinct hex cells`);
}
db.close();
