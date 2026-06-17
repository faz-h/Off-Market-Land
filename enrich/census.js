'use strict';
/*
 * Demographics enrichment (ported from Land Map's compute-census-demographics.js).
 * For each parcel rep point, aggregate ACS block groups whose centroid is within 2mi/5mi:
 * sum population/households/owner, population-weighted median income/age, 2017->2022 pop growth.
 * flatbush prefilter on BG centroids keeps it fast. Writes c2_* / c5_* columns.
 */
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { CANDIDATE_SQL } = require('../services/candidate');
const Flatbush = require('flatbush');
const turf = require('@turf/turf');

const ROOT = path.join(__dirname, '..');
const BG = path.join(ROOT, 'data', 'layers', 'census', 'block-groups.json');
const DB_PATH = path.join(ROOT, 'db', 'parcels.db');
const RADII = [2, 5];
const DEG = 0.1; // ~6-7mi search box, safely covers the 5mi radius

const bgs = JSON.parse(fs.readFileSync(BG, 'utf8')).map((b) => ({ ...b, point: turf.point([b.centLon, b.centLat]) }));
const idx = new Flatbush(bgs.length);
for (const b of bgs) idx.add(b.centLon, b.centLat, b.centLon, b.centLat);
idx.finish();

// counties that actually have block groups loaded (geoid = SS CCC tract bg); parcels in a county
// with no BGs get NULL demographics (honest "unknown") rather than a misleading ~0.
const fipsPresent = new Set(bgs.map((b) => b.geoid.slice(2, 5)));
const COUNTY_FIPS = { HARRIS: '201', 'FORT BEND': '157', MONTGOMERY: '339', BRAZORIA: '039', GALVESTON: '167', WALLER: '473', LIBERTY: '291', CHAMBERS: '071', AUSTIN: '015' };

function demo(lat, lng) {
  const cand = idx.search(lng - DEG, lat - DEG, lng + DEG, lat + DEG);
  const pt = turf.point([lng, lat]);
  const res = {};
  for (const radius of RADII) {
    let tp = 0, tp17 = 0, th = 0, to = 0, toc = 0, wi = 0, iw = 0, wa = 0, aw = 0;
    for (const ci of cand) {
      const bg = bgs[ci];
      if (turf.distance(pt, bg.point, { units: 'miles' }) > radius) continue;
      const c = bg.current || {}, h = bg.historical || {};
      if (c.population != null) tp += c.population;
      if (h.population != null) tp17 += h.population;
      if (c.households != null) th += c.households;
      if (c.ownerOccupied != null) to += c.ownerOccupied;
      if (c.occupiedUnits != null) toc += c.occupiedUnits;
      if (c.medianIncome != null && c.population > 0) { wi += c.medianIncome * c.population; iw += c.population; }
      if (c.medianAge != null && c.population > 0) { wa += c.medianAge * c.population; aw += c.population; }
    }
    res[radius] = {
      population: tp,
      popGrowth: tp17 > 0 ? Math.round(((tp - tp17) / tp17) * 10000) / 100 : null,
      medianIncome: iw > 0 ? Math.round(wi / iw) : null,
      households: th,
      medianAge: aw > 0 ? Math.round((wa / aw) * 10) / 10 : null,
      ownerPct: toc > 0 ? Math.round((to / toc) * 1000) / 10 : null,
    };
  }
  return res;
}

function main() {
  console.time('census');
  console.log('block groups:', bgs.length);
  const db = new Database(DB_PATH);
  const rows = db.prepare(`SELECT id, rep_lat, rep_lng, county FROM parcels WHERE ${CANDIDATE_SQL}`).all();
  const upd = db.prepare('UPDATE parcels SET c2_pop=?,c2_income=?,c2_age=?,c2_households=?,c2_owner_pct=?,c2_growth=?,c5_pop=?,c5_income=?,c5_age=?,c5_households=?,c5_owner_pct=?,c5_growth=? WHERE id=?');
  let done = 0, nulled = 0;
  const tx = db.transaction((items) => {
    for (const r of items) {
      const fips = COUNTY_FIPS[(r.county || '').toUpperCase()];
      if (!fipsPresent.has(fips)) { // no block groups for this county yet (e.g. Austin until a Census key is added)
        upd.run(null, null, null, null, null, null, null, null, null, null, null, null, r.id);
        nulled++;
        if (++done % 5000 === 0) console.log(`  ${done}/${rows.length}`);
        continue;
      }
      const d = demo(r.rep_lat, r.rep_lng);
      const a = d[2], b = d[5];
      upd.run(a.population, a.medianIncome, a.medianAge, a.households, a.ownerPct, a.popGrowth,
        b.population, b.medianIncome, b.medianAge, b.households, b.ownerPct, b.popGrowth, r.id);
      if (++done % 5000 === 0) console.log(`  ${done}/${rows.length}`);
    }
  });
  tx(rows);
  db.close();
  if (nulled) console.log(`  (${nulled} parcels in counties with no block groups -> NULL demographics)`);
  console.timeEnd('census');
}
main();
