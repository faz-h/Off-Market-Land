'use strict';
/*
 * Ingest ALL parcels for one county from its source shapefile into db/parcels.db, applying the cheap
 * attribute filter (acreage 0.5–50) while streaming and computing geometry signals on survivors only:
 * the interior rep-point and the inscribed-circle width_ft (both from a single polylabel in native
 * feet), plus reprojection to WGS84 for storage. Public/HOA exclusion (owner-review.js) and footprint
 * coverage (enrich/footprints.js) are separate downstream passes.
 *
 * Usage: node db/ingest-county.js <county> [--init]
 *   --init  drop & recreate the parcels table from schema.sql first (fresh DB / proof run)
 * Re-runnable per county: deletes that county's rows (by `source`) before reinserting, leaving others.
 */
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const shapefile = require('shapefile');
const readline = require('readline');
const util = require('./parcel-util');

const ROOT = path.join(__dirname, '..');
const DB_PATH = path.join(ROOT, 'db', 'parcels.db');
const SCHEMA = path.join(ROOT, 'db', 'schema.sql');
const ACRES_MIN = 0.5, ACRES_MAX = 50;
const FLUSH = 20000;

const FB = path.join(ROOT, 'data', 'county-raw', 'fort-bend', 'extracted',
  'FBCAD 2026 Preliminary GIS Data - Parcels and Shapefiles', 'Shapefiles', 'CamaSummary', 'CamaSummary');
const BR = path.join(ROOT, 'data', 'county-raw', 'brazoria', 'extracted', 'PARCELS_W_OWNER');
const GV = path.join(ROOT, 'data', 'county-raw', 'galveston', 'extracted', 'parcels');
const BR_IMPROVEMENTS = path.join(ROOT, 'data', 'county-raw', 'brazoria', 'roll', 'ProTax_ImprovementExport.txt');
const AU = path.join(ROOT, 'data', 'county-raw', 'austin', 'extracted', 'shp', 'stratmap25-landparcels_48015_austin_202503');
const CH_ROLL = path.join(ROOT, 'data', 'county-raw', 'chambers', 'roll', 'certified.csv');
const NDJSON = (c) => path.join(ROOT, 'data', 'county-raw', c, 'parcels.ndjson');

const parseAcres = (s) => { if (s == null) return null; const n = Number(String(s).replace(/[^0-9.]/g, '')); return Number.isFinite(n) ? n : null; };

// Minimal RFC-4180-ish CSV line splitter (handles "quoted, fields" and "" escapes). Single-line rows only.
function parseCsvLine(line) {
  const out = []; let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) { if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch; }
    else if (ch === ',') { out.push(cur); cur = ''; }
    else if (ch === '"') q = true;
    else cur += ch;
  }
  out.push(cur); return out;
}

// PACS/TrueAutomation FeatureServer rows (Waller, Liberty): owner=file_as_name, acreage=legal_acreage,
// inline imprv_val (0=vacant). Assembled situs/mailing from the split columns.
function mapPacs(p) {
  const situs = [util.S(p.situs_num), util.S(p.situs_street_prefx), util.S(p.situs_street), util.S(p.situs_street_sufix)].filter(Boolean).join(' ');
  const situsFull = [situs || null, util.S(p.situs_city), util.S(p.situs_state), util.S(p.situs_zip)].filter(Boolean).join(', ') || null;
  const mail = [util.S(p.addr_line1), util.S(p.addr_line2), util.S(p.addr_line3), util.S(p.addr_city), util.S(p.addr_state), util.S(p.zip)].filter(Boolean).join(', ') || null;
  return {
    prop_id: util.S(p.prop_id), geo_id: util.S(p.geo_id), owner_name: util.S(p.file_as_name), owner_addr: mail,
    situs_raw: situsFull, landuse_st: null, landuse_l: null, acres: util.N(p.legal_acreage),
    improvement_value: util.N(p.imprv_val), year_built: null, exemptions: null,
  };
}

// Per-county source config. `map` translates the source DBF row -> our columns; add an entry per county.
const COUNTY_SOURCES = {
  'fort-bend': {
    county: 'FORT BEND', source: 'fbcad:FORT BEND',
    shp: FB + '.shp', dbf: FB + '.dbf', prj: FB + '.prj',
    map: (p) => ({
      prop_id: util.S(p.CAD_Refere),
      geo_id: util.S(p.Property_N),
      owner_name: util.S(p.Owner_Name),
      owner_addr: [util.S(p.Owner_Ad_1) || util.S(p.Owner_Addr), util.S(p.Owner_City), util.S(p.Owner_Stat), util.S(p.Owner_Zip)].filter(Boolean).join(', ') || null,
      situs_raw: util.S(p.Situs),
      landuse_st: util.S(p.Land_State),
      landuse_l: util.S(p.Land_Type),
      acres: util.N(p.Land_Size1) ?? (util.N(p.Shape_Area) != null ? util.N(p.Shape_Area) / 43560 : null),
      improvement_value: util.N(p.Improvemen),
      year_built: util.N(p.Year_Built),
      exemptions: util.S(p.Exemptions),
    }),
  },

  // ---- BRAZORIA (BCAD) ----
  // PROVENANCE: parcels from pCloud "(A) PARCEL LAYERS / PARCELS_W_OWNER.zip" (folder code
  //   kZoNOV7ZOPpNSuilWqzXtn2DVMVYTuQWx1tV — resolve via api.pcloud.com getpublinkdownload); EPSG:2278 ft.
  //   Carries geometry + owner (file_as_na) + acreage (string "X.XX ac") + state class (state_cd) + situs.
  // ROLL DECODE: improvement value is NOT in the shapefile. ProTax export (brazoriacad.org/.../ProTax_*.zip)
  //   `ProTax_ImprovementExport.txt` is the building inventory (pipe-delimited, col[0]=prop_id). TIER-1
  //   VACANCY = prop_id ABSENT from that file. Validated: state-class A/B/F ~98% present, C(vacant) ~0%.
  'brazoria': {
    county: 'BRAZORIA', source: 'bcad:BRAZORIA',
    shp: BR + '.shp', dbf: BR + '.dbf', prj: BR + '.prj',
    prepare: async () => {
      const improved = new Set();
      const rl = readline.createInterface({ input: fs.createReadStream(BR_IMPROVEMENTS) });
      for await (const line of rl) { const i = line.indexOf('|'); const pid = (i < 0 ? line : line.slice(0, i)).trim(); if (pid) improved.add(pid); }
      console.log(`  Brazoria improvement inventory loaded: ${improved.size} built prop_ids`);
      return { improved };
    },
    map: (p, ctx) => ({
      prop_id: util.S(p.prop_id),
      geo_id: util.S(p.simple_geo) || util.S(p.prop_id),
      owner_name: util.S(p.file_as_na),
      owner_addr: null,
      situs_raw: util.S(p.situs_disp),
      landuse_st: util.S(p.state_cd),
      landuse_l: null,
      acres: parseAcres(p.ACREAGE) ?? (util.N(p.Shape_Area) != null ? util.N(p.Shape_Area) / 43560 : null),
      improvement_value: ctx.improved && ctx.improved.has(String(p.prop_id)) ? 1 : 0,
      year_built: null,
      exemptions: null,
    }),
  },

  // ---- GALVESTON (GCAD) — easy/inline, like FBCAD ----
  // PROVENANCE: direct WP ZIP galvestoncad.org/wp-content/uploads/YYYY/MM/parcels.zip ("Parcels with data").
  //   EPSG:2278 ft. Has owner (NAME), situs (SITUS), acreage (ACRES str), improvement value (VAL26IMP, inline
  //   -> tier-1 vacancy, no roll join), owner mailing addr. LANDUSE is a GCAD-LOCAL code (not a TX state cat),
  //   so exempt class X is derived from the EXEMPT field instead: EXEMPT starting "EX" = TX category-X exemption
  //   (EX-XV/XG/XJ/XD/XU/XL — gov't/church/district); "HS"/"HS, OTHER" = residential homestead (NOT institutional).
  'galveston': {
    county: 'GALVESTON', source: 'gcad:GALVESTON',
    shp: GV + '.shp', dbf: GV + '.dbf', prj: GV + '.prj',
    map: (p) => ({
      prop_id: util.S(p.PID),
      geo_id: util.S(p.GEOID),
      owner_name: util.S(p.NAME),
      owner_addr: [util.S(p.ADDRESS2) || util.S(p.ADDRESS), util.S(p.ADDRESS3), util.S(p.CITY), util.S(p.ST), util.S(p.ZIP)].filter(Boolean).join(', ') || null,
      situs_raw: util.S(p.SITUS),
      landuse_st: util.S(p.LANDUSE),
      landuse_l: null,
      landuse_cat: /^EX/i.test(p.EXEMPT || '') ? 'X' : null,
      acres: parseAcres(p.ACRES),
      improvement_value: util.N(p.VAL26IMP),
      year_built: null,
      exemptions: util.S(p.EXEMPT),
    }),
  },

  // ---- MONTGOMERY (MCAD) — ArcGIS FeatureServer source (no shapefile / no roll join) ----
  // PROVENANCE: MCAD "Tax_Parcel_view" hosted FeatureServer (org services1.arcgis.com/PRoAPGnMSUqvTrzq, found via
  //   the Open Data DCAT catalog data-moco.opendata.arcgis.com/api/feed/dcat-us/1.1.json). 336k parcels. Download
  //   with db/download-arcgis-parcels.js montgomery -> data/county-raw/montgomery/parcels.ndjson ({p:attrs, g:WGS84}).
  //   Inline attrs: ownerName, ownerAddress, stateCd (REAL TX state class -> exempt-X works), exemptions, situs,
  //   Shape__Area (sqft @ SR 2277 -> acres /43560), imprvMainArea (building sqft -> TIER-1 vacancy: 0 = vacant).
  'montgomery': {
    county: 'MONTGOMERY', source: 'mcad:MONTGOMERY',
    ndjson: path.join(ROOT, 'data', 'county-raw', 'montgomery', 'parcels.ndjson'),
    map: (p) => ({
      prop_id: util.S(p.pid) || util.S(p.PIN),
      geo_id: util.S(p.PIN),
      owner_name: util.S(p.ownerName),
      owner_addr: util.S(p.ownerAddress),
      situs_raw: util.S(p.situs),
      landuse_st: util.S(p.stateCd),
      landuse_l: null,
      acres: util.N(p.Shape__Area) != null ? util.N(p.Shape__Area) / 43560 : null,
      improvement_value: util.N(p.imprvMainArea),
      year_built: util.N(p.imprvActualYearBuilt),
      exemptions: util.S(p.exemptions),
    }),
  },

  // ---- WALLER (WCAD) — BIS WallerCADWebService FeatureServer -> ndjson (db/download-arcgis-parcels.js waller) ----
  // PACS schema, inline imprv_val (0=vacant). No state-class field (landuse_cat stays null). ~52k parcels.
  'waller': {
    county: 'WALLER', source: 'wcad:WALLER', ndjson: NDJSON('waller'), map: (p) => mapPacs(p),
  },

  // ---- LIBERTY (LCAD) — BIS LibertyCADWebService FeatureServer -> ndjson (db/download-arcgis-parcels.js liberty) ----
  // Same PACS schema, inline imprv_val. ~155k features; null-geom/zero-acreage placeholders drop at the filter.
  'liberty': {
    county: 'LIBERTY', source: 'lcad:LIBERTY', ndjson: NDJSON('liberty'), map: (p) => mapPacs(p),
  },

  // ---- CHAMBERS (ChCAD) — Pandai MapServer (TaxParcels JOINED Accounts) -> ndjson + certified-roll CSV join ----
  // PROVENANCE: ArcGIS fields table-qualified; improvement value is NOT in the service (Market_Value blank), so
  // VACANCY comes from the certified-roll CSV (chamberscad.org Data Records) joined by Account. Improvement =
  // Improvement_Hs+New_Improvement_Hs+Improvement_Nhs+New_Improvement_Nhs (0=vacant). Dedup on Parcel_CAMA.
  'chambers': {
    county: 'CHAMBERS', source: 'chcad:CHAMBERS', ndjson: NDJSON('chambers'),
    prepare: async () => {
      const rollByAccount = new Map();
      const lines = fs.readFileSync(CH_ROLL, 'utf8').split(/\r?\n/);
      const header = parseCsvLine(lines[0]);
      const iAcct = header.indexOf('Account');
      const impCols = ['Improvement_Hs', 'New_Improvement_Hs', 'Improvement_Nhs', 'New_Improvement_Nhs'].map((c) => header.indexOf(c));
      for (let i = 1; i < lines.length; i++) {
        if (!lines[i]) continue;
        const row = parseCsvLine(lines[i]);
        const acct = (row[iAcct] || '').trim();
        if (!acct) continue;
        let imp = 0;
        for (const c of impCols) { const v = Number(String(row[c] || '').replace(/[^0-9.\-]/g, '')); if (Number.isFinite(v)) imp += v; }
        rollByAccount.set(acct, (rollByAccount.get(acct) || 0) + imp);
      }
      console.log(`  Chambers certified roll loaded: ${rollByAccount.size} accounts`);
      return { rollByAccount };
    },
    map: (p, ctx) => {
      const A = 'ChambersCADWeb.DBO.Accounts.', T = 'ChambersCADWeb.DBO.TaxParcels.';
      const cama = util.N(p[T + 'Parcel_CAMA']);
      const account = util.S(p[A + 'Account']);
      const situs = [util.S(p[A + 'Prop_Street_Number']), util.S(p[A + 'Prop_Street']), util.S(p[A + 'Prop_Street_Dir']), util.S(p[A + 'Prop_Street_Suffix'])].filter(Boolean).join(' ');
      const situsFull = [situs || null, util.S(p[A + 'Prop_City']), util.S(p[A + 'Prop_State']), util.S(p[A + 'Prop_Zip5'])].filter(Boolean).join(', ') || null;
      const mail = [util.S(p[A + 'Mailing_Address_Street']), util.S(p[A + 'Mailing_Address_Overflow']), util.S(p[A + 'Mailing_Address_City']), util.S(p[A + 'Mailing_Address_State']), util.S(p[A + 'Mailing_Address_Zip5'])].filter(Boolean).join(', ') || null;
      return {
        prop_id: cama != null ? String(cama) : account, geo_id: account,
        owner_name: util.S(p[A + 'Owner_Name']), owner_addr: mail, situs_raw: situsFull,
        landuse_st: util.S(p[A + 'Primary_Category_Code']), landuse_l: null,
        acres: util.N(p[A + 'Acres']),
        improvement_value: account && ctx.rollByAccount && ctx.rollByAccount.has(account) ? ctx.rollByAccount.get(account) : null,
        year_built: null, exemptions: null,
      };
    },
  },

  // ---- AUSTIN COUNTY (ACAD) — TxGIO StratMap per-county shapefile (already EPSG:4326), inline IMP_VALUE ----
  // PROVENANCE: data.geographic.texas.gov stratmap25-landparcels_48015_lp.zip (browser UA needed). CAD-sourced
  // attrs. IMP_VALUE inline (0=vacant). No state category (STAT_LAND_ empty) -> landuse_cat null; LOC_LAND_U is
  // a CAD-local code only. SITUS_ADDR/MAIL_ADDR are preformatted full strings.
  'austin': {
    county: 'AUSTIN', source: 'acad:AUSTIN',
    shp: AU + '.shp', dbf: AU + '.dbf', prj: AU + '.prj',
    map: (p) => ({
      prop_id: util.S(p.Prop_ID), geo_id: util.S(p.GEO_ID),
      owner_name: util.S(p.OWNER_NAME), owner_addr: util.S(p.MAIL_ADDR), situs_raw: util.S(p.SITUS_ADDR),
      landuse_st: util.S(p.STAT_LAND_), landuse_l: util.S(p.LOC_LAND_U), landuse_cat: null,
      acres: util.N(p.LEGAL_AREA), improvement_value: util.N(p.IMP_VALUE), year_built: util.N(p.YEAR_BUILT),
      exemptions: null,
    }),
  },

  // ---- HARRIS (HCAD) — denormalized GIS MapServer -> ndjson (db/download-arcgis-parcels.js harris) ----
  // Download is pre-filtered to 0.5–50ac (acreage_1). Inline impr_value (0=vacant), real state_class (exempt-X
  // works), owner split across owner_name_1/2/3 (concatenated for owner-review pattern matching), HCAD 13-digit
  // account. ~141k parcels in buy-box. Biggest county; footprints downloaded tiled like the others.
  'harris': {
    county: 'HARRIS', source: 'hcad:HARRIS', ndjson: NDJSON('harris'),
    map: (p) => {
      const situs = [util.S(p.site_str_num), util.S(p.site_str_num_sfx), util.S(p.site_str_pfx), util.S(p.site_str_name), util.S(p.site_str_sfx), util.S(p.site_str_sfx_dir)].filter(Boolean).join(' ');
      const situsFull = [situs || null, util.S(p.site_city), 'TX', util.S(p.site_zip)].filter(Boolean).join(', ') || null;
      const owner = [util.S(p.owner_name_1), util.S(p.owner_name_2), util.S(p.owner_name_3)].filter(Boolean).join(' ') || null;
      const mail = [util.S(p.mail_addr_1), util.S(p.mail_addr_2), util.S(p.mail_city), util.S(p.mail_state), util.S(p.mail_zip)].filter(Boolean).join(', ') || null;
      return {
        prop_id: util.S(p.HCAD_NUM) || util.S(p.acct_num), geo_id: util.S(p.HCAD_NUM),
        owner_name: owner, owner_addr: mail, situs_raw: situsFull,
        landuse_st: util.S(p.state_class), landuse_l: util.S(p.land_use),
        acres: util.N(p.acreage_1), improvement_value: util.N(p.impr_value), year_built: null, exemptions: null,
      };
    },
  },
};

// Yields {properties, geometry} from either a shapefile (geometry in source CRS) or an NDJSON file of
// {p:attrs, g:WGS84 geometry} produced by db/download-arcgis-parcels.js.
async function* readFeatures(cfg) {
  if (cfg.ndjson) {
    const rl = readline.createInterface({ input: fs.createReadStream(cfg.ndjson) });
    for await (const line of rl) { if (!line) continue; let o; try { o = JSON.parse(line); } catch (e) { continue; } yield { properties: o.p || {}, geometry: o.g || null }; }
  } else {
    const src = await shapefile.open(cfg.shp, cfg.dbf, { encoding: 'utf-8' });
    for (let r = await src.read(); !r.done; r = await src.read()) { if (r.value) yield { properties: r.value.properties || {}, geometry: r.value.geometry || null }; }
  }
}

async function main() {
  const key = process.argv[2];
  const init = process.argv.includes('--init');
  const cfg = COUNTY_SOURCES[key];
  if (!cfg) { console.error('Usage: node db/ingest-county.js <county> [--init]\n  known:', Object.keys(COUNTY_SOURCES).join(', ')); process.exit(1); }
  const srcPath = cfg.ndjson || cfg.shp;
  if (!fs.existsSync(srcPath)) { console.error('Source not found:', srcPath); process.exit(1); }

  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  if (init) db.exec('DROP TABLE IF EXISTS parcels;');
  db.exec(fs.readFileSync(SCHEMA, 'utf8'));
  db.prepare('DELETE FROM parcels WHERE source = ?').run(cfg.source);
  const ctx = cfg.prepare ? await cfg.prepare() : {}; // per-county roll join / context (e.g. Brazoria improvements)

  const reproj = cfg.ndjson ? null : util.loadReprojector(cfg.prj); // ndjson sources are already WGS84
  const insert = db.prepare(`
    INSERT INTO parcels
      (source, prop_id, geo_id, county, owner_name, owner_key, owner_addr, situs_raw,
       situs_street, situs_city, situs_state, situs_zip, landuse_l, landuse_st, landuse_cat,
       acres, improvement_value, year_built, exemptions, geom_json, rep_lat, rep_lng, rep_repaired, width_ft)
    VALUES
      (@source, @prop_id, @geo_id, @county, @owner_name, @owner_key, @owner_addr, @situs_raw,
       @situs_street, @situs_city, @situs_state, @situs_zip, @landuse_l, @landuse_st, @landuse_cat,
       @acres, @improvement_value, @year_built, @exemptions, @geom_json, @rep_lat, @rep_lng, @rep_repaired, @width_ft)
  `);
  const insertMany = db.transaction((items) => { for (const it of items) insert.run(it); });

  let read = 0, kept = 0, noGeom = 0, droppedAcres = 0;
  let batch = [];
  const seen = new Set();
  for await (const f of readFeatures(cfg)) {
    read++;
    if (read % 50000 === 0) console.log(`  read ${read}... (kept ${kept})`);
    const m = cfg.map(f.properties || {}, ctx);

    // cheap attribute filter first — no geometry math on the parcels we'll drop
    if (m.acres == null || m.acres < ACRES_MIN || m.acres > ACRES_MAX) { droppedAcres++; continue; }
    if (m.prop_id) { if (seen.has(m.prop_id)) continue; seen.add(m.prop_id); } // dedup multi-row joins
    if (!f.geometry) { noGeom++; continue; }

    const geom4326 = reproj ? util.mapGeometry(f.geometry, reproj) : f.geometry;
    const { width_ft, rep } = util.widthAndRepFrom4326(geom4326); // CRS-independent inscribed-width + interior pt
    if (!rep) { noGeom++; continue; }
    const situs = util.parseSitus(m.situs_raw);

    batch.push({
      source: cfg.source, prop_id: m.prop_id, geo_id: m.geo_id, county: cfg.county,
      owner_name: m.owner_name, owner_key: util.normalizeOwnerKey(m.owner_name), owner_addr: m.owner_addr,
      situs_raw: m.situs_raw, situs_street: situs.street, situs_city: situs.city, situs_state: situs.state, situs_zip: situs.zip,
      landuse_l: m.landuse_l, landuse_st: m.landuse_st,
      landuse_cat: m.landuse_cat !== undefined ? m.landuse_cat : (m.landuse_st ? m.landuse_st[0].toUpperCase() : null),
      acres: m.acres, improvement_value: m.improvement_value, year_built: m.year_built, exemptions: m.exemptions,
      geom_json: JSON.stringify(geom4326),
      rep_lat: rep[1], rep_lng: rep[0], rep_repaired: 1, width_ft,
    });
    kept++;
    if (batch.length >= FLUSH) { insertMany(batch); batch = []; }
  }
  if (batch.length) insertMany(batch);

  const total = db.prepare('SELECT COUNT(*) n FROM parcels WHERE source = ?').get(cfg.source).n;
  const w = db.prepare('SELECT MIN(width_ft) mn, AVG(width_ft) av, MAX(width_ft) mx FROM parcels WHERE source=?').get(cfg.source);
  const nullW = db.prepare('SELECT COUNT(*) n FROM parcels WHERE source=? AND width_ft IS NULL').get(cfg.source).n;
  console.log(`\n=== INGEST ${cfg.county} (${cfg.source}) ===`);
  console.log(`read ${read} | dropped acreage<${ACRES_MIN}/>${ACRES_MAX}: ${droppedAcres} | no geom: ${noGeom} | kept: ${kept}`);
  console.log(`rows in db for this source: ${total}`);
  console.log(`width_ft: min ${fmt(w.mn)} avg ${fmt(w.av)} max ${fmt(w.mx)} | null: ${nullW}`);
  db.close();
}

const fmt = (n) => (n == null ? 'n/a' : Number(n).toFixed(1));
main().catch((e) => { console.error(e); process.exit(1); });
