'use strict';
/*
 * Traffic enrichment (TxDOT AADT). Loads data/layers/traffic/aadt.ndjson, flatbush-indexes the
 * segments, and for each parcel buffers the polygon by ~50m and takes the MAX AADT among segments
 * intersecting the buffer ("busiest road on/adjacent to the parcel").
 *   frontage_aadt  MAX AADT_CUR within 50m of the parcel; NULL if no AADT road within 50m
 *   frontage_road  route name (PRFX + NBR, e.g. "FM 1093") of that busiest segment
 * NULL is stored as-is; UI decides whether to include null-traffic parcels (toggle).
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
const BUFFER_M = 50;

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

function main() {
  console.time('traffic');
  const { segs, idx } = load();
  console.log('AADT segments indexed:', segs.length);

  const db = new Database(DB_PATH);
  const rows = db.prepare(`SELECT id, geom_json FROM parcels WHERE ${CANDIDATE_SQL}`).all();
  const upd = db.prepare('UPDATE parcels SET frontage_aadt=?, frontage_road=? WHERE id=?');
  let withData = 0, nullCount = 0, done = 0;

  const tx = db.transaction((items) => {
    for (const r of items) {
      let aadt = null, name = null;
      try {
        const pf = turf.feature(JSON.parse(r.geom_json));
        let probe = pf;
        try { const buf = turf.buffer(pf, BUFFER_M, { units: 'meters' }); if (buf) probe = buf; } catch (e) { /* use unbuffered */ }
        const b = turf.bbox(probe);
        const cand = idx.search(b[0], b[1], b[2], b[3]);
        let best = -1;
        for (const ci of cand) {
          if (segs[ci].aadt > best && turf.booleanIntersects(probe, segs[ci].feat)) { best = segs[ci].aadt; name = segs[ci].name; }
        }
        if (best >= 0) aadt = best;
      } catch (e) { /* leave null */ }
      upd.run(aadt, name, r.id);
      if (aadt != null) withData++; else nullCount++;
      if (++done % 5000 === 0) console.log(`  ${done}/${rows.length}`);
    }
  });
  tx(rows);
  db.close();

  console.log('\nparcels with frontage AADT:', withData);
  console.log(`parcels with NULL (no AADT road within ${BUFFER_M}m):`, nullCount);
  console.timeEnd('traffic');
}
main();
