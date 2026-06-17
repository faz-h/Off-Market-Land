'use strict';
/*
 * Milestone 1 — ingest the curated parcel shapefile into SQLite (db/parcels.db).
 * - reads the source shapefile (geometry + attributes)
 * - parses the situs address (Parcel_add) into street/city/state/zip
 * - computes a validated interior representative point (used for Name/Coordinates)
 * - stores the polygon as GeoJSON text
 * Re-runnable: drops and rebuilds the parcels table each run.
 */
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const shapefile = require('shapefile');
const turf = require('@turf/turf');
const polylabel = require('polylabel');

const ROOT = path.join(__dirname, '..');
const SHP = path.join(ROOT, 'data', 'Texas Parcels Delivery v3', 'SHP', 'Texas Parcels Final 4326_v3.shp');
const DBF = path.join(ROOT, 'data', 'Texas Parcels Delivery v3', 'SHP', 'Texas Parcels Final 4326_v3.dbf');
const DB_PATH = path.join(ROOT, 'db', 'parcels.db');
const SCHEMA = path.join(ROOT, 'db', 'schema.sql');

const S = (v) => { if (v === null || v === undefined) return null; const s = String(v).trim(); return s === '' ? null : s; };
const N = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };

// "CLENS RD , BELLVILLE, TX 77418" -> {street:'CLENS RD', city:'BELLVILLE', state:'TX', zip:'77418'}
// "1132 HOLLAND ST , BELLVILLE, TX" -> {street:'1132 HOLLAND ST', city:'BELLVILLE', state:'TX', zip:null}
// "BUS HWY 290 , TX"                -> {street:'BUS HWY 290', city:null, state:'TX', zip:null}
function parseSitus(raw) {
  const out = { street: null, city: null, state: null, zip: null };
  if (!raw) return out;
  let parts = String(raw).split(',').map((x) => x.replace(/\s+/g, ' ').trim()).filter(Boolean);
  if (parts.length) {
    const last = parts[parts.length - 1];
    let m = last.match(/^([A-Za-z]{2})(?:\s+(\d{5})(?:-\d{4})?)?$/); // "TX" or "TX 77418"
    if (m) {
      out.state = m[1].toUpperCase();
      out.zip = m[2] || null;
      parts.pop();
    } else {
      m = last.match(/\b([A-Za-z]{2})\s+(\d{5})(?:-\d{4})?$/); // "...CITY TX 77418" run together
      if (m) {
        out.state = m[1].toUpperCase();
        out.zip = m[2];
        const head = last.slice(0, m.index).trim();
        if (head) parts[parts.length - 1] = head; else parts.pop();
      }
    }
  }
  if (parts.length >= 1) out.street = parts[0] || null;
  if (parts.length >= 2) out.city = parts[parts.length - 1] || null;
  out.state = out.state || 'TX'; // dataset is entirely Texas
  return out;
}

// Largest ring set of a (Multi)Polygon, for polylabel.
function largestPolygonCoords(geom) {
  if (geom.type === 'Polygon') return geom.coordinates;
  if (geom.type === 'MultiPolygon') {
    let best = null, bestArea = -1;
    for (const poly of geom.coordinates) {
      let area;
      try { area = turf.area(turf.polygon(poly)); } catch (e) { area = 0; }
      if (area > bestArea) { bestArea = area; best = poly; }
    }
    return best;
  }
  return null;
}

// Returns { lat, lng, repaired }. Keeps the source point if it falls inside the polygon,
// otherwise recomputes a guaranteed-interior point with polylabel (pole of inaccessibility).
function representativePoint(geom, srcLat, srcLng) {
  if (!geom) return { lat: srcLat, lng: srcLng, repaired: 0 };
  const feature = turf.feature(geom);
  if (srcLat != null && srcLng != null) {
    try {
      if (turf.booleanPointInPolygon(turf.point([srcLng, srcLat]), feature)) {
        return { lat: srcLat, lng: srcLng, repaired: 0 };
      }
    } catch (e) { /* fall through to recompute */ }
  }
  const coords = largestPolygonCoords(geom);
  if (coords) {
    try {
      const p = polylabel(coords, 0.000001); // [lng, lat]
      return { lat: p[1], lng: p[0], repaired: 1 };
    } catch (e) { /* fall through */ }
  }
  try {
    const c = turf.pointOnFeature(feature).geometry.coordinates; // [lng, lat]
    return { lat: c[1], lng: c[0], repaired: 1 };
  } catch (e) {
    return { lat: srcLat, lng: srcLng, repaired: 0 };
  }
}

async function main() {
  if (!fs.existsSync(SHP) || !fs.existsSync(DBF)) {
    console.error('Source shapefile not found at', SHP);
    process.exit(1);
  }

  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.exec('DROP TABLE IF EXISTS parcels;');
  db.exec(fs.readFileSync(SCHEMA, 'utf8'));

  const insert = db.prepare(`
    INSERT INTO parcels
      (prop_id, geo_id, county, owner_name, owner_addr, situs_raw,
       situs_street, situs_city, situs_state, situs_zip,
       landuse_l, landuse_st, acres, src_lat, src_lng, geom_json,
       rep_lat, rep_lng, rep_repaired)
    VALUES
      (@prop_id, @geo_id, @county, @owner_name, @owner_addr, @situs_raw,
       @situs_street, @situs_city, @situs_state, @situs_zip,
       @landuse_l, @landuse_st, @acres, @src_lat, @src_lng, @geom_json,
       @rep_lat, @rep_lng, @rep_repaired)
  `);

  let total = 0, repaired = 0, noGeom = 0;
  const rows = [];
  const source = await shapefile.open(SHP, DBF, { encoding: 'utf-8' });

  for (let r = await source.read(); !r.done; r = await source.read()) {
    const f = r.value;
    if (!f) continue;
    const p = f.properties || {};
    const geom = f.geometry || null;
    if (!geom) noGeom++;

    const srcLat = N(p.latitude);
    const srcLng = N(p.longitude);
    const rep = representativePoint(geom, srcLat, srcLng);
    if (rep.repaired) repaired++;

    const situs = parseSitus(p.Parcel_add);
    rows.push({
      prop_id: S(p.Prop_ID),
      geo_id: S(p.GEO_ID),
      county: S(p.County),
      owner_name: S(p.Owner_name),
      owner_addr: S(p.Owner_add),
      situs_raw: S(p.Parcel_add),
      situs_street: situs.street,
      situs_city: situs.city,
      situs_state: situs.state,
      situs_zip: situs.zip,
      landuse_l: S(p.Landuse_L),
      landuse_st: S(p.Landuse_ST),
      acres: N(p.Area_acres),
      src_lat: srcLat,
      src_lng: srcLng,
      geom_json: geom ? JSON.stringify(geom) : null,
      rep_lat: rep.lat,
      rep_lng: rep.lng,
      rep_repaired: rep.repaired,
    });
    total++;
    if (total % 5000 === 0) console.log(`  read ${total} parcels...`);
  }

  const insertMany = db.transaction((items) => { for (const it of items) insert.run(it); });
  insertMany(rows);

  // ---- verification ----
  const count = db.prepare('SELECT COUNT(*) n FROM parcels').get().n;
  const byCounty = db.prepare('SELECT county, COUNT(*) n FROM parcels GROUP BY county ORDER BY n DESC').all();
  const blankGeo = db.prepare("SELECT county, COUNT(*) n FROM parcels WHERE geo_id IS NULL GROUP BY county ORDER BY n DESC").all();
  const noSitus = db.prepare('SELECT COUNT(*) n FROM parcels WHERE situs_city IS NULL').get().n;
  const harris = db.prepare("SELECT prop_id, geo_id, situs_street, situs_city, situs_zip, acres FROM parcels WHERE county='HARRIS' LIMIT 3").all();
  const waller = db.prepare("SELECT prop_id, geo_id, situs_street, situs_city, situs_zip, acres FROM parcels WHERE county='WALLER' LIMIT 3").all();

  console.log('\n=== INGEST COMPLETE ===');
  console.log('rows inserted:', count, '(expected 45529)');
  console.log('features without geometry:', noGeom);
  console.log('interior points repaired:', repaired, `(${(100 * repaired / count).toFixed(1)}%)`);
  console.log('rows missing parsed city:', noSitus);
  console.log('\nby county:'); byCounty.forEach((c) => console.log(`  ${c.county}: ${c.n}`));
  console.log('\nblank geo_id by county (Harris should dominate):'); blankGeo.forEach((c) => console.log(`  ${c.county}: ${c.n}`));
  console.log('\nsample HARRIS rows:'); harris.forEach((x) => console.log('  ', x));
  console.log('\nsample WALLER rows:'); waller.forEach((x) => console.log('  ', x));

  db.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
