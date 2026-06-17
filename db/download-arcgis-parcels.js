'use strict';
/*
 * Page a county parcel ArcGIS FeatureServer/MapServer down to local NDJSON {p:<attrs>, g:<WGS84 geometry>},
 * consumed by db/ingest-county.js (sources with an `ndjson` path). For counties whose CAD publishes via an
 * ArcGIS Hub / Open Data / hosted service rather than a downloadable shapefile (Montgomery, Waller, Liberty,
 * Chambers). All are requested with f=geojson&outSR=4326 so geometry arrives already in WGS84.
 *
 * Usage: node db/download-arcgis-parcels.js <county-key>
 *
 * Paging: increments resultOffset by the actual feature count and stops when a page returns 0 features
 * (offset past the end), which is robust to per-service maxRecordCount differences (FeatureServer 2000 vs
 * Chambers MapServer 1000). Some services need orderByFields for stable offset paging.
 */
const fs = require('fs');
const path = require('path');
const axios = require('axios');

const RAW = (c) => path.join(__dirname, '..', 'data', 'county-raw', c, 'parcels.ndjson');

const SOURCES = {
  // ---- MONTGOMERY (MCAD) — hosted FeatureServer ----
  montgomery: {
    url: 'https://services1.arcgis.com/PRoAPGnMSUqvTrzq/arcgis/rest/services/Tax_Parcel_view/FeatureServer/0/query',
    outFields: 'PIN,pid,ownerName,ownerAddress,stateCd,exemptions,situs,imprvMainArea,imprvActualYearBuilt,Shape__Area',
    page: 2000, out: RAW('montgomery'),
  },

  // ---- WALLER (WCAD) — BIS-hosted WallerCADWebService FeatureServer, inline imprv_val (0=vacant) ----
  // PACS/TrueAutomation schema (file_as_name owner, legal_acreage, imprv_val). No state-class field. ~52k.
  waller: {
    url: 'https://utility.arcgis.com/usrsvcs/servers/2abd8b401a9d401a9940b891a2d677a4/rest/services/WallerCADWebService/FeatureServer/0/query',
    outFields: 'prop_id,geo_id,file_as_name,addr_line1,addr_line2,addr_line3,addr_city,addr_state,zip,situs_num,situs_street_prefx,situs_street,situs_street_sufix,situs_city,situs_state,situs_zip,legal_acreage,imprv_val',
    orderByFields: 'prop_id', page: 2000, out: RAW('waller'),
  },

  // ---- LIBERTY (LCAD) — BIS-hosted LibertyCADWebService FeatureServer, inline imprv_val (0=vacant) ----
  // Same PACS schema as Waller. ~155k features (some have null geometry / placeholder rows the acreage
  // filter drops). No state-class field in this layer.
  liberty: {
    url: 'https://services3.arcgis.com/LbQai106UcFy2LlR/arcgis/rest/services/LibertyCADWebService/FeatureServer/0/query',
    outFields: 'prop_id,geo_id,file_as_name,addr_line1,addr_line2,addr_line3,addr_city,addr_state,zip,situs_num,situs_street_prefx,situs_street,situs_street_sufix,situs_city,situs_state,situs_zip,legal_acreage,imprv_val',
    orderByFields: 'prop_id', page: 2000, out: RAW('liberty'),
  },

  // ---- CHAMBERS (ChCAD) — Pandai-hosted MapServer (TaxParcels JOINED to Accounts) ----
  // Fields are table-qualified (ChambersCADWeb.DBO.Accounts.* / .TaxParcels.*). Improvement value is NOT in
  // this service (Market_Value unpopulated) -> ingest joins the certified-roll CSV for vacancy. maxRecordCount
  // 1000. Dedup on Parcel_CAMA. outFields=* keeps it simple (only ~38k rows).
  chambers: {
    url: 'https://gisdata.pandai.com/pamaps02/rest/services/Chambers/ChambersCADPublic/MapServer/0/query',
    outFields: '*', orderByFields: 'ChambersCADWeb.DBO.TaxParcels.OBJECTID', page: 1000, out: RAW('chambers'),
  },

  // ---- HARRIS (HCAD) — Harris County GIS HCAD/Parcels MapServer, DENORMALIZED (geometry + owner + value inline) ----
  // 1.55M parcels total; the layer carries owner/situs/state_class/impr_value/acreage_1 inline, so no roll join.
  // PRE-FILTER the download to the 0.5–50ac buy-box (acreage_1) so we page ~141k instead of 1.55M. EPSG:2278 ->
  // outSR=4326. maxRecordCount 1000. Vacancy = impr_value (0 = vacant, like FBCAD/GCAD improvement value).
  harris: {
    url: 'https://www.gis.hctx.net/arcgis/rest/services/HCAD/Parcels/MapServer/0/query',
    where: 'acreage_1>=0.5 AND acreage_1<=50',
    outFields: 'HCAD_NUM,acct_num,owner_name_1,owner_name_2,owner_name_3,mail_addr_1,mail_addr_2,mail_city,mail_state,mail_zip,site_str_pfx,site_str_num,site_str_num_sfx,site_str_name,site_str_sfx,site_str_sfx_dir,site_city,site_zip,state_class,acreage_1,land_value,bld_value,impr_value,land_use',
    // self-hosted MapServer + a SELECTIVE non-indexed filter (acreage_1) breaks every streaming pager (offset AND
    // keyset die in sparse OID regions; windowed tiling missed ~1.6% to transient empties). MOST RELIABLE: pull the
    // full matching id set once via returnIdsOnly (lightweight, no scan/timeout), then fetch by objectIds (by-PK,
    // no scan) in batches with retry — guaranteed-complete.
    idList: true, idBatch: 200, oidField: 'OBJECTID', pageSleep: 100, out: RAW('harris'),
  },
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(url, params, tries = 5) {
  for (let a = 0; a < tries; a++) {
    try { const { data } = await axios.get(url, { params, timeout: 120000 }); return data; }
    catch (e) { if (a === tries - 1) throw e; await sleep(1500 * (a + 1)); }
  }
}

async function main() {
  const key = process.argv[2];
  const cfg = SOURCES[key];
  if (!cfg) { console.error('Usage: node db/download-arcgis-parcels.js <county>\n  known:', Object.keys(SOURCES).join(', ')); process.exit(1); }
  fs.mkdirSync(path.dirname(cfg.out), { recursive: true });

  // Fetch the total up front so we can distinguish a genuine end-of-data from a TRANSIENT empty page (these
  // servers occasionally return an empty features array under load even though more records remain — breaking
  // on feats.length===0 alone truncates the download, e.g. Harris stopped at 53k of 141k).
  let total = null;
  try { total = (await get(cfg.url, { where: cfg.where || '1=1', returnCountOnly: true, f: 'json' })).count; console.log(`expecting ~${total} parcels`); }
  catch (e) { console.warn('count query failed — paging until empty:', e.message); }

  const ws = fs.createWriteStream(cfg.out);
  let written = 0, nogeom = 0, pages = 0;
  const writeFeats = (feats) => { for (const ft of feats) { if (ft.geometry) { ws.write(JSON.stringify({ p: ft.properties, g: ft.geometry }) + '\n'); written++; } else nogeom++; } };

  if (cfg.idList) {
    // ID-LIST extraction (gold standard for selective filters on a flaky self-hosted MapServer): one returnIdsOnly
    // call for ALL matching OBJECTIDs, then fetch by objectIds (by-PK, never scans/times out) in retried batches.
    // SELF-HEALING: track which OBJECTIDs actually return (geojson feature.id) and reconcile any missing ones with
    // patient retries, so a few throttled batches don't silently drop records.
    const idd = await get(cfg.url, { where: cfg.where || '1=1', returnIdsOnly: true, f: 'json' });
    const ids = idd.objectIds || (idd.properties && idd.properties.objectIds) || [];
    const B = cfg.idBatch || 200;
    const oid = cfg.oidField || 'OBJECTID';
    const got = new Set();
    const trackId = (ft) => (ft.properties && ft.properties[oid] != null) ? ft.properties[oid] : ft.id; // geojson omits feature.id unless oid is in outFields
    const fetchBatch = async (batch, tries) => {
      for (let r = 0; r < tries; r++) {
        const data = await get(cfg.url, { objectIds: batch.join(','), outFields: `${cfg.outFields},${oid}`, returnGeometry: true, outSR: 4326, geometryPrecision: 6, f: 'geojson' });
        const feats = data.features || [];
        if (feats.length > 0) return feats;
        await sleep(2500 * (r + 1)); // transient empty -> wait out the throttle window, retry the same by-PK set
      }
      return [];
    };
    console.log(`got ${ids.length} object ids; fetching by objectIds in batches of ${B}`);
    for (let i = 0; i < ids.length; i += B) {
      const feats = await fetchBatch(ids.slice(i, i + B), 6);
      for (const ft of feats) { const v = trackId(ft); if (v != null) got.add(v); }
      writeFeats(feats);
      if (++pages % 20 === 0) console.log(`  ${written}/${ids.length} written (got ${got.size}, null-geom ${nogeom})`);
      await sleep(cfg.pageSleep || 100);
    }
    let missing = ids.filter((x) => !got.has(x));
    if (missing.length) {
      console.log(`reconciling ${missing.length} missing ids (smaller batches, patient retries)...`);
      for (let i = 0; i < missing.length; i += 50) {
        const feats = await fetchBatch(missing.slice(i, i + 50), 12);
        for (const ft of feats) { const v = trackId(ft); if (v != null) got.add(v); }
        writeFeats(feats);
        await sleep(400);
      }
      const still = ids.filter((x) => !got.has(x));
      if (still.length) console.warn(`  ! ${still.length} ids STILL missing after reconcile: ${still.slice(0, 10).join(',')}${still.length > 10 ? '…' : ''}`);
      else console.log('reconcile complete — all ids fetched');
    }
  } else if (cfg.oidWindow) {
    // OID-WINDOW tiling — for a self-hosted MapServer with a SELECTIVE non-indexed WHERE (e.g. acreage_1), where
    // keyset/offset both die in sparse regions. Each query is bounded to an OID span [lo,hi) so the server never
    // scans far. Within a window, resultOffset sub-pages (bounded, small) if >page matches.
    const oid = cfg.oidField, STEP = cfg.oidWindow;
    let maxOid = 0;
    try {
      const st = await get(cfg.url, { where: cfg.where || '1=1', outStatistics: JSON.stringify([{ statisticType: 'max', onStatisticField: oid, outStatisticFieldName: 'm' }]), f: 'json' });
      maxOid = st.features?.[0]?.attributes?.m || 0;
    } catch (e) { /* fall through */ }
    if (!maxOid) { const d = await get(cfg.url, { where: cfg.where || '1=1', outFields: oid, orderByFields: `${oid} DESC`, resultRecordCount: 1, returnGeometry: false, f: 'json' }); maxOid = d.features?.[0]?.attributes?.[oid] || 2000000; }
    console.log(`tiling OID 0..${maxOid} in windows of ${STEP} (expecting ~${total})`);
    for (let lo = 0; lo <= maxOid; lo += STEP) {
      const hi = lo + STEP;
      let innerOff = 0;
      for (;;) {
        const params = { where: `(${cfg.where || '1=1'}) AND ${oid} >= ${lo} AND ${oid} < ${hi}`, outFields: `${cfg.outFields},${oid}`, returnGeometry: true, outSR: 4326, geometryPrecision: 6, f: 'geojson', resultOffset: innerOff, resultRecordCount: cfg.page, orderByFields: oid };
        const data = await get(cfg.url, params);
        const feats = data.features || [];
        writeFeats(feats);
        innerOff += feats.length;
        const more = data.exceededTransferLimit || (data.properties && data.properties.exceededTransferLimit);
        if (feats.length === 0 || !more) break;
      }
      if (++pages % 20 === 0) console.log(`  ${written} written (oid<${hi}/${maxOid}, null-geom ${nogeom})`);
      await sleep(cfg.pageSleep || 120);
    }
  } else if (cfg.oidField) {
    // KEYSET pagination by OBJECTID — `WHERE oid > lastSeen` ordered by oid (indexed range scan). Scales to
    // millions and avoids the self-hosted-MapServer deep-resultOffset failure (which silently returns empty).
    const oid = cfg.oidField;
    let last = -1;
    for (;;) {
      const where = `(${cfg.where || '1=1'}) AND ${oid} > ${last}`;
      const params = { where, outFields: `${cfg.outFields},${oid}`, returnGeometry: true, outSR: 4326, geometryPrecision: 6, f: 'geojson', resultRecordCount: cfg.page, orderByFields: oid };
      let data = await get(cfg.url, params);
      let feats = data.features || [];
      // The self-hosted MapServer throttles after a burst of requests and returns an EMPTY array (not an error)
      // even though data remains. The keyset query is deterministic, so retry the SAME query patiently — this
      // lets the rate-limit window clear and resumes exactly where we left off. (Both prior runs died at 53k.)
      if (feats.length === 0 && total != null && written + nogeom < total) {
        for (let r = 0; r < 8 && feats.length === 0; r++) { await sleep(4000 * (r + 1)); data = await get(cfg.url, params); feats = data.features || []; }
        if (feats.length === 0) { console.warn(`  ! empty after retries at oid>${last} (${written}/${total}) — stopping`); break; }
      }
      if (feats.length === 0) break; // genuine end
      let maxOid = last;
      for (const ft of feats) { const v = (ft.properties && ft.properties[oid] != null) ? ft.properties[oid] : ft.id; if (v != null && v > maxOid) maxOid = v; }
      writeFeats(feats);
      if (maxOid <= last) { console.warn(`  ! oid did not advance (${maxOid}) — stopping to avoid loop`); break; }
      last = maxOid;
      if (++pages % 10 === 0) console.log(`  ${written} written (oid>${last}/${total ?? '?'}, null-geom ${nogeom})`);
      if (feats.length < cfg.page) break; // last partial page
      await sleep(cfg.pageSleep || 80);
    }
  } else {
    let off = 0;
    for (;;) {
      const params = {
        where: cfg.where || '1=1', outFields: cfg.outFields, returnGeometry: true, outSR: 4326,
        geometryPrecision: 6, f: 'geojson', resultOffset: off, resultRecordCount: cfg.page,
      };
      if (cfg.orderByFields) params.orderByFields = cfg.orderByFields;
      let data = await get(cfg.url, params);
      let feats = data.features || [];
      // mid-stream empty (off < total) => treat as transient, retry the SAME offset before giving up
      if (feats.length === 0 && total != null && off < total) {
        for (let r = 0; r < 6 && feats.length === 0; r++) { await sleep(2000 * (r + 1)); data = await get(cfg.url, params); feats = data.features || []; }
        if (feats.length === 0) { console.warn(`  ! offset ${off} still empty after retries (<${total}) — stopping with ${written}`); break; }
      }
      if (feats.length === 0) break; // genuine end (off >= total or no total known)
      writeFeats(feats);
      off += feats.length;
      if (++pages % 10 === 0) console.log(`  ${written} written (offset ${off}/${total ?? '?'}, null-geom ${nogeom})`);
      if (total != null && off >= total) break; // reached the known total
      await sleep(80);
    }
  }
  await new Promise((r) => ws.end(r));
  const short = total != null && written + nogeom < total ? `  *** WARNING: ${written + nogeom} < expected ${total}` : '';
  console.log(`done — wrote ${written} parcels (skipped ${nogeom} null-geom)${total != null ? ` of ~${total}` : ''} -> ${path.relative(path.join(__dirname, '..'), cfg.out)}${short}`);
}
main().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
