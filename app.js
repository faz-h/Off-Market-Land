'use strict';
require('dotenv').config();
const path = require('path');
const express = require('express');
const Database = require('better-sqlite3');
const { buildWhere, hexRing } = require('./services/query');
const exportSvc = require('./services/export');
const { geocodeUncached, geocodeCityZipUncached, ensureLocationColumns } = require('./services/geocode');
const { registerGeoFns } = require('./services/geo');

const app = express();
const DB_PATH = process.env.DB_FILE || path.join(__dirname, 'db', 'parcels.db'); // DB_FILE points at the Railway volume in prod
const H3_RES = [5, 6, 7, 8]; // whitelist — guards the dynamic h3_rN column name

let db = null;   // read-only, for queries
let dbw = null;  // writable, for exclude list + export stamping + geocode cache
try {
  // open writable first and ensure export columns + spatial index exist, so the read-only handle sees them
  dbw = new Database(DB_PATH, { fileMustExist: true });
  ensureLocationColumns(dbw);
  dbw.prepare('CREATE INDEX IF NOT EXISTS parcels_rep ON parcels(rep_lat, rep_lng)').run();
  db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
  registerGeoFns(db); // drawn-area polygon UDF, used by buildWhere on the query connection
} catch (e) {
  console.warn('[warn] db/parcels.db not found — run `npm run ingest` first.');
}

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

const noDb = (res) => res.status(503).json({ error: 'db not built; run `npm run ingest`' });

// Unfiltered parcel totals per hex (rate denominators), computed once per resolution.
const hexTotals = {};
function totalsForRes(r) {
  if (!hexTotals[r]) {
    const m = new Map();
    for (const row of db.prepare(`SELECT h3_r${r} cell, COUNT(*) n FROM parcels WHERE h3_r${r} IS NOT NULL GROUP BY h3_r${r}`).all()) {
      m.set(row.cell, row.n);
    }
    hexTotals[r] = m;
  }
  return hexTotals[r];
}

app.get('/', (req, res) => res.render('index'));

app.get('/api/health', (req, res) => res.json({ ok: true, dbReady: !!db }));

app.get('/api/stats', (req, res) => {
  if (!db) return noDb(res);
  const total = db.prepare('SELECT COUNT(*) n FROM parcels').get().n;
  const byCounty = db.prepare('SELECT county, COUNT(*) n FROM parcels GROUP BY county ORDER BY n DESC').all();
  res.json({ total, byCounty });
});

// Live count + per-county profile for the current filter set.
app.get('/api/count', (req, res) => {
  if (!db) return noDb(res);
  const { where, params } = buildWhere(req.query);
  const total = db.prepare(`SELECT COUNT(*) n FROM parcels ${where}`).get(params).n;
  const byCounty = db.prepare(`SELECT county, COUNT(*) n FROM parcels ${where} GROUP BY county ORDER BY n DESC`).all(params);
  res.json({ total, byCounty });
});

// Hex choropleth: one feature per occupied H3 cell, with filtered count + unfiltered total + rate.
app.get('/api/aggregate', (req, res) => {
  if (!db) return noDb(res);
  const r = Number(req.query.res);
  if (!H3_RES.includes(r)) return res.status(400).json({ error: `res must be one of ${H3_RES.join(',')}` });
  const col = `h3_r${r}`;
  const { where, params } = buildWhere(req.query);
  const w = where ? `${where} AND ${col} IS NOT NULL` : `WHERE ${col} IS NOT NULL`;
  const rows = db.prepare(`SELECT ${col} cell, COUNT(*) n FROM parcels ${w} GROUP BY ${col}`).all(params);
  const totals = totalsForRes(r);
  const features = rows.map((row) => {
    const total = totals.get(row.cell) || row.n;
    return {
      type: 'Feature',
      geometry: { type: 'Polygon', coordinates: [hexRing(row.cell)] },
      properties: { h3: row.cell, count: row.n, total, rate: total ? row.n / total : 0 },
    };
  });
  res.json({ type: 'FeatureCollection', res: r, features });
});

// Individual-parcel drill-down within a bbox, capped. geom=point returns lightweight rep-point markers
// (no polygon geometry) for the zoomed-out "scatter" tier; default returns full parcel polygons.
app.get('/api/parcels', (req, res) => {
  if (!db) return noDb(res);
  const asPoint = req.query.geom === 'point';
  const { where, params } = buildWhere(req.query);
  const p = { ...params };
  let w = where;
  const bbox = String(req.query.bbox || '').split(',').map(Number);
  if (bbox.length === 4 && bbox.every(Number.isFinite)) {
    const [minLng, minLat, maxLng, maxLat] = bbox;
    const clause = 'rep_lng BETWEEN @minLng AND @maxLng AND rep_lat BETWEEN @minLat AND @maxLat';
    w = w ? `${w} AND ${clause}` : `WHERE ${clause}`;
    Object.assign(p, { minLng, minLat, maxLng, maxLat });
  }
  const limit = Math.min(Number(req.query.limit) || (asPoint ? 6000 : 2000), asPoint ? 12000 : 5000);
  const matched = db.prepare(`SELECT COUNT(*) n FROM parcels ${w}`).get(p).n;
  const cols = 'prop_id, county, owner_name, is_public, public_reason, landuse_st, improvement_value, acres, '
    + 'width_ft, width_mean_ft, elongation, situs_street, situs_city, flood_zone, frontage_aadt, '
    + 'near_road_ft, near_road_aadt, near_road_name, near_road_frontier, rep_lat, rep_lng, '
    + 'listed_active, listed_sold, listing_status, listing_price, listing_url, listing_name, '
    + 'estate_flag, estate_reason'
    + (asPoint ? '' : ', geom_json');
  const rows = db.prepare(`SELECT ${cols} FROM parcels ${w} LIMIT @limit`).all({ ...p, limit });
  const features = rows.map((row) => ({
    type: 'Feature',
    geometry: asPoint
      ? { type: 'Point', coordinates: [row.rep_lng, row.rep_lat] }
      : JSON.parse(row.geom_json),
    properties: {
      prop_id: row.prop_id, county: row.county, owner: row.owner_name,
      is_public: row.is_public, public_reason: row.public_reason,
      landuse: row.landuse_st, improvement_value: row.improvement_value,
      acres: row.acres, width_ft: row.width_ft, width_mean_ft: row.width_mean_ft, elongation: row.elongation,
      situs: [row.situs_street, row.situs_city].filter(Boolean).join(', '),
      flood_zone: row.flood_zone, aadt: row.frontage_aadt,
      near_road_ft: row.near_road_ft, near_road_aadt: row.near_road_aadt, near_road_name: row.near_road_name,
      near_road_frontier: (() => { try { return row.near_road_frontier ? JSON.parse(row.near_road_frontier) : null; } catch (e) { return null; } })(),
      lat: row.rep_lat, lng: row.rep_lng,
      listed_active: row.listed_active, listed_sold: row.listed_sold, listing_status: row.listing_status,
      listing_price: row.listing_price, listing_url: row.listing_url, listing_name: row.listing_name,
      estate_flag: row.estate_flag, estate_reason: row.estate_reason,
    },
  }));
  res.json({ type: 'FeatureCollection', geom: asPoint ? 'point' : 'polygon', matched, returned: features.length, capped: matched > features.length, features });
});

// Manual exclude list — hand-curate edge cases the heuristics can't cleanly catch.
// POST /api/exclude?prop_id=R123  (add ?undo=1 to put it back). Excluded parcels drop from every view.
app.post('/api/exclude', (req, res) => {
  if (!dbw) return res.status(503).json({ error: 'db not writable' });
  const propId = String(req.query.prop_id || '').trim();
  if (!propId) return res.status(400).json({ error: 'prop_id required' });
  const val = req.query.undo === '1' ? 0 : 1;
  const info = dbw.prepare('UPDATE parcels SET excluded_manual = ? WHERE prop_id = ?').run(val, propId);
  res.json({ ok: true, prop_id: propId, excluded: val, changed: info.changes });
});

// ---- campaign export (Airtable + Excel) -------------------------------------------------------------
// In-memory jobs: an export can run for minutes (geocoding + rate-limited Airtable writes), so POST starts a
// job and the client polls /api/export/status/:id. Jobs are kept ~1h for status/download then evicted.
const jobs = new Map();
const newJobId = () => 'job_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

// Existing campaign names — lets the UI warn about duplicates before submitting.
app.get('/api/export/campaigns', async (req, res) => {
  try { res.json({ names: await exportSvc.listCampaignNames() }); }
  catch (e) { res.status(502).json({ error: 'could not read campaigns from Airtable', detail: String(e.message || e) }); }
});

app.post('/api/export', async (req, res) => {
  if (!db || !dbw) return noDb(res);
  const body = req.body || {};
  const campaignName = String(body.campaignName || '').trim();
  const toAirtable = !!body.airtable;
  const toExcel = !!body.excel;
  const filters = body.filters && typeof body.filters === 'object' ? body.filters : {};
  if (!campaignName) return res.status(400).json({ error: 'campaignName is required' });
  if (!toAirtable && !toExcel) return res.status(400).json({ error: 'choose at least one destination (airtable and/or excel)' });

  // Campaign names must be unique — appending an already-used name would silently merge two batches.
  try {
    if (await exportSvc.isCampaignTaken(campaignName)) {
      return res.status(409).json({ error: `campaign name "${campaignName}" is already in use — choose a unique name` });
    }
  } catch (e) {
    return res.status(502).json({ error: 'could not verify campaign-name uniqueness against Airtable', detail: String(e.message || e) });
  }

  let rows, cols;
  try { ({ rows, cols } = exportSvc.getBatchRows(db, filters)); }
  catch (e) { return res.status(500).json({ error: 'batch query failed', detail: String(e.message || e) }); }
  if (!rows.length) return res.status(400).json({ error: 'the current filter matches 0 parcels' });

  const id = newJobId();
  const job = {
    id, campaignName, phase: 'starting', total: rows.length,
    geocode: { done: 0, total: 0 }, airtable: { done: 0, total: 0 },
    excel: null, summary: null, error: null, destinations: { airtable: toAirtable, excel: toExcel },
  };
  jobs.set(id, job);
  runExportJob(job, rows, cols).catch((e) => { job.phase = 'error'; job.error = String(e.message || e); });
  res.json({ jobId: id, count: rows.length, destinations: job.destinations });
});

async function runExportJob(job, rows, cols) {
  // 1) geocode (cached): fills location_text for any batch parcel never geocoded
  job.phase = 'geocoding';
  await geocodeUncached(dbw, rows, {
    apiKey: process.env.GOOGLE_API_KEY,
    onProgress: (done, total) => { job.geocode = { done, total }; },
  });
  // 1b) city/zip fallback (cached): for parcels the CAD gave NEITHER a situs city NOR zip, reverse-geocode the
  //     interior point so the export's City/Zip fallback guarantees at least one of the two on every row.
  await geocodeCityZipUncached(dbw, rows, {
    apiKey: process.env.GOOGLE_API_KEY,
    onProgress: (done, total) => { job.geocode = { done, total }; },
  });

  // 2) Airtable upsert
  if (job.destinations.airtable) {
    job.phase = 'airtable';
    const r = await exportSvc.pushToAirtable(rows, job.campaignName, {
      onProgress: (done, total) => { job.airtable = { done, total }; },
    });
    job.airtableResult = { created: r.created, appended: r.appended, alreadyTagged: r.alreadyTagged };
    // stamp exported_at on every parcel we created or re-tagged
    const ids = [...r.createdLocalIds, ...r.touchedLocalIds];
    if (ids.length) {
      const stamp = dbw.prepare("UPDATE parcels SET exported_at = datetime('now') WHERE id = ?");
      dbw.transaction((list) => list.forEach((pid) => stamp.run(pid)))(ids);
    }
  }

  // 3) Excel
  if (job.destinations.excel) {
    job.phase = 'excel';
    job.excel = await exportSvc.writeExcel(rows, cols, job.campaignName);
  }

  job.phase = 'done';
  job.summary = {
    total: job.total,
    airtable: job.airtableResult || null,
    excel: job.excel ? { name: job.excel.name, count: job.excel.count } : null,
  };
  // evict after 1 hour
  setTimeout(() => jobs.delete(job.id), 60 * 60 * 1000).unref?.();
}

app.get('/api/export/status/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'job not found' });
  const { id, phase, total, geocode, airtable, error, summary, destinations } = job;
  res.json({ id, phase, total, geocode, airtable, error, summary, destinations, excelReady: !!job.excel });
});

app.get('/api/export/download/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job || !job.excel) return res.status(404).json({ error: 'no export file for this job' });
  res.download(job.excel.file, job.excel.name);
});

const PORT = process.env.PORT || 3200;
app.listen(PORT, () => console.log(`Off Market Land listening on http://localhost:${PORT}`));
