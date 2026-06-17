'use strict';
/*
 * Download TxDOT AADT line segments for the 9-county Houston bbox.
 * Dense coverage (~135k segments, all with AADT_CUR). Lightly generalized polylines.
 * Writes NDJSON: {g: <GeoJSON geometry>, a: AADT_CUR, p: RTE_PRFX, n: RTE_NBR, rn: RTE_NM}.
 * Consumed by enrich/traffic.js.
 */
const fs = require('fs');
const path = require('path');
const axios = require('axios');

const BASE = 'https://services.arcgis.com/KTcxiTD9dsQw4r7Z/arcgis/rest/services/TxDOT_AADT/FeatureServer/0/query';
const BBOX = '-96.2856,28.9415,-94.3567,30.5004';
const OUT = path.join(__dirname, '..', 'data', 'layers', 'traffic', 'aadt.ndjson');
const BATCH = 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function post(params) {
  const body = new URLSearchParams(params).toString();
  const { data } = await axios.post(BASE, body, { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 120000 });
  return data;
}

async function getIds() {
  const data = await post({
    where: 'AADT_CUR > 0', geometry: BBOX, geometryType: 'esriGeometryEnvelope', inSR: '4326',
    spatialRel: 'esriSpatialRelIntersects', returnIdsOnly: 'true', f: 'json',
  });
  return data.objectIds || [];
}

async function fetchBatch(ids) {
  const data = await post({
    objectIds: ids.join(','),
    outFields: 'AADT_CUR,RTE_PRFX,RTE_NBR,RTE_NM',
    outSR: '4326', returnGeometry: 'true', geometryPrecision: '6', maxAllowableOffset: '0.0001',
    f: 'geojson',
  });
  return data.features || [];
}

(async () => {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  const ids = await getIds();
  console.log('AADT segments to fetch:', ids.length);
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
      const p = f.properties || {};
      ws.write(JSON.stringify({ g: f.geometry, a: p.AADT_CUR, p: p.RTE_PRFX, n: p.RTE_NBR, rn: p.RTE_NM }) + '\n');
      written++;
    }
    if ((i / BATCH) % 20 === 0) console.log(`  ${Math.min(i + BATCH, ids.length)}/${ids.length} (written ${written}, skipped ${skipped})`);
    await sleep(120);
  }
  await new Promise((r) => ws.end(r));
  console.log('done — wrote', written, 'segments, skipped', skipped, '->', path.relative(path.join(__dirname, '..'), OUT));
})().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
