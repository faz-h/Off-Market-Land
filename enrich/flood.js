'use strict';
/*
 * Flood enrichment — classify each parcel's worst FEMA flood zone.
 * Loads data/layers/flood/nfhl.ndjson, flatbush-indexes the polygons, and for each parcel
 * intersects candidate zones (bbox prefilter -> turf.booleanIntersects), taking the worst by
 * priority. Writes parcels.flood_zone in {None, 500-Year, 100-Year, Floodway}.
 */
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { CANDIDATE_SQL } = require('../services/candidate');
const Flatbush = require('flatbush');
const turf = require('@turf/turf');

const ROOT = path.join(__dirname, '..');
const NDJSON = path.join(ROOT, 'data', 'layers', 'flood', 'nfhl.ndjson');
const DB_PATH = path.join(ROOT, 'db', 'parcels.db');

const HIGH_RISK = new Set(['A', 'AE', 'AH', 'AO', 'A99', 'AR', 'V', 'VE']);
const RANK = { None: 0, '500-Year': 1, '100-Year': 2, Floodway: 3 };

function classifyOne(z, s) {
  z = (z || '').toUpperCase().trim();
  s = (s || '').toUpperCase();
  if (HIGH_RISK.has(z)) return s.includes('FLOODWAY') ? 'Floodway' : '100-Year';
  if (z === 'X' && s.includes('0.2 PCT ANNUAL CHANCE')) return '500-Year';
  return 'None';
}

function loadFlood() {
  const lines = fs.readFileSync(NDJSON, 'utf8').split('\n');
  const feats = [], cls = [];
  for (const l of lines) {
    if (!l) continue;
    const o = JSON.parse(l);
    if (!o.g) continue;
    feats.push(turf.feature(o.g));
    cls.push(classifyOne(o.z, o.s));
  }
  const idx = new Flatbush(feats.length);
  for (const f of feats) { const b = turf.bbox(f); idx.add(b[0], b[1], b[2], b[3]); }
  idx.finish();
  return { feats, cls, idx };
}

function main() {
  console.time('flood');
  const { feats, cls, idx } = loadFlood();
  console.log('flood polygons indexed:', feats.length);

  const db = new Database(DB_PATH);
  const rows = db.prepare(`SELECT id, geom_json FROM parcels WHERE ${CANDIDATE_SQL}`).all();
  const upd = db.prepare("UPDATE parcels SET flood_zone = ?, flood_pct = ?, enriched_at = datetime('now') WHERE id = ?");
  const counts = { None: 0, '500-Year': 0, '100-Year': 0, Floodway: 0 };
  const buckets = { '<1%': 0, '1-10%': 0, '10-50%': 0, '>=50%': 0 };
  let done = 0;

  const tx = db.transaction((items) => {
    for (const r of items) {
      let zone = 'None', pct = 0;
      try {
        const pf = turf.feature(JSON.parse(r.geom_json));
        const parcelArea = turf.area(pf);
        const b = turf.bbox(pf);
        const cand = idx.search(b[0], b[1], b[2], b[3]);
        let best = 0, overlap = 0;
        for (const ci of cand) {
          if (!turf.booleanIntersects(pf, feats[ci])) continue; // cheap reject before the costly intersect
          // intersect only for real overlaps: gives both the area (flood_pct) and confirms the zone
          let inter = null;
          try { inter = turf.intersect(turf.featureCollection([pf, feats[ci]])); } catch (e) { continue; }
          if (!inter) continue;
          const a = turf.area(inter);
          if (a <= 0) continue; // boundary-only touch: not in zone
          overlap += a;
          const rk = RANK[cls[ci]];
          if (rk > best) { best = rk; zone = cls[ci]; }
        }
        if (parcelArea > 0) pct = Math.min(100, (100 * overlap) / parcelArea);
      } catch (e) { /* leave None / 0 */ }
      upd.run(zone, Math.round(pct * 10) / 10, r.id);
      counts[zone]++;
      if (zone !== 'None') {
        if (pct < 1) buckets['<1%']++;
        else if (pct < 10) buckets['1-10%']++;
        else if (pct < 50) buckets['10-50%']++;
        else buckets['>=50%']++;
      }
      if (++done % 5000 === 0) console.log(`  ${done}/${rows.length}`);
    }
  });
  tx(rows);
  db.close();

  const tot = rows.length;
  console.log('\nflood_zone distribution:');
  for (const k of ['None', '500-Year', '100-Year', 'Floodway']) {
    console.log(`  ${k}: ${counts[k]} (${(100 * counts[k] / tot).toFixed(1)}%)`);
  }
  console.log('\nflood_pct buckets (non-None parcels by % of area in a flood zone):');
  for (const k of ['<1%', '1-10%', '10-50%', '>=50%']) console.log(`  ${k}: ${buckets[k]}`);
  console.timeEnd('flood');
}

main();
