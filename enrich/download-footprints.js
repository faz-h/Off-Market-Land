'use strict';
/*
 * Download building footprints for one county from the TxGIO/FEMA "Texas Building Footprints" service
 * (FDST layer 1) within the county's parcel bbox. Geometry only — consumed by enrich/footprints.js to
 * compute per-parcel building coverage %. Writes NDJSON: {g: <GeoJSON Polygon geometry>}.
 *
 * Usage: node enrich/download-footprints.js <county-key>   (e.g. fort-bend, brazoria)
 *
 * The id collection is TILED (small envelope queries) so a large/coastal county bbox doesn't 504 the
 * server on a single returnIdsOnly; ids are de-duped across tile seams. post() retries transient errors.
 */
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const Database = require('better-sqlite3');

const BASE = 'https://feature.geographic.texas.gov/arcgis/rest/services/FDST/BuildingFootprints/MapServer/1/query';
const BATCH = 4000;
const TILE = 0.08; // ~9 km id-collection tiles — keeps each spatial query small enough to avoid 504s
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const COUNTY_SOURCE = { 'fort-bend': 'fbcad:FORT BEND', 'brazoria': 'bcad:BRAZORIA', 'galveston': 'gcad:GALVESTON', 'montgomery': 'mcad:MONTGOMERY', 'waller': 'wcad:WALLER', 'liberty': 'lcad:LIBERTY', 'chambers': 'chcad:CHAMBERS', 'austin': 'acad:AUSTIN', 'harris': 'hcad:HARRIS' };

async function post(params, tries = 4) {
  const body = new URLSearchParams(params).toString();
  for (let a = 0; a < tries; a++) {
    try {
      const { data } = await axios.post(BASE, body, { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 180000 });
      return data;
    } catch (e) { if (a === tries - 1) throw e; await sleep(1500 * (a + 1)); }
  }
}

async function getIdsTiled([w, s, e, n]) {
  const ids = new Set();
  let tiles = 0;
  for (let x = w; x < e; x += TILE) {
    for (let y = s; y < n; y += TILE) {
      const env = `${x},${y},${Math.min(x + TILE, e)},${Math.min(y + TILE, n)}`;
      try {
        const data = await post({ where: '1=1', geometry: env, geometryType: 'esriGeometryEnvelope', inSR: '4326', spatialRel: 'esriSpatialRelIntersects', returnIdsOnly: 'true', f: 'json' });
        for (const id of (data.objectIds || [])) ids.add(id);
      } catch (err) { console.warn(`  ! tile ${env} failed after retries (${err.message}) — skipping`); }
      if (++tiles % 10 === 0) console.log(`  tiles ${tiles}, ids so far ${ids.size}`);
      await sleep(60);
    }
  }
  return [...ids];
}

async function main() {
  const key = process.argv[2];
  const source = COUNTY_SOURCE[key];
  if (!source) { console.error('Usage: node enrich/download-footprints.js <county-key>\n  known:', Object.keys(COUNTY_SOURCE).join(', ')); process.exit(1); }

  const db = new Database(path.join(__dirname, '..', 'db', 'parcels.db'), { readonly: true });
  const b = db.prepare('SELECT MIN(rep_lng) w, MIN(rep_lat) s, MAX(rep_lng) e, MAX(rep_lat) n FROM parcels WHERE source=?').get(source);
  db.close();
  const pad = 0.01;
  const bbox = [b.w - pad, b.s - pad, b.e + pad, b.n + pad];
  const OUT = path.join(__dirname, '..', 'data', 'layers', 'footprints', `${key}.ndjson`);
  fs.mkdirSync(path.dirname(OUT), { recursive: true });

  console.log(`bbox ${bbox.map((v) => v.toFixed(3)).join(',')} — collecting footprint ids by tile...`);
  const ids = await getIdsTiled(bbox);
  console.log(`footprints to fetch for ${source}: ${ids.length}`);

  const ws = fs.createWriteStream(OUT);
  let written = 0, skipped = 0;
  for (let i = 0; i < ids.length; i += BATCH) {
    const batch = ids.slice(i, i + BATCH);
    let feats = null;
    try {
      const data = await post({ objectIds: batch.join(','), outFields: '', returnGeometry: 'true', outSR: '4326', geometryPrecision: '6', f: 'geojson' });
      feats = data.features || [];
    } catch (e) { console.warn(`  ! batch @${i} failed (${e.message}) — skipping ${batch.length}`); skipped += batch.length; }
    if (feats) for (const f of feats) { if (f.geometry) { ws.write(JSON.stringify({ g: f.geometry }) + '\n'); written++; } }
    if ((i / BATCH) % 10 === 0) console.log(`  ${Math.min(i + BATCH, ids.length)}/${ids.length} (written ${written}, skipped ${skipped})`);
    await sleep(80);
  }
  await new Promise((r) => ws.end(r));
  console.log(`done — wrote ${written} footprints, skipped ${skipped} -> ${path.relative(path.join(__dirname, '..'), OUT)}`);
}

main().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
