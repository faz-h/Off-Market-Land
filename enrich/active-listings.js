'use strict';
/*
 * Active-listing cross-reference — flag parcels that overlap land actively marketed for sale.
 *
 * Source of truth is the "Airtable Land Map" base (shared base appimzak7mXU1ItI2, table tblwfc97VGFzsinTJ),
 * where every for-sale listing is stored as a single "lat, lng" string in the Coordinates field. We pull
 * all listings, build a flatbush bbox index over every parcel polygon, and for each listing point find the
 * containing parcel via turf.booleanPointInPolygon. Matches are written to parcels.listed_active /
 * listed_sold (+ representative listing info) so the UI can include/exclude on-market vs sold parcels.
 *
 * Re-runnable: it resets the previously-flagged rows first, so each run reflects the current Airtable state.
 * Run: npm run active-listings   (reads AIRTABLE_ACCESS_TOKEN / AIRTABLE_BASE_ID from .env)
 */
require('dotenv').config();
const path = require('path');
const Database = require('better-sqlite3');
const Flatbush = require('flatbush');
const turf = require('@turf/turf');

const DB_PATH = path.join(__dirname, '..', 'db', 'parcels.db');
const LISTINGS_TABLE = 'tblwfc97VGFzsinTJ'; // Airtable Land Map — for-sale listings
const FIELDS = ['Coordinates', 'Status', 'Property Link', 'List Price', 'Name', 'City'];
// Listings with this exact Status are treated as no-longer-on-market; everything else counts as active.
const SOLD_STATUS = 'Sold';
// Near-miss recovery: many listing coordinates are geocoded to the street/edge and land just outside the
// true parcel. If a point isn't inside any polygon, snap it to the nearest parcel within this many meters
// (its frontage parcel = the one being sold). Set to 0 to require exact containment only.
const SNAP_M = 30;

const LISTING_COLS = {
  listed_active: 'INTEGER',
  listed_sold: 'INTEGER',
  listing_status: 'TEXT',
  listing_price: 'REAL',
  listing_url: 'TEXT',
  listing_name: 'TEXT',
  listing_count: 'INTEGER',
  listings_at: 'TEXT',
};

// ---- pull every listing from Airtable (paginated REST, gentle on the 5 req/s limit) ----
async function fetchListings() {
  const token = process.env.AIRTABLE_ACCESS_TOKEN;
  const base = process.env.AIRTABLE_BASE_ID;
  if (!token || !base) throw new Error('AIRTABLE_ACCESS_TOKEN and AIRTABLE_BASE_ID must be set in .env');
  const out = [];
  let offset = null;
  do {
    const url = new URL(`https://api.airtable.com/v0/${base}/${LISTINGS_TABLE}`);
    url.searchParams.set('pageSize', '100');
    FIELDS.forEach((f) => url.searchParams.append('fields[]', f));
    if (offset) url.searchParams.set('offset', offset);
    const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!resp.ok) throw new Error(`Airtable ${resp.status}: ${await resp.text()}`);
    const data = await resp.json();
    for (const rec of data.records) out.push(rec.fields);
    offset = data.offset;
    if (offset) await new Promise((r) => setTimeout(r, 220)); // ~4.5 req/s
  } while (offset);
  return out;
}

// Airtable fields can come back as arrays/objects (lookups, formulas); coerce to a bindable scalar.
function txt(v) {
  if (v == null) return null;
  if (Array.isArray(v)) return v.length ? String(v[0]) : null;
  if (typeof v === 'object') return null;
  return String(v);
}
function numv(v) { return typeof v === 'number' && Number.isFinite(v) ? v : null; }

function parseCoord(s) {
  if (!s || typeof s !== 'string') return null;
  const parts = s.split(',').map((p) => parseFloat(p.trim()));
  if (parts.length < 2 || !Number.isFinite(parts[0]) || !Number.isFinite(parts[1])) return null;
  const [lat, lng] = parts;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null; // guard against swapped/garbage values
  return { lat, lng };
}

// Min/max over all coordinate pairs of a GeoJSON Polygon / MultiPolygon — cheaper than turf.bbox.
function bboxOf(geom) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const scan = (c) => {
    if (typeof c[0] === 'number') {
      if (c[0] < minX) minX = c[0];
      if (c[1] < minY) minY = c[1];
      if (c[0] > maxX) maxX = c[0];
      if (c[1] > maxY) maxY = c[1];
    } else { for (const x of c) scan(x); }
  };
  scan(geom.coordinates);
  return [minX, minY, maxX, maxY];
}

function ensureColumns(db) {
  const have = new Set(db.prepare('PRAGMA table_info(parcels)').all().map((c) => c.name));
  for (const [col, type] of Object.entries(LISTING_COLS)) {
    if (!have.has(col)) db.prepare(`ALTER TABLE parcels ADD COLUMN ${col} ${type}`).run();
  }
  db.prepare('CREATE INDEX IF NOT EXISTS parcels_listed_active ON parcels(listed_active)').run();
  db.prepare('CREATE INDEX IF NOT EXISTS parcels_listed_sold ON parcels(listed_sold)').run();
}

async function main() {
  console.time('active-listings');
  const listings = await fetchListings();
  const points = [];
  let noCoord = 0;
  for (const f of listings) {
    const c = parseCoord(f.Coordinates);
    if (!c) { noCoord++; continue; }
    points.push({
      lat: c.lat, lng: c.lng,
      sold: (txt(f.Status) || '').trim() === SOLD_STATUS,
      status: txt(f.Status),
      price: numv(f['List Price']),
      url: txt(f['Property Link']),
      name: txt(f.Name) || txt(f.City),
    });
  }
  console.log(`listings pulled: ${listings.length} (${points.length} with usable coordinates, ${noCoord} skipped)`);

  const db = new Database(DB_PATH);
  ensureColumns(db);

  // ---- build a bbox index over ALL parcels (a listing must match its true container, candidate or not) ----
  console.log('indexing parcel polygons…');
  const ids = [];
  const boxes = []; // flat [minX,minY,maxX,maxY, ...] aligned with ids
  let bad = 0;
  for (const row of db.prepare('SELECT id, geom_json FROM parcels').iterate()) {
    let g;
    try { g = JSON.parse(row.geom_json); } catch { bad++; continue; }
    const b = bboxOf(g);
    if (!Number.isFinite(b[0])) { bad++; continue; }
    ids.push(row.id);
    boxes.push(b[0], b[1], b[2], b[3]);
  }
  const idx = new Flatbush(ids.length);
  for (let i = 0; i < ids.length; i++) idx.add(boxes[i * 4], boxes[i * 4 + 1], boxes[i * 4 + 2], boxes[i * 4 + 3]);
  idx.finish();
  console.log(`parcels indexed: ${ids.length}${bad ? ` (${bad} unparseable, skipped)` : ''}`);

  // ---- point-in-polygon match: each listing -> its containing parcel ----
  const getGeom = db.prepare('SELECT geom_json FROM parcels WHERE id = ?');
  const matches = new Map(); // parcelId -> { active, sold, count, rep, repSold }
  let unmatched = 0, exactHits = 0, snapHits = 0;
  for (const L of points) {
    const cand = idx.search(L.lng, L.lat, L.lng, L.lat); // bbox contains the point
    const pt = turf.point([L.lng, L.lat]);
    let hitId = null;
    for (const ci of cand) {
      const id = ids[ci];
      const row = getGeom.get(id);
      if (!row) continue;
      let poly;
      try { poly = JSON.parse(row.geom_json); } catch { continue; }
      if (turf.booleanPointInPolygon(pt, poly)) { hitId = id; break; }
    }
    if (hitId != null) { exactHits++; }
    else if (SNAP_M > 0) {
      // no polygon contains the point — snap to the nearest parcel within SNAP_M meters
      let best = Infinity, bestId = null;
      for (const ci of idx.neighbors(L.lng, L.lat, 8)) {
        const row = getGeom.get(ids[ci]);
        if (!row) continue;
        let poly;
        try { poly = JSON.parse(row.geom_json); } catch { continue; }
        let d;
        try { d = Math.abs(turf.pointToPolygonDistance(pt, poly, { units: 'meters' })); } catch { continue; }
        if (d < best) { best = d; bestId = ids[ci]; }
      }
      if (bestId != null && best <= SNAP_M) { hitId = bestId; snapHits++; }
    }
    if (hitId == null) { unmatched++; continue; }
    let m = matches.get(hitId);
    if (!m) { m = { active: 0, sold: 0, count: 0, rep: null, repSold: true }; matches.set(hitId, m); }
    m.count++;
    if (L.sold) m.sold = 1; else m.active = 1;
    // representative listing for the popup: prefer an active listing over a sold one
    if (!m.rep || (m.repSold && !L.sold)) { m.rep = L; m.repSold = L.sold; }
  }

  // ---- write: clear prior flags, then set matched parcels ----
  const reset = db.prepare(
    'UPDATE parcels SET listed_active=NULL, listed_sold=NULL, listing_status=NULL, listing_price=NULL, '
    + 'listing_url=NULL, listing_name=NULL, listing_count=NULL, listings_at=NULL '
    + 'WHERE listed_active IS NOT NULL OR listed_sold IS NOT NULL'
  );
  const set = db.prepare(
    "UPDATE parcels SET listed_active=@active, listed_sold=@sold, listing_status=@status, listing_price=@price, "
    + "listing_url=@url, listing_name=@name, listing_count=@count, listings_at=datetime('now') WHERE id=@id"
  );
  const writeAll = db.transaction(() => {
    reset.run();
    for (const [id, m] of matches) {
      set.run({
        id, active: m.active, sold: m.sold, count: m.count,
        status: m.rep.status, price: m.rep.price, url: m.rep.url, name: m.rep.name,
      });
    }
  });
  writeAll();
  db.close();

  let activeParcels = 0, soldOnly = 0;
  for (const m of matches.values()) { if (m.active) activeParcels++; else if (m.sold) soldOnly++; }
  console.log('\nresults:');
  console.log(`  parcels flagged: ${matches.size}`);
  console.log(`    on-market (active): ${activeParcels}`);
  console.log(`    sold-only:          ${soldOnly}`);
  console.log(`  listings matched to a parcel: ${points.length - unmatched}/${points.length}`);
  console.log(`    exact (point inside polygon): ${exactHits}`);
  console.log(`    snapped (within ${SNAP_M}m of a parcel): ${snapHits}`);
  console.log(`  listings still unmatched (out of coverage): ${unmatched}`);
  console.timeEnd('active-listings');
}

main().catch((e) => { console.error(e); process.exit(1); });
