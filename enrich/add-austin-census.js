'use strict';
/* Augment the census block-group file with Austin County (FIPS 48015), which Land Map's
 * 8-county dataset omits. Same method as Land Map's fetch-census-data.js (TIGERweb geometries
 * + ACS 2022/2017, keyless). Idempotent: no-op if Austin is already present. */
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'data', 'layers', 'census', 'block-groups.json');
const STATE = '48', COUNTY = '015';
const VARS = 'B01003_001E,B19013_001E,B01002_001E,B11001_001E,B25003_001E,B25003_002E';
const parseNum = (v) => { const n = parseInt(v); return isNaN(n) || n < 0 ? null : n; };

async function fetchGeoms() {
  const feats = []; let offset = 0; const batch = 500;
  while (true) {
    const url = `https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/tigerWMS_ACS2022/MapServer/8/query?where=STATE%3D%27${STATE}%27+AND+COUNTY%3D%27${COUNTY}%27&outFields=GEOID,AREALAND,CENTLAT,CENTLON&f=geojson&resultRecordCount=${batch}&resultOffset=${offset}&outSR=4326`;
    const r = await fetch(url); if (!r.ok) throw new Error('TIGERweb ' + r.status);
    const d = await r.json();
    if (!d.features || !d.features.length) break;
    feats.push(...d.features);
    if (d.features.length < batch) break; offset += batch;
  }
  return feats;
}

async function fetchACS(year) {
  const url = `https://api.census.gov/data/${year}/acs/acs5?get=${VARS}&for=block%20group:*&in=state:${STATE}&in=county:${COUNTY}&in=tract:*`;
  const r = await fetch(url); if (!r.ok) throw new Error('Census ' + year + ' ' + r.status);
  const d = await r.json();
  const h = d[0], out = {};
  for (const row of d.slice(1)) {
    const geoid = `${row[h.indexOf('state')]}${row[h.indexOf('county')]}${row[h.indexOf('tract')]}${row[h.indexOf('block group')]}`;
    out[geoid] = {
      population: parseNum(row[h.indexOf('B01003_001E')]), medianIncome: parseNum(row[h.indexOf('B19013_001E')]),
      medianAge: parseNum(row[h.indexOf('B01002_001E')]), households: parseNum(row[h.indexOf('B11001_001E')]),
      occupiedUnits: parseNum(row[h.indexOf('B25003_001E')]), ownerOccupied: parseNum(row[h.indexOf('B25003_002E')]),
    };
  }
  return out;
}

(async () => {
  const bgs = JSON.parse(fs.readFileSync(SRC, 'utf8'));
  if (bgs.some((b) => b.geoid.startsWith('48015'))) { console.log('Austin already present — nothing to do.'); return; }
  console.log('fetching Austin County (48015) block groups...');
  const geos = await fetchGeoms();
  const a22 = await fetchACS(2022), a17 = await fetchACS(2017);
  const added = geos.map((f) => ({
    geoid: f.properties.GEOID, centLat: parseFloat(f.properties.CENTLAT), centLon: parseFloat(f.properties.CENTLON),
    areaLandSqMi: f.properties.AREALAND / 2589988.11, current: a22[f.properties.GEOID] || {}, historical: a17[f.properties.GEOID] || {},
  }));
  fs.writeFileSync(SRC, JSON.stringify(bgs.concat(added)));
  console.log('added', added.length, 'Austin BGs; total now', bgs.length + added.length);
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
