'use strict';
/*
 * Pipeline enrichment (TX Railroad Commission). Loads data/layers/pipelines/rrc.ndjson,
 * splits MultiLineStrings into segments, flatbush-indexes them, and for each parcel computes:
 *   has_pipeline     1 if any pipeline crosses the parcel polygon (exact, booleanIntersects)
 *   pipeline_active  1 if a crossing pipeline is "In Service"
 *   pipeline_info    distinct commodities of crossing pipeline(s)
 *   pipeline_dist_ft 0 if crossing; else distance from the parcel's interior point to the nearest
 *                    pipeline within ~440m (approximate, from rep point); null if none nearby
 */
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { CANDIDATE_SQL } = require('../services/candidate');
const Flatbush = require('flatbush');
const turf = require('@turf/turf');

const ROOT = path.join(__dirname, '..');
const NDJSON = path.join(ROOT, 'data', 'layers', 'pipelines', 'rrc.ndjson');
const DB_PATH = path.join(ROOT, 'db', 'parcels.db');
const SEARCH_DEG = 0.004; // ~440m radius for nearest-pipeline distance

function load() {
  const lines = fs.readFileSync(NDJSON, 'utf8').split('\n');
  const parts = []; // { feat, active, co }
  for (const l of lines) {
    if (!l) continue;
    const o = JSON.parse(l);
    if (!o.g) continue;
    const active = o.st === 'In Service';
    const co = (o.co || '').trim();
    if (o.g.type === 'LineString') parts.push({ feat: turf.feature(o.g), active, co });
    else if (o.g.type === 'MultiLineString') for (const seg of o.g.coordinates) parts.push({ feat: turf.lineString(seg), active, co });
  }
  const idx = new Flatbush(parts.length);
  for (const p of parts) { const b = turf.bbox(p.feat); idx.add(b[0], b[1], b[2], b[3]); }
  idx.finish();
  return { parts, idx };
}

function main() {
  console.time('pipelines');
  const { parts, idx } = load();
  console.log('pipeline segments indexed:', parts.length);

  const db = new Database(DB_PATH);
  const cols = db.prepare('PRAGMA table_info(parcels)').all().map((c) => c.name);
  if (!cols.includes('pipeline_active')) db.exec('ALTER TABLE parcels ADD COLUMN pipeline_active INTEGER');
  if (!cols.includes('pipeline_info')) db.exec('ALTER TABLE parcels ADD COLUMN pipeline_info TEXT');

  const rows = db.prepare(`SELECT id, geom_json, rep_lat, rep_lng FROM parcels WHERE ${CANDIDATE_SQL}`).all();
  const upd = db.prepare('UPDATE parcels SET has_pipeline=?, pipeline_active=?, pipeline_info=?, pipeline_dist_ft=? WHERE id=?');
  let crossing = 0, active = 0, near = 0, done = 0;

  const tx = db.transaction((items) => {
    for (const r of items) {
      let has = 0, act = 0, info = null, dist = null;
      try {
        const pf = turf.feature(JSON.parse(r.geom_json));
        const b = turf.bbox(pf);
        const cand = idx.search(b[0], b[1], b[2], b[3]);
        const labels = new Set();
        for (const ci of cand) {
          if (turf.booleanIntersects(pf, parts[ci].feat)) { has = 1; if (parts[ci].active) act = 1; if (parts[ci].co) labels.add(parts[ci].co); }
        }
        if (has) { dist = 0; info = Array.from(labels).slice(0, 3).join(', ') || null; }
        else {
          const c2 = idx.search(b[0] - SEARCH_DEG, b[1] - SEARCH_DEG, b[2] + SEARCH_DEG, b[3] + SEARCH_DEG);
          if (c2.length && r.rep_lat != null && r.rep_lng != null) {
            const rp = turf.point([r.rep_lng, r.rep_lat]);
            let minFt = Infinity;
            for (const ci of c2) { const d = turf.pointToLineDistance(rp, parts[ci].feat, { units: 'feet' }); if (d < minFt) minFt = d; }
            if (Number.isFinite(minFt)) dist = Math.round(minFt);
          }
        }
      } catch (e) { /* leave defaults */ }
      upd.run(has, has ? act : null, info, dist, r.id);
      if (has) { crossing++; if (act) active++; } else if (dist != null) near++;
      if (++done % 5000 === 0) console.log(`  ${done}/${rows.length}`);
    }
  });
  tx(rows);
  db.close();

  console.log('\nparcels with a pipeline crossing:', crossing, `(active: ${active})`);
  console.log('parcels (no crossing) with a pipeline within ~440m:', near);
  console.timeEnd('pipelines');
}
main();
