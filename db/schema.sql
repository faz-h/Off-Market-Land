-- Off Market Land — SQLite schema
-- Single-file datastore (db/parcels.db). Geometry stored as GeoJSON text.
-- Enrichment columns are populated by enrich/run-enrichment.js (Milestone 2-3).

CREATE TABLE IF NOT EXISTS parcels (
  id            INTEGER PRIMARY KEY,
  prop_id       TEXT,        -- County Property ID (numeric account)
  geo_id        TEXT,        -- Geographic ID (blank for Harris/HCAD)
  county        TEXT,        -- as delivered, e.g. HARRIS, FORT BEND
  owner_name    TEXT,
  owner_addr    TEXT,        -- owner mailing address
  situs_raw     TEXT,        -- original Parcel_add
  situs_street  TEXT,
  situs_city    TEXT,
  situs_state   TEXT,
  situs_zip     TEXT,
  landuse_l     TEXT,
  landuse_st    TEXT,
  acres         REAL,
  src_lat       REAL,        -- representative point delivered in source data
  src_lng       REAL,
  geom_json     TEXT,        -- parcel polygon as GeoJSON geometry (for map render)
  rep_lat       REAL,        -- validated interior point (Name / Coordinates)
  rep_lng       REAL,
  rep_repaired  INTEGER,     -- 1 if src point was outside polygon and we recomputed it

  -- county-sourced ingest: classification + filter flags --
  source            TEXT,    -- provenance, e.g. fbcad:FORT BEND / stratmap:WALLER
  owner_key         TEXT,    -- normalized owner name, for grouping/owner-review
  landuse_cat       TEXT,    -- state category letter (A/B/C/D/E/F/X...) — reference only
  improvement_value REAL,    -- appraisal improvement value (0 => no building); free vacancy signal
  year_built        INTEGER, -- 0 => no structure on record
  exemptions        TEXT,    -- raw exemption code(s)
  is_public         INTEGER, -- 1 if owner matched the public/municipal/HOA exclusion (owner-review)
  public_reason     TEXT,    -- which pattern matched
  width_ft          REAL,    -- max inscribed-circle diameter (ft); small => thin sliver/road
  building_cov_pct  REAL,    -- % of parcel area covered by building footprints (vacancy gate)
  building_occupancy TEXT,   -- dominant FEMA USA Structures occupancy class
  excluded_manual    INTEGER, -- 1 = manually excluded from candidates (hand curation of edge cases)

  -- enrichment (filled later) --
  flood_zone        TEXT,    -- None / 100-Year / 500-Year / Floodway
  flood_pct         REAL,
  has_pipeline      INTEGER,    -- 1 if any pipeline crosses the parcel
  pipeline_active   INTEGER,    -- 1 if a crossing pipeline is "In Service"
  pipeline_info     TEXT,       -- short descriptor of crossing pipeline commodities
  pipeline_dist_ft  INTEGER,    -- 0 if crossing; else distance from interior point to nearest pipeline (ft), null if far
  frontage_aadt     INTEGER,
  frontage_road     TEXT,
  -- proximity to main roads even when the parcel does NOT front one (enrich/traffic.js, 2nd pass): the TxDOT
  -- AADT network is counted/on-system roads only (side streets excluded), so an "AADT road" = a main road you'd
  -- turn off of. Distances are edge-to-road, capped at NEAR_ROAD_CAP_FT (2640 = 1/2 mi).
  near_road_frontier TEXT,     -- "closest road at each busyness level" staircase: JSON [[ft,aadt,name],...],
                               -- distance-sorted, each entry busier than every closer one (Pareto frontier).
                               -- Filtered exactly via the oml_near_road UDF: "a road >= Y AADT within <= X ft".
  near_road_ft      INTEGER,   -- convenience: edge distance (ft) to the NEAREST main road (= frontier[0]); NULL if none within cap
  near_road_aadt    INTEGER,   -- AADT of that nearest main road
  near_road_name    TEXT,      -- its route name (e.g. "FM 1093")
  nearest_freeway   TEXT,
  freeway_mi        REAL,
  c2_pop INTEGER, c2_income INTEGER, c2_age REAL, c2_households INTEGER, c2_owner_pct REAL, c2_growth REAL,
  c5_pop INTEGER, c5_income INTEGER, c5_age REAL, c5_households INTEGER, c5_owner_pct REAL, c5_growth REAL,
  enriched_at   TEXT,
  exported_at   TEXT,

  -- active-listing cross-reference (enrich/active-listings.js): a parcel is "listed" if a listing
  -- coordinate from the Airtable Land Map base falls inside its polygon. Sold listings are tracked
  -- separately so the UI can exclude on-market listings while still showing already-sold ones.
  listed_active  INTEGER,    -- 1 if a NON-sold listing point falls inside this parcel
  listed_sold    INTEGER,    -- 1 if a Sold listing point falls inside this parcel
  listing_status TEXT,       -- representative Airtable Status (prefers an active listing over sold)
  listing_price  REAL,       -- representative listing's List Price
  listing_url    TEXT,       -- representative listing's Property Link
  listing_name   TEXT,       -- representative listing's Name
  listing_count  INTEGER,    -- number of listing points matched inside this parcel
  listings_at    TEXT,       -- timestamp of the last cross-reference run

  -- estate / inheritance signal (db/flag-estate.js): owner-name probate proxy. estate_flag=1 if the owner
  -- name shows estate/heir language; estate_reason carries which signal (estate / heirs / life estate /
  -- executor-administrator / deceased / "et al"). Owner-name derived — no transfer date exists in source data.
  estate_flag    INTEGER,
  estate_reason  TEXT,

  -- export support (services/geocode.js, services/export.js) --
  location_text     TEXT,    -- cached Google reverse-geocode: "near <street> in <city>" (geocode-once)
  location_text_at  TEXT     -- timestamp the location_text was cached
);

CREATE INDEX IF NOT EXISTS parcels_county ON parcels(county);
CREATE INDEX IF NOT EXISTS parcels_acres  ON parcels(acres);
CREATE INDEX IF NOT EXISTS parcels_flood  ON parcels(flood_zone);
CREATE INDEX IF NOT EXISTS parcels_aadt   ON parcels(frontage_aadt);
CREATE INDEX IF NOT EXISTS parcels_near_road ON parcels(near_road_ft);
CREATE INDEX IF NOT EXISTS parcels_source    ON parcels(source);
CREATE INDEX IF NOT EXISTS parcels_owner_key ON parcels(owner_key);
CREATE INDEX IF NOT EXISTS parcels_is_public ON parcels(is_public);
CREATE INDEX IF NOT EXISTS parcels_width     ON parcels(width_ft);
CREATE INDEX IF NOT EXISTS parcels_bldgcov   ON parcels(building_cov_pct);
CREATE INDEX IF NOT EXISTS parcels_listed_active ON parcels(listed_active);
CREATE INDEX IF NOT EXISTS parcels_listed_sold   ON parcels(listed_sold);
CREATE INDEX IF NOT EXISTS parcels_estate_flag   ON parcels(estate_flag);
CREATE INDEX IF NOT EXISTS parcels_rep ON parcels(rep_lat, rep_lng); -- drawn-area bbox prefilter
