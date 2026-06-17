'use strict';
/*
 * Download FEMA NFHL flood hazard zone polygons (layer 28) for the 9-county Houston bbox.
 * - excludes zone X "Area of Minimal Flood Hazard" (those classify as None anyway)
 * - generalizes geometry server-side (maxAllowableOffset ~11m) — fine for parcel screening,
 *   keeps the file ~10x smaller than raw NFHL geometry
 * Strategy: fetch ALL matching objectIds (bypasses the per-request cap), then pull geometry
 * in batches via POST. Writes NDJSON: {z: FLD_ZONE, s: ZONE_SUBTY, g: <GeoJSON geometry>}.
 */
const fs = require('fs');
const path = require('path');
const axios = require('axios');

const BASE = 'https://hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer/28/query';
const BBOX = '-96.2856,28.9415,-94.3567,30.5004'; // xmin,ymin,xmax,ymax (4326)
const OUT = path.join(__dirname, '..', 'data', 'layers', 'flood', 'nfhl.ndjson');
// drop minimal-hazard zone X (== None); keep X "0.2 PCT" (500-year) and all high-risk zones
const WHERE = "NOT (FLD_ZONE = 'X' AND (ZONE_SUBTY IS NULL OR ZONE_SUBTY = 'AREA OF MINIMAL FLOOD HAZARD'))";
const BATCH = 500;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function post(params) {
  const body = new URLSearchParams(params).toString();
  const { data } = await axios.post(BASE, body, {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    timeout: 120000,
  });
  return data;
}

async function getIds() {
  const data = await post({
    where: WHERE,
    geometry: BBOX,
    geometryType: 'esriGeometryEnvelope',
    inSR: '4326',
    spatialRel: 'esriSpatialRelIntersects',
    returnIdsOnly: 'true',
    f: 'json',
  });
  return data.objectIds || [];
}

async function fetchBatch(ids) {
  const data = await post({
    objectIds: ids.join(','),
    outFields: 'FLD_ZONE,ZONE_SUBTY',
    outSR: '4326',
    returnGeometry: 'true',
    geometryPrecision: '6',
    maxAllowableOffset: '0.0001', // ~11m generalization
    f: 'geojson',
  });
  return data.features || [];
}

(async () => {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  const ids = await getIds();
  console.log('flood polygons to fetch (minimal-hazard X excluded):', ids.length);
  const ws = fs.createWriteStream(OUT);
  let written = 0, skipped = 0;
  for (let i = 0; i < ids.length; i += BATCH) {
    const batch = ids.slice(i, i + BATCH);
    let feats = null;
    for (let attempt = 0; attempt < 4; attempt++) {
      try { feats = await fetchBatch(batch); break; }
      catch (e) { if (attempt === 3) { console.warn(`  ! batch @${i} failed (${e.message}) — skipping ${batch.length}`); skipped += batch.length; } else await sleep(1000 * (attempt + 1)); }
    }
    if (feats) for (const f of feats) {
      if (!f.geometry) continue;
      ws.write(JSON.stringify({ z: f.properties.FLD_ZONE, s: f.properties.ZONE_SUBTY, g: f.geometry }) + '\n');
      written++;
    }
    if ((i / BATCH) % 10 === 0) console.log(`  ${Math.min(i + BATCH, ids.length)}/${ids.length} (written ${written}, skipped ${skipped})`);
    await sleep(150);
  }
  await new Promise((r) => ws.end(r));
  console.log('done — wrote', written, 'features, skipped', skipped, '->', path.relative(path.join(__dirname, '..'), OUT));
})().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
