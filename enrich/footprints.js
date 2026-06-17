'use strict';
/*
 * Footprint enrichment (vacancy gate) — compute each candidate parcel's building coverage %.
 * Loads data/layers/footprints/<county>.ndjson, flatbush-indexes the building polygons, and for each
 * parcel sums (building ∩ parcel) area ÷ parcel area = building_cov_pct. Only processes candidate
 * parcels (is_public=0) and is incremental (building_cov_pct IS NULL), so re-runs are cheap.
 *
 * Usage: node enrich/footprints.js <county-key>   (e.g. fort-bend)
 * Heavy load (≈1.3M buildings for Fort Bend) — run with --max-old-space-size if needed.
 */
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const Database = require('better-sqlite3');
const Flatbush = require('flatbush');
const turf = require('@turf/turf');

const ROOT = path.join(__dirname, '..');
const DB_PATH = path.join(ROOT, 'db', 'parcels.db');

// county-key -> parcels.source, so coverage is scored ONLY against that county's parcels (footprints loaded
// are this county's only; without the source filter a multi-county DB would score other counties' parcels
// against the wrong footprint set and mark them falsely vacant).
const COUNTY_SOURCE = {
  'fort-bend': 'fbcad:FORT BEND', 'brazoria': 'bcad:BRAZORIA', 'galveston': 'gcad:GALVESTON',
  'montgomery': 'mcad:MONTGOMERY', 'waller': 'wcad:WALLER', 'liberty': 'lcad:LIBERTY',
  'chambers': 'chcad:CHAMBERS', 'austin': 'acad:AUSTIN', 'harris': 'hcad:HARRIS',
};

function bboxOf(geom) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const polys = geom.type === 'MultiPolygon' ? geom.coordinates : [geom.coordinates];
  for (const poly of polys) for (const pt of poly[0]) {
    if (pt[0] < minX) minX = pt[0]; if (pt[0] > maxX) maxX = pt[0];
    if (pt[1] < minY) minY = pt[1]; if (pt[1] > maxY) maxY = pt[1];
  }
  return [minX, minY, maxX, maxY];
}

async function loadFootprints(ndjson) {
  const geoms = [], bxs = [];
  const rl = readline.createInterface({ input: fs.createReadStream(ndjson), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line) continue;
    let o; try { o = JSON.parse(line); } catch (e) { continue; }
    if (!o.g || !o.g.coordinates) continue;
    geoms.push(o.g);
    bxs.push(bboxOf(o.g));
  }
  const idx = new Flatbush(geoms.length);
  for (const b of bxs) idx.add(b[0], b[1], b[2], b[3]);
  idx.finish();
  return { geoms, idx };
}

async function main() {
  const key = process.argv[2] || 'fort-bend';
  const source = COUNTY_SOURCE[key];
  if (!source) { console.error('Unknown county-key:', key, '\n  known:', Object.keys(COUNTY_SOURCE).join(', ')); process.exit(1); }
  const ndjson = path.join(ROOT, 'data', 'layers', 'footprints', `${key}.ndjson`);
  if (!fs.existsSync(ndjson)) { console.error('Footprints not found — run download-footprints.js first:', ndjson); process.exit(1); }

  console.time('footprints');
  const { geoms, idx } = await loadFootprints(ndjson);
  console.log('building footprints indexed:', geoms.length);

  const db = new Database(DB_PATH);
  const rows = db.prepare('SELECT id, geom_json FROM parcels WHERE source = ? AND is_public = 0 AND building_cov_pct IS NULL').all(source);
  console.log('candidate parcels to score:', rows.length);
  const upd = db.prepare('UPDATE parcels SET building_cov_pct = ? WHERE id = ?');
  const buckets = { '0%': 0, '<5%': 0, '5-20%': 0, '20-50%': 0, '>=50%': 0 };
  let done = 0;

  const tx = db.transaction((items) => {
    for (const r of items) {
      let pct = 0;
      try {
        const pf = turf.feature(JSON.parse(r.geom_json));
        const parcelArea = turf.area(pf);
        const b = turf.bbox(pf);
        let overlap = 0;
        for (const ci of idx.search(b[0], b[1], b[2], b[3])) {
          const bf = turf.feature(geoms[ci]);
          if (!turf.booleanIntersects(pf, bf)) continue;
          let inter = null;
          try { inter = turf.intersect(turf.featureCollection([pf, bf])); } catch (e) { continue; }
          if (inter) overlap += turf.area(inter);
        }
        if (parcelArea > 0) pct = Math.min(100, (100 * overlap) / parcelArea);
      } catch (e) { /* leave 0 */ }
      pct = Math.round(pct * 10) / 10;
      upd.run(pct, r.id);
      if (pct === 0) buckets['0%']++;
      else if (pct < 5) buckets['<5%']++;
      else if (pct < 20) buckets['5-20%']++;
      else if (pct < 50) buckets['20-50%']++;
      else buckets['>=50%']++;
      if (++done % 5000 === 0) console.log(`  ${done}/${rows.length}`);
    }
  });
  tx(rows);

  const pass = db.prepare('SELECT COUNT(*) n FROM parcels WHERE source=? AND is_public=0 AND building_cov_pct <= 20').get(source).n;
  db.close();

  console.log('\nbuilding_cov_pct distribution (candidate parcels):');
  for (const k of ['0%', '<5%', '5-20%', '20-50%', '>=50%']) console.log(`  ${k}: ${buckets[k]}`);
  console.log(`\n<=20% coverage (vacancy gate pass): ${pass}`);
  console.timeEnd('footprints');
}

main().catch((e) => { console.error(e); process.exit(1); });
