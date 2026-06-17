'use strict';
/* One-off: recover any buy-box parcels missing from data/county-raw/harris/parcels.ndjson by diffing the file's
 * OBJECTIDs against the server's full returnIdsOnly set, then fetching the gap by objectIds (small, gentle,
 * retried) and APPENDING. Re-runnable / idempotent-ish (only fetches what's missing). */
const fs = require('fs');
const path = require('path');
const axios = require('axios');

const URL = 'https://www.gis.hctx.net/arcgis/rest/services/HCAD/Parcels/MapServer/0/query';
const WHERE = 'acreage_1>=0.5 AND acreage_1<=50';
const OUTFIELDS = 'HCAD_NUM,acct_num,owner_name_1,owner_name_2,owner_name_3,mail_addr_1,mail_addr_2,mail_city,mail_state,mail_zip,site_str_pfx,site_str_num,site_str_num_sfx,site_str_name,site_str_sfx,site_str_sfx_dir,site_city,site_zip,state_class,acreage_1,land_value,bld_value,impr_value,land_use,OBJECTID';
const FILE = path.join(__dirname, '..', 'data', 'county-raw', 'harris', 'parcels.ndjson');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(params, tries = 6) {
  for (let a = 0; a < tries; a++) {
    try { const { data } = await axios.get(URL, { params, timeout: 120000 }); return data; }
    catch (e) { if (a === tries - 1) throw e; await sleep(1500 * (a + 1)); }
  }
}

async function main() {
  const have = new Set();
  for (const l of fs.readFileSync(FILE, 'utf8').split('\n')) { if (!l) continue; try { have.add(JSON.parse(l).p.OBJECTID); } catch (e) {} }
  console.log(`file has ${have.size} unique OBJECTIDs`);
  const all = (await get({ where: WHERE, returnIdsOnly: true, f: 'json' })).objectIds || [];
  const missing = all.filter((x) => !have.has(x));
  console.log(`server has ${all.length}; missing ${missing.length}`);
  if (!missing.length) { console.log('nothing to do'); return; }

  const ws = fs.createWriteStream(FILE, { flags: 'a' });
  let added = 0;
  const still = [];
  for (let i = 0; i < missing.length; i += 1) {
    const batch = missing.slice(i, i + 1);
    let feats = [];
    for (let r = 0; r < 8; r++) {
      const data = await get({ objectIds: batch.join(','), outFields: OUTFIELDS, returnGeometry: true, outSR: 4326, geometryPrecision: 6, f: 'geojson' });
      feats = data.features || [];
      if (feats.length) break;
      await sleep(3000 * (r + 1));
    }
    const back = new Set();
    for (const ft of feats) { if (ft.geometry) { ws.write(JSON.stringify({ p: ft.properties, g: ft.geometry }) + '\n'); added++; } back.add(ft.properties && ft.properties.OBJECTID); }
    for (const id of batch) if (!back.has(id)) still.push(id);
    await sleep(500);
  }
  await new Promise((r) => ws.end(r));
  console.log(`appended ${added}; still missing ${still.length}${still.length ? ': ' + still.slice(0, 20).join(',') : ''}`);
}
main().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
