'use strict';
/*
 * Campaign export — push the current filtered candidate set to the Airtable Accounts table and/or an Excel file.
 *
 * Workflow (see also app.js /api/export): the user names a batch (a "campaign"), and we
 *   - REQUIRE the campaign name to be unique (never used before) so appends can't silently merge two batches;
 *   - CREATE a new Accounts row for each parcel not already in Airtable (full field mapping, Asset Class=Land,
 *     Stage=Newly Added), tagging it with the campaign in the multi-select `Off-Market Land Campaign` field;
 *   - for parcels that ALREADY exist, leave every other field untouched and only APPEND the campaign tag, so a
 *     parcel can belong to many campaigns but keeps one row.
 * Dedup key is County + County Property ID (case-normalized), with a coordinates fallback when prop_id is blank.
 * Excel export dumps every parcels column except raw geometry, plus the campaign name.
 */
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const ExcelJS = require('exceljs');
const { buildWhere } = require('./query');

const BASE_ID = process.env.AIRTABLE_BASE_ID;
const ACCOUNTS_TABLE = 'tblWDvEfAkT9Qq7OC';
const CAMPAIGN_FIELD = 'Off-Market Land Campaign';
const EXPORT_DIR = process.env.EXPORT_DIR || path.join(__dirname, '..', 'exports');
// Columns dumped to Excel = every parcels column EXCEPT these (raw geometry / index cells are unreadable).
const EXCEL_EXCLUDE = new Set(['geom_json', 'h3_r5', 'h3_r6', 'h3_r7', 'h3_r8']);

const tok = () => process.env.AIRTABLE_ACCESS_TOKEN;
const authHeaders = () => ({ Authorization: `Bearer ${tok()}`, 'Content-Type': 'application/json' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const titleCase = (s) => String(s || '').toLowerCase().replace(/\b\w/g, (m) => m.toUpperCase());
const normCounty = (s) => String(s || '').trim().toUpperCase();
const chunk = (arr, n) => { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; };

// ---- campaign-name uniqueness (reads the multi-select's defined options = every name ever used) ----
async function listCampaignNames() {
  const r = await axios.get(`https://api.airtable.com/v0/meta/bases/${BASE_ID}/tables`, { headers: authHeaders() });
  const t = (r.data.tables || []).find((x) => x.id === ACCOUNTS_TABLE);
  const f = t && t.fields.find((x) => x.name === CAMPAIGN_FIELD);
  return (f && f.options && f.options.choices ? f.options.choices.map((c) => c.name) : []);
}
async function isCampaignTaken(name) {
  const want = String(name || '').trim().toLowerCase();
  if (!want) return true; // empty is never allowed
  const existing = await listCampaignNames();
  return existing.some((n) => n.trim().toLowerCase() === want);
}

// ---- batch selection (same filter semantics as the live map count) ----
function batchColumns(db) {
  return db.prepare('PRAGMA table_info(parcels)').all().map((c) => c.name).filter((c) => !EXCEL_EXCLUDE.has(c));
}
function getBatchRows(db, filterQuery) {
  const { where, params } = buildWhere(filterQuery);
  const cols = batchColumns(db);
  const rows = db.prepare(`SELECT ${cols.join(', ')} FROM parcels ${where}`).all(params);
  return { rows, cols };
}

// ---- dedup keys: a row may be found by its prop_id key OR (fallback) its coordinate key ----
const propKey = (county, propId) => (propId == null || String(propId).trim() === '' ? null : `${normCounty(county)}|P:${String(propId).trim()}`);
const coordKey = (county, lat, lng) => (lat == null || lng == null ? null : `${normCounty(county)}|C:${lat},${lng}`);

// Build a map of existing Accounts(Land) rows -> { recordId, campaigns:Set } indexed under both key kinds.
async function fetchExistingLand() {
  const byKey = new Map();
  let offset = null;
  do {
    const params = new URLSearchParams({ pageSize: '100', filterByFormula: "{Asset Class}='Land'" });
    ['County', 'County Property ID', 'Coordinates', CAMPAIGN_FIELD].forEach((f) => params.append('fields[]', f));
    if (offset) params.set('offset', offset);
    const r = await axios.get(`https://api.airtable.com/v0/${BASE_ID}/${ACCOUNTS_TABLE}?${params}`, { headers: authHeaders() });
    for (const rec of r.data.records) {
      const f = rec.fields;
      const entry = { recordId: rec.id, campaigns: new Set(Array.isArray(f[CAMPAIGN_FIELD]) ? f[CAMPAIGN_FIELD] : []) };
      const pk = propKey(f.County, f['County Property ID']);
      if (pk && !byKey.has(pk)) byKey.set(pk, entry);
      if (f.Coordinates) { const ck = `${normCounty(f.County)}|C:${String(f.Coordinates).trim()}`; if (!byKey.has(ck)) byKey.set(ck, entry); }
    }
    offset = r.data.offset;
    if (offset) await sleep(220);
  } while (offset);
  return byKey;
}

function lookupExisting(byKey, row) {
  const pk = propKey(row.county, row.prop_id);
  if (pk && byKey.has(pk)) return byKey.get(pk);
  const ck = coordKey(row.county, row.rep_lat, row.rep_lng);
  if (ck && byKey.has(ck)) return byKey.get(ck);
  return null;
}

// ---- field mapping for a NEW Accounts row ----
// City/Zip fall back to the reverse-geocode columns (geo_city/geo_zip) when the CAD situs lacked them, so every
// row carries at least one of the two for skip tracing. pickStr() coerces empty/'' sentinels to undefined.
const pickStr = (v) => { const s = v == null ? '' : String(v).trim(); return s || undefined; };
function mapToAccount(row, campaignName) {
  const coords = (row.rep_lat != null && row.rep_lng != null) ? `${row.rep_lat}, ${row.rep_lng}` : null;
  const geoOrProp = (row.geo_id && String(row.geo_id).trim()) ? row.geo_id : row.prop_id;
  const f = {
    Name: coords,
    Coordinates: coords,
    'Asset Class': 'Land',
    Stage: 'Newly Added',
    County: titleCase(row.county),
    'Owner Name': row.owner_name || undefined,
    'Owner Address': row.owner_addr || undefined,
    'County Property ID': row.prop_id != null ? String(row.prop_id) : undefined,
    'Geo ID': geoOrProp != null ? String(geoOrProp) : undefined,
    // APN mirrors the County Property ID (= prop_id): that's the selector Crexi matches on.
    // (The Outreach App's Crexi pipeline later overwrites APN with Crexi's returned value.)
    APN: row.prop_id != null ? String(row.prop_id) : undefined,
    Address: row.situs_street || row.situs_raw || undefined,
    City: pickStr(row.situs_city) || pickStr(row.geo_city),
    State: pickStr(row.situs_state),
    Zip: pickStr(row.situs_zip) || pickStr(row.geo_zip),
    'Flood Zone': row.flood_zone || undefined,
    Acres: typeof row.acres === 'number' ? row.acres : undefined,
    'Year Built': row.year_built && row.year_built > 0 ? row.year_built : undefined,
    'Land - Location Text Field': row.location_text || undefined,
    [CAMPAIGN_FIELD]: [campaignName],
  };
  for (const k of Object.keys(f)) if (f[k] === undefined) delete f[k];
  return f;
}

// ---- Airtable push: create new rows, append campaign tag to existing rows ----
async function pushToAirtable(rows, campaignName, { onProgress } = {}) {
  const byKey = await fetchExistingLand();
  const toCreate = [], toAppend = [];
  for (const row of rows) {
    const hit = lookupExisting(byKey, row);
    if (!hit) toCreate.push(row);
    else if (!hit.campaigns.has(campaignName)) toAppend.push({ hit, row });
    // else: already tagged with this campaign -> nothing to do
  }

  const total = toCreate.length + toAppend.length;
  let done = 0;
  const createdLocalIds = [], touchedLocalIds = [];

  for (const group of chunk(toCreate, 10)) {
    const body = { records: group.map((row) => ({ fields: mapToAccount(row, campaignName) })), typecast: true };
    await axios.post(`https://api.airtable.com/v0/${BASE_ID}/${ACCOUNTS_TABLE}`, body, { headers: authHeaders() });
    group.forEach((row) => createdLocalIds.push(row.id));
    done += group.length;
    if (onProgress) onProgress(done, total);
    await sleep(220);
  }
  for (const group of chunk(toAppend, 10)) {
    const body = {
      records: group.map(({ hit }) => ({ id: hit.recordId, fields: { [CAMPAIGN_FIELD]: [...hit.campaigns, campaignName] } })),
      typecast: true,
    };
    await axios.patch(`https://api.airtable.com/v0/${BASE_ID}/${ACCOUNTS_TABLE}`, body, { headers: authHeaders() });
    group.forEach(({ row }) => touchedLocalIds.push(row.id));
    done += group.length;
    if (onProgress) onProgress(done, total);
    await sleep(220);
  }
  const alreadyTagged = rows.length - toCreate.length - toAppend.length;
  return { created: toCreate.length, appended: toAppend.length, alreadyTagged, createdLocalIds, touchedLocalIds };
}

// ---- Excel: every parcels column (minus geometry) + the campaign name ----
async function writeExcel(rows, cols, campaignName) {
  if (!fs.existsSync(EXPORT_DIR)) fs.mkdirSync(EXPORT_DIR, { recursive: true });
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Parcels');
  const header = [CAMPAIGN_FIELD, ...cols];
  ws.addRow(header);
  ws.getRow(1).font = { bold: true };
  for (const row of rows) ws.addRow([campaignName, ...cols.map((c) => (row[c] == null ? '' : row[c]))]);
  ws.columns.forEach((col) => { col.width = 18; });
  const safe = String(campaignName).replace(/[^a-z0-9_-]+/gi, '_').slice(0, 60);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const file = path.join(EXPORT_DIR, `${safe}_${stamp}.xlsx`);
  await wb.xlsx.writeFile(file);
  return { file, name: path.basename(file), count: rows.length };
}

module.exports = {
  listCampaignNames, isCampaignTaken, getBatchRows, pushToAirtable, writeExcel,
  fetchExistingLand, lookupExisting,
  ACCOUNTS_TABLE, CAMPAIGN_FIELD,
};
