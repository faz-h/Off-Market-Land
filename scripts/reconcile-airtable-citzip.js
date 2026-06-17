'use strict';
/*
 * One-time reconciliation: fix City/Zip on Airtable Accounts(Land) rows that were exported BEFORE the situs
 * parse fix + reverse-geocode fallback existed. Scoped to a campaign so it only touches the intended batch.
 * For each record missing a Zip, missing a City, or whose City is actually a zip (the old mis-parse), it pulls
 * the corrected City/Zip from the local parcels DB (situs_city/zip, now backfilled) and, when the CAD had
 * neither, reverse-geocodes the parcel's interior point (cached into geo_city/geo_zip just like the live export).
 *
 *   node scripts/reconcile-airtable-citzip.js "<campaign name>"            # DRY RUN (report only)
 *   node scripts/reconcile-airtable-citzip.js "<campaign name>" --apply    # apply the PATCHes
 *
 * Guarantees every touched row ends with at least one of City/Zip, and never overwrites a good existing value.
 */
require('dotenv').config();
const path = require('path');
const axios = require('axios');
const Database = require('better-sqlite3');
const { reverseCityZip, ensureLocationColumns } = require('../services/geocode');

const BASE_ID = process.env.AIRTABLE_BASE_ID;
const ACCOUNTS_TABLE = 'tblWDvEfAkT9Qq7OC';
const CAMPAIGN_FIELD = 'Off-Market Land Campaign';
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'db', 'parcels.db');
const headers = { Authorization: `Bearer ${process.env.AIRTABLE_ACCESS_TOKEN}`, 'Content-Type': 'application/json' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const chunk = (a, n) => { const o = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; };

const isEmpty = (v) => v == null || String(v).trim() === '';
const looksNumeric = (v) => v != null && /^\d{4,5}(-\d{4})?$/.test(String(v).trim());
const pickStr = (v) => { const s = v == null ? '' : String(v).trim(); return s || undefined; };
const pickCity = (v) => { const s = pickStr(v); return s && !looksNumeric(s) ? s : undefined; }; // a real (non-zip) city

const campaign = process.argv[2];
const APPLY = process.argv.includes('--apply');
if (!campaign) { console.error('Usage: node scripts/reconcile-airtable-citzip.js "<campaign name>" [--apply]'); process.exit(1); }

async function fetchCampaignLand(name) {
  const recs = [];
  let offset = null;
  const formula = `AND({Asset Class}='Land', FIND("${name}", ARRAYJOIN({${CAMPAIGN_FIELD}})))`;
  do {
    const params = new URLSearchParams({ pageSize: '100', filterByFormula: formula });
    ['County', 'County Property ID', 'Coordinates', 'City', 'State', 'Zip'].forEach((f) => params.append('fields[]', f));
    if (offset) params.set('offset', offset);
    const r = await axios.get(`https://api.airtable.com/v0/${BASE_ID}/${ACCOUNTS_TABLE}?${params}`, { headers });
    recs.push(...r.data.records);
    offset = r.data.offset;
    if (offset) await sleep(220);
  } while (offset);
  return recs;
}

(async () => {
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  ensureLocationColumns(db);
  const byProp = db.prepare('SELECT situs_city, situs_zip, geo_city, geo_zip, rep_lat, rep_lng FROM parcels WHERE UPPER(county)=UPPER(?) AND prop_id=? LIMIT 1');
  const byCoord = db.prepare('SELECT situs_city, situs_zip, geo_city, geo_zip, rep_lat, rep_lng FROM parcels WHERE ABS(rep_lat-?)<1e-6 AND ABS(rep_lng-?)<1e-6 LIMIT 1');
  const cacheGeo = db.prepare("UPDATE parcels SET geo_city=?, geo_zip=?, geo_lookup_at=datetime('now') WHERE UPPER(county)=UPPER(?) AND prop_id=?");

  console.log(`Campaign: "${campaign}"  |  mode: ${APPLY ? 'APPLY' : 'DRY RUN'}`);
  const recs = await fetchCampaignLand(campaign);
  console.log(`Fetched ${recs.length} Land records in this campaign.\n`);

  const patches = [];
  let unmatched = 0, geocoded = 0, alreadyOk = 0;
  const stat = { zipSet: 0, citySet: 0, cityCleared: 0 };

  for (const rec of recs) {
    const f = rec.fields;
    const county = f.County, propId = f['County Property ID'];
    const curCity = f.City, curZip = f.Zip;

    // only consider rows that need help
    const needs = isEmpty(curZip) || isEmpty(curCity) || looksNumeric(curCity);
    if (!needs) { alreadyOk++; continue; }

    // find the parcel in the local DB
    let p = (propId != null) ? byProp.get(county || '', String(propId)) : null;
    if (!p && f.Coordinates) {
      const m = String(f.Coordinates).split(',').map((x) => Number(x.trim()));
      if (m.length === 2 && Number.isFinite(m[0]) && Number.isFinite(m[1])) p = byCoord.get(m[0], m[1]);
    }
    if (!p) { unmatched++; continue; }

    // reverse-geocode fallback when the CAD had neither city nor zip and we've not looked up before
    if (isEmpty(p.situs_city) && isEmpty(p.situs_zip) && p.geo_city == null && p.geo_zip == null
      && p.rep_lat != null && p.rep_lng != null) {
      const { city, zip } = await reverseCityZip(p.rep_lat, p.rep_lng, process.env.GOOGLE_API_KEY);
      p.geo_city = city || ''; p.geo_zip = zip || '';
      if (APPLY) cacheGeo.run(p.geo_city, p.geo_zip, county || '', String(propId));
      geocoded++;
    }

    // desired values
    let zip = pickStr(p.situs_zip) || pickStr(p.geo_zip);
    if (!zip && looksNumeric(curCity)) zip = String(curCity).trim(); // recover the zip the old bug put in City
    const realCity = pickCity(p.situs_city) || pickCity(p.geo_city);

    const patch = {};
    if (isEmpty(curZip) && zip) patch.Zip = zip;
    const finalZipPresent = !isEmpty(curZip) || patch.Zip != null;
    if (isEmpty(curCity) || looksNumeric(curCity)) {
      if (realCity) patch.City = realCity;
      else if (looksNumeric(curCity) && finalZipPresent) patch.City = ''; // strip the zip masquerading as a city
    }
    if (!Object.keys(patch).length) { alreadyOk++; continue; }

    if (patch.Zip != null) stat.zipSet++;
    if (patch.City != null && patch.City !== '') stat.citySet++;
    if (patch.City === '') stat.cityCleared++;
    patches.push({ id: rec.id, fields: patch, _dbg: { county, propId, curCity, curZip } });
  }

  console.log('Plan:');
  console.log(`  records already fine (skipped):     ${alreadyOk}`);
  console.log(`  records not matched in local DB:    ${unmatched}`);
  console.log(`  reverse-geocode lookups performed:  ${geocoded}`);
  console.log(`  records to PATCH:                   ${patches.length}`);
  console.log(`    -> Zip set: ${stat.zipSet}  | City set: ${stat.citySet}  | City cleared (was a zip): ${stat.cityCleared}`);
  console.log('\n  sample of planned changes:');
  for (const p of patches.slice(0, 12)) {
    console.log(`    ${p._dbg.county} prop ${p._dbg.propId}: City "${p._dbg.curCity ?? ''}"->"${p.fields.City ?? '(keep)'}"  Zip "${p._dbg.curZip ?? ''}"->"${p.fields.Zip ?? '(keep)'}"`);
  }

  if (!APPLY) { console.log('\nDRY RUN — no records changed. Re-run with --apply to write.'); return; }
  if (!patches.length) { console.log('\nNothing to apply.'); return; }

  let done = 0;
  for (const group of chunk(patches, 10)) {
    const body = { records: group.map((p) => ({ id: p.id, fields: p.fields })), typecast: true };
    await axios.patch(`https://api.airtable.com/v0/${BASE_ID}/${ACCOUNTS_TABLE}`, body, { headers });
    done += group.length;
    process.stdout.write(`\r  patched ${done}/${patches.length}`);
    await sleep(220);
  }
  console.log(`\nDone. Updated ${patches.length} Airtable records.`);
})().catch((e) => { console.error('FAILED:', e.response ? JSON.stringify(e.response.data) : e.message); process.exit(1); });
