# Off-Market Land Finder — V1 Implementation Spec

## 1. Goal

Given a curated top-of-funnel list of land parcels in the Greater Houston MSA, let a user
filter by a set of criteria, preview matching parcels on a map, and push the selected set
into Airtable in a format ready for skip tracing (which happens outside this app).

This app is a sibling of **Airtable Land Map** (on-market listings). It reuses that app's
spatial-enrichment patterns and the Outreach App's land-location logic, but its top-of-funnel
is a fixed parcel dataset rather than scraped listings.

## 2. Decisions locked for V1

| Decision | Choice |
|---|---|
| Top-of-funnel | Local dataset `data/Texas Parcels Delivery v3` (45,529 parcels, 9 counties). **Regrid not used in V1.** |
| Vacancy | **Assumed true for every parcel** — vacancy was a filter that generated this list (checked against a building-footprint dataset). No footprint check in V1. |
| Acreage band | Already pre-filtered to ~0.75–50 acres in the source data. |
| App form | Interactive web app (Express + Leaflet + filter panel), same stack as the sibling apps. |
| Datastore | **SQLite** single-file DB (`db/parcels.db`); enrichment via Node + Turf.js + flatbush. No DB server. |
| V1 enrichment filters | Flood zone, pipelines, traffic (TxDOT AADT, best-effort), demographics, highway distance, acreage, county. |
| Export target | Airtable base `appimzak7mXU1ItI2`, table **Accounts** `tblWDvEfAkT9Qq7OC`, `Asset Class = Land`, `Stage = Newly Added`. |
| Deferred to V2 | Data refresh mechanism; Opportunity Zone; building-footprint re-verification; drive-time to highway. |

## 3. The source dataset (verified)

- `data/Texas Parcels Delivery v3/SHP/Texas Parcels Final 4326_v3.shp` — **45,529 Polygon
  features, EPSG:4326**. `.shp` / `.shx` / `.dbf` / CSV all align 1:1.
- `data/Texas Parcels Delivery v3/Texas Parcels.csv` — same 45,529 rows, attribute mirror.
- `data/Texas Parcels Delivery v3/SHP/By County/` — same data split per county (redundant; the
  combined shapefile is the ingestion source of truth).

Counties & counts: Montgomery 15,608 · Harris 10,610 · Brazoria 6,075 · Fort Bend 5,233 ·
Waller 2,427 · Galveston 2,114 · Liberty 2,000 · Chambers 1,006 · Austin 456.

Attribute fields (DBF, untruncated):

| Field | Meaning | Use in V1 |
|---|---|---|
| `Prop_ID` | numeric property/account ID | → Airtable **County Property ID** |
| `GEO_ID` | geographic ID (blank for Harris) | → Airtable **Geo ID** + **APN** |
| `Owner_name` | owner name (181/45,529 blank) | kept for reference / future skip-trace |
| `Owner_add` | owner **mailing** address | kept for reference |
| `Parcel_add` | situs address e.g. `"CLENS RD , BELLVILLE, TX 77418"` | → Address/City/State/Zip |
| `Area_acres` | acreage | → Airtable **Acres**; acreage filter |
| `Landuse_L`, `Landuse_ST` | land-use codes (sparse, ~71% blank) | not relied upon (vacancy already assumed) |
| `FloodZ_pct` | % of parcel in a flood zone (only 6.1% > 0) | secondary signal only; NOT the required zone type |
| `Road_proxi` | distance-to-road proxy (odd units) | **not used** — we re-derive traffic from TxDOT |
| `latitude` / `longitude` | precomputed representative point | validated/repaired at ingest (see §7) |
| `County`, `OBJECTID`, `pta_ratio`, `NumPolys`, `fid` | misc | metadata |

### The three-ID mapping (county-aware)

- **When `GEO_ID` is present:** `County Property ID = Prop_ID`; `Geo ID = GEO_ID`; `APN = GEO_ID`.
- **When `GEO_ID` is blank:** only the numeric account exists — set
  `County Property ID = APN = Geo ID = Prop_ID`.
- Implementation: `if (!geo_id) { apn = geo_id = prop_id }` (keyed on blank GEO_ID, not county).
- Confirmed at ingest: blank `GEO_ID` covers **all of Harris (10,610) and Chambers (1,006), plus
  300 Montgomery rows** — so the fallback must key on blank `GEO_ID`, not on Harris alone.

> Confirm with the skip-trace vendor which ID format they key on. `GEO_ID` formatting varies by
> county (Austin is zero-padded `0000000386`; existing Airtable Waller rows are dashed
> `529601-000-002-000`). We store the value as delivered.

## 4. Tech stack

- **Runtime:** Node.js + Express (matches sibling apps; lets us port their code directly).
- **Datastore:** **SQLite** (`better-sqlite3`), single file `db/parcels.db`. No server. Geometry
  stored as GeoJSON text; scalar enrichment columns indexed for instant filtering.
- **Spatial (enrichment only):** `@turf/turf` + `flatbush` (in-memory R-tree) for the one-time
  joins; `shpjs`/`shapefile` to read the source shapefile; `polylabel` for point-in-parcel.
- **Frontend:** Leaflet + vanilla JS filter panel (lift Land Map `public/js/main.js` patterns).
- **Airtable:** axios REST, batches of 10, 250 ms delay (port Storage Finder `lib/airtable.js`).
- **Land-location:** axios + Google Geocoding (port Outreach App `locationService.js`).

## 5. Repository layout

```
Off Market Land/
├── data/
│   ├── Texas Parcels Delivery v3/        # source dataset (in repo)
│   └── layers/                            # downloaded enrichment layers (FEMA, RRC, TxDOT, census, freeways)
├── db/
│   ├── schema.sql                         # SQLite DDL + indexes
│   ├── parcels.db                         # the single-file datastore (built artifact)
│   └── ingest-parcels.js                  # shapefile -> parcels rows, parse situs, repair interior point
├── enrich/
│   ├── layers.js                          # load + flatbush-index flood/pipeline/aadt/census/freeway
│   ├── flood.js  pipelines.js  traffic.js  census.js  highway.js
│   └── run-enrichment.js                  # orchestrates enrichment (Turf+flatbush), writes columns to SQLite
├── services/
│   ├── airtable.js                        # export + dedup (ported from Storage Finder)
│   └── locationService.js                 # land-location (ported from Outreach App)
├── public/
│   ├── index.html / views/index.ejs
│   ├── js/main.js                         # Leaflet + filter panel
│   └── css/
├── app.js                                 # Express: /api/parcels (filtered), /api/export, tile proxies
├── .env
└── package.json
```

## 6. Data sources & acquisition (all free)

County FIPS: Harris 48201 · Fort Bend 48157 · Montgomery 48339 · Brazoria 48039 ·
Galveston 48167 · Waller 48473 · Liberty 48291 · Chambers 48071 · Austin 48015.

| Layer | Source | Acquire |
|---|---|---|
| Flood zones | FEMA NFHL | REST layer 28 `https://hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer/28` **or** bulk county GDB from FEMA MSC. V1 = download county zone polygons as GeoJSON, flatbush-index, local Turf join. |
| Pipelines | TX Railroad Commission | "Pipeline Layers by County" shapefiles by FIPS — `https://www.rrc.texas.gov/resource-center/research/data-sets-available-for-download/` |
| Traffic (AADT) | TxDOT Open Data | Line layer `https://services.arcgis.com/KTcxiTD9dsQw4r7Z/arcgis/rest/services/TxDOT_AADT/FeatureServer/0` (field `AADT_CUR`, `RTE_NM`); point fallback `TxDOT_AADT_Annuals_(Public_View)/FeatureServer/0` |
| Demographics | Census ACS5 2022 + TIGERweb | Reuse Land Map `census-block-groups.json` + scripts; **add Austin County (48015)** block groups. |
| Highway distance | OSM freeways | Reuse Land Map `public/data/houston-freeways.geojson` as-is. |

## 7. Stage 0 — Ingest parcels + repair representative point

1. Read `Texas Parcels Final 4326_v3.shp` with `shpjs`/`shapefile`; insert one SQLite row per
   parcel, storing the polygon as GeoJSON text in `geom_json` and carrying all attributes. Parse
   `Parcel_add` into street/city/state/zip.
2. **Representative point** (`rep_lat`/`rep_lng`, used for Name/Coordinates and demographics):
   - If the delivered `(latitude, longitude)` lies inside the polygon
     (`turf.booleanPointInPolygon`), keep it.
   - Else recompute with **`polylabel`** (pole of inaccessibility — guaranteed inside and maximally
     interior), or `turf.pointOnFeature` as a simpler guaranteed-inside fallback. Fixes odd/concave
     parcels.

```sql
CREATE TABLE parcels (
  id INTEGER PRIMARY KEY,
  prop_id TEXT, geo_id TEXT, county TEXT,
  owner_name TEXT, owner_addr TEXT,
  situs_raw TEXT, situs_street TEXT, situs_city TEXT, situs_state TEXT, situs_zip TEXT,
  landuse_l TEXT, landuse_st TEXT, acres REAL,
  src_lat REAL, src_lng REAL,
  geom_json TEXT,                         -- parcel polygon as GeoJSON (returned for map render)
  rep_lat REAL, rep_lng REAL,             -- validated interior point (Name/Coordinates)
  -- enrichment:
  flood_zone TEXT, flood_pct REAL,
  has_pipeline INTEGER, pipeline_dist_ft INTEGER,
  frontage_aadt INTEGER, frontage_road TEXT,
  nearest_freeway TEXT, freeway_mi REAL,
  c2_pop INTEGER, c2_income INTEGER, c2_age REAL, c2_households INTEGER, c2_owner_pct REAL, c2_growth REAL,
  c5_pop INTEGER, c5_income INTEGER, c5_age REAL, c5_households INTEGER, c5_owner_pct REAL, c5_growth REAL,
  enriched_at TEXT, exported_at TEXT
);
CREATE INDEX parcels_county ON parcels(county);
CREATE INDEX parcels_acres  ON parcels(acres);
CREATE INDEX parcels_flood  ON parcels(flood_zone);
CREATE INDEX parcels_aadt   ON parcels(frontage_aadt);
```

## 8. Stage 1–2 — Enrichment (one-time batch, re-runnable)

### Flood zone — `None | 100-Year | 500-Year | Floodway`
Load NFHL zone polygons for the 9 counties as GeoJSON, build a `flatbush` bbox index. For each
parcel, bbox-query candidate zones, confirm with `turf.booleanIntersects`, and take the **worst**
by priority. Reuse Land Map's classifier:
- high-risk `FLD_ZONE in (A,AE,AH,AO,A99,AR,V,VE)` + `ZONE_SUBTY` contains `FLOODWAY` → `Floodway`
- high-risk otherwise → `100-Year`
- `FLD_ZONE = X` + `ZONE_SUBTY` contains `0.2 PCT ANNUAL CHANCE` → `500-Year`
- else → `None`

Priority `Floodway > 100-Year > 500-Year > None`. Also store `flood_pct` = sum of
`turf.intersect` areas ÷ parcel area (capped 100%), enabling an "ignore flood overlap below X%"
filter so trivial slivers can be excluded from the flood filter.

### Pipelines — boolean + distance
Load RRC pipeline lines for the 9 counties as GeoJSON, flatbush-indexed.
- `has_pipeline` = any pipeline `turf.booleanIntersects` the parcel polygon.
- `pipeline_dist_ft` = distance to nearest pipeline (`turf.pointToLineDistance` /
  `turf.nearestPointOnLine`), so the UI can filter "crosses parcel" vs "within N ft" (easement
  buffer). Null if none within a max radius.

### Traffic (TxDOT AADT) — busiest adjacent road
Load AADT line segments as GeoJSON (`AADT_CUR`, `RTE_PRFX`/`RTE_NBR`/`RTE_NM`), flatbush-indexed.
Coverage is dense (~135k segments incl. county roads & city streets, all with AADT).
- Buffer each parcel by **50 m** (`turf.buffer`); find segments intersecting the buffer.
- `frontage_aadt` = **MAX** `AADT_CUR` among them (busiest road on/adjacent to the parcel — handles
  corner/multi-frontage lots); `frontage_road` = that segment's route (e.g. `FM 1093`).
- None within 50 m → `frontage_aadt = NULL`, stored as-is. UI has an **include/exclude-null toggle**
  (no baked-in interpretation). Verified: ~84% of nulls have the nearest road >100 m away (genuinely
  set-back/interior), so null is mostly a real off-frontage signal.

### Demographics — reuse Land Map logic
For each parcel `rep_point`, aggregate ACS block groups within 2 mi and 5 mi (sum population,
population-weighted median income/age, owner %, 2017→2022 growth). Store `c2_*` / `c5_*`.

### Highway distance — reuse Land Map logic
`turf.nearestPointOnLine` against `houston-freeways.geojson`; store `nearest_freeway`,
`freeway_mi` (straight-line). Drive-time deferred to V2 (it costs Google API calls per parcel).

## 9. Interactive web app

**Server (`app.js`)**
- `GET /api/parcels?filters=…` → query the SQLite `parcels` table, return matching set (id, rep_lat/lng,
  acres, flood_zone, has_pipeline, frontage_aadt, county, situs, IDs) + a count. Cap rendered
  geometry; return polygons on demand by id/bbox.
- `POST /api/export` → body = selected parcel ids; runs land-location lookup + Airtable write.
- Tile proxies for FEMA/RRC/TxDOT visual overlays (port Land Map's proxy pattern).

**Frontend (`public/js/main.js`)** — Leaflet map + filter panel:
- County multi-select
- Acreage min/max
- Flood zone: allow/exclude checkboxes (Floodway / 100-Year / 500-Year / None) + optional max flood %
- Pipeline: any / none / within N ft
- Traffic: min AADT threshold + "include unknown" toggle
- Demographics: ranges for pop / median income / growth / owner % (2 mi & 5 mi)
- Highway: max distance (mi)
- Live result count; matches drawn on map; multi-select → **Export to Airtable**.
- Save/load named filter presets (port Land Map's config-table pattern).

> 45,529 parcels: filter server-side and render only matches (cluster/cap if a filter is broad).

## 10. Airtable export

Reuse Storage Finder's batched axios writer. **Dedup** against existing Accounts rows by parcel
ID (county-aware: Harris `Prop_ID`, else `GEO_ID`) before insert; skip rows already present.
Run the **land-location lookup only on selected parcels** (cheap).

| Airtable field | Value |
|---|---|
| `Name` | `"{rep_lat}, {rep_lng}"` |
| `Coordinates` | mirror of `Name` |
| `Stage` | `Newly Added` |
| `Asset Class` | `Land` |
| `Address` | situs street (from `Parcel_add`; may be blank) |
| `City` / `State` / `Zip` | parsed from `Parcel_add` |
| `County` | normalized title case |
| `County Property ID` | `Prop_ID` |
| `Geo ID` | `GEO_ID` (Harris → `Prop_ID`) |
| `APN` | `GEO_ID` (Harris → `Prop_ID`) |
| `Acres` | `Area_acres` |
| `Flood Zone` | `None` / `100-Year` / `500-Year` / `Floodway` |
| `Land - Location Text Field` | Google reverse-geocode at export (e.g. `near FM 1489 in Brookshire`) |

## 11. Environment / config (`.env`)

```
AIRTABLE_ACCESS_TOKEN=…                          # from Storage Finder/.env
AIRTABLE_BASE_ID=appimzak7mXU1ItI2
AIRTABLE_TABLE_ID=tblWDvEfAkT9Qq7OC
GOOGLE_PLACES_API_KEY=…                          # from Outreach App/.env (Geocoding API)
```
(No connection string — the datastore is the file `db/parcels.db`.)

## 12. Build milestones

1. **Scaffold + DB**: Express app + SQLite (`better-sqlite3`), `schema.sql`. Ingest the shapefile
   into `parcels` (geometry as GeoJSON); parse situs; validate/repair the interior point. Verify
   counts (45,529) + ID mapping.
2. **Layers**: download FEMA NFHL, RRC pipelines, TxDOT AADT for the 9 counties; reuse Land Map
   freeways + census (add Austin 48015). Load into PostGIS.
3. **Enrichment batch**: flood, pipeline, traffic, demographics, highway → per-parcel columns.
4. **App**: `/api/parcels` filtering + Leaflet map + filter panel + result count.
5. **Export**: land-location lookup, county-aware IDs, dedup, batched Airtable writes; presets.
6. **QA**: spot-check flood/pipeline/traffic against Land Map's map; verify Airtable rows.

## 13. Open items / V2

- **Refresh mechanism** (dataset is a static ~Dec-2024 snapshot): re-run freelancer, buy Regrid
  county files, or pull CAD updates.
- Opportunity Zone field; building-footprint re-verification; drive-time to highway; owner
  fields into Airtable if skip-trace flow wants them.
- Confirm skip-trace vendor's expected `GEO_ID` format.
- **Census API now requires a free key** — Austin County's 456 parcels have NULL demographics until
  a key is added and `add-austin-census.js` + `census.js` are re-run (key: api.census.gov/data/key_signup.html).

## 14. Status

- **Milestone 1 (ingest):** done — 45,529 parcels in `db/parcels.db`, interior points validated.
- **Milestone 2 (enrichment):** done — `flood_zone`/`flood_pct`, `has_pipeline`/`pipeline_active`/
  `pipeline_info`/`pipeline_dist_ft`, `frontage_aadt`/`frontage_road`, `c2_*`/`c5_*`, `nearest_freeway`/
  `freeway_mi`. All free/local (FEMA NFHL, RRC, TxDOT AADT, Census/TIGERweb, OSM freeways). Reproducible
  via `enrich/run-enrichment.js` (~280s). Austin demographics pending a Census key.
- **Next:** Milestone 3-4 (interactive web app: filter API + Leaflet UI) and Milestone 5 (Airtable export).
