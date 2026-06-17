'use strict';
/*
 * Highway distance enrichment (ported from Land Map's compute-freeway-distances.js).
 * For each parcel rep point, find the nearest of the 14 Houston freeways and the straight-line
 * distance in miles. flatbush.neighbors() prefilters to the ~50 nearest segment bboxes so we only
 * run exact turf.nearestPointOnLine on those. Writes nearest_freeway, freeway_mi.
 */
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { CANDIDATE_SQL } = require('../services/candidate');
const Flatbush = require('flatbush');
const turf = require('@turf/turf');

const ROOT = path.join(__dirname, '..');
const FW = path.join(ROOT, 'data', 'layers', 'freeways', 'houston-freeways.geojson');
const DB_PATH = path.join(ROOT, 'db', 'parcels.db');

const fc = JSON.parse(fs.readFileSync(FW, 'utf8'));
const segs = [];
for (const f of fc.features) {
  const name = f.properties.name, g = f.geometry;
  if (g.type === 'LineString') segs.push({ name, line: turf.lineString(g.coordinates) });
  else if (g.type === 'MultiLineString') for (const c of g.coordinates) segs.push({ name, line: turf.lineString(c) });
}
const idx = new Flatbush(segs.length);
for (const s of segs) { const b = turf.bbox(s.line); idx.add(b[0], b[1], b[2], b[3]); }
idx.finish();

function nearest(lat, lng) {
  const cand = idx.neighbors(lng, lat, 50); // 50 nearest segment bboxes, then exact-check
  const pt = turf.point([lng, lat]);
  let best = Infinity, name = null;
  for (const ci of cand) {
    const snapped = turf.nearestPointOnLine(segs[ci].line, pt, { units: 'miles' });
    if (snapped.properties.dist < best) { best = snapped.properties.dist; name = segs[ci].name; }
  }
  return { name, mi: Number.isFinite(best) ? Math.round(best * 100) / 100 : null };
}

function main() {
  console.time('highway');
  console.log('freeway segments:', segs.length);
  const db = new Database(DB_PATH);
  const rows = db.prepare(`SELECT id, rep_lat, rep_lng FROM parcels WHERE ${CANDIDATE_SQL}`).all();
  const upd = db.prepare('UPDATE parcels SET nearest_freeway=?, freeway_mi=? WHERE id=?');
  let done = 0;
  const tx = db.transaction((items) => {
    for (const r of items) {
      const n = nearest(r.rep_lat, r.rep_lng);
      upd.run(n.name, n.mi, r.id);
      if (++done % 10000 === 0) console.log(`  ${done}/${rows.length}`);
    }
  });
  tx(rows);
  db.close();
  console.timeEnd('highway');
}
main();
