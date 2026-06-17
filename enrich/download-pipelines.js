'use strict';
/*
 * Download TX Railroad Commission pipeline lines (RRC Public Viewer, layer 13 "Pipelines")
 * for the 9-county Houston bbox. Lightly generalized polylines (~5m), with useful attributes.
 * Writes NDJSON: {g: <GeoJSON geometry>, op, co (commodity), sy (system), di (diameter), st (status)}.
 * Consumed by enrich/pipelines.js. Note: RRC data is "informational only / call 811".
 */
const fs = require('fs');
const path = require('path');
const axios = require('axios');

const BASE = 'https://gis.rrc.texas.gov/server/rest/services/rrc_public/RRC_Public_Viewer_Srvs/MapServer/13/query';
const BBOX = '-96.2856,28.9415,-94.3567,30.5004';
const OUT = path.join(__dirname, '..', 'data', 'layers', 'pipelines', 'rrc.ndjson');
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
    where: '1=1', geometry: BBOX, geometryType: 'esriGeometryEnvelope', inSR: '4326',
    spatialRel: 'esriSpatialRelIntersects', returnIdsOnly: 'true', f: 'json',
  });
  return data.objectIds || [];
}

async function fetchBatch(ids) {
  const data = await post({
    objectIds: ids.join(','),
    outFields: 'OPERATOR,COMMODITY_DESCRIPTION,SYSTEM_NAME,DIAMETER,STATUS',
    outSR: '4326', returnGeometry: 'true', geometryPrecision: '6', maxAllowableOffset: '0.00005',
    f: 'geojson',
  });
  return data.features || [];
}

(async () => {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  const ids = await getIds();
  console.log('pipeline lines to fetch:', ids.length);
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
      ws.write(JSON.stringify({ g: f.geometry, op: p.OPERATOR, co: p.COMMODITY_DESCRIPTION, sy: p.SYSTEM_NAME, di: p.DIAMETER, st: p.STATUS }) + '\n');
      written++;
    }
    if ((i / BATCH) % 10 === 0) console.log(`  ${Math.min(i + BATCH, ids.length)}/${ids.length} (written ${written}, skipped ${skipped})`);
    await sleep(150);
  }
  await new Promise((r) => ws.end(r));
  console.log('done — wrote', written, 'lines, skipped', skipped, '->', path.relative(path.join(__dirname, '..'), OUT));
})().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
