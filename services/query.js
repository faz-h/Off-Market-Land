'use strict';
/*
 * Shared filter -> SQL builder for the parcel API. One builder feeds /api/count, /api/aggregate,
 * and /api/parcels so a given filter set means exactly the same thing across the live count, the
 * hex choropleth, and the parcel drill-down. Only params that are present produce clauses, and all
 * values are bound (@name), never interpolated. Column whitelisting for h3 resolution lives in app.js.
 */
const h3 = require('h3-js');
const { GEOM, COV_MAX } = require('./candidate');

const csv = (v) => (v == null || v === '' ? [] : String(v).split(',').map((s) => s.trim()).filter(Boolean));
const num = (v) => { if (v == null || v === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null; };
const truthy = (v) => v === '1' || v === 'true' || v === true;

function buildWhere(q) {
  const clauses = [];
  const params = {};
  const inList = (vals, prefix) => {
    const keys = vals.map((v, i) => { params[`${prefix}${i}`] = v; return `@${prefix}${i}`; });
    return keys.join(',');
  };

  const counties = csv(q.county);
  if (counties.length) clauses.push(`county IN (${inList(counties, 'county')})`);

  if (num(q.acresMin) != null) { clauses.push('acres >= @acresMin'); params.acresMin = num(q.acresMin); }
  if (num(q.acresMax) != null) { clauses.push('acres <= @acresMax'); params.acresMax = num(q.acresMax); }

  const flood = csv(q.flood); // allowed zones: None / 100-Year / 500-Year / Floodway
  if (flood.length) clauses.push(`flood_zone IN (${inList(flood, 'flood')})`);
  if (num(q.floodPctMax) != null) { clauses.push('(flood_pct IS NULL OR flood_pct <= @floodPctMax)'); params.floodPctMax = num(q.floodPctMax); }

  if (q.pipeline === 'none') clauses.push('(has_pipeline IS NULL OR has_pipeline = 0)');

  if (num(q.aadtMin) != null) {
    clauses.push(truthy(q.aadtInclNull) ? '(frontage_aadt >= @aadtMin OR frontage_aadt IS NULL)' : 'frontage_aadt >= @aadtMin');
    params.aadtMin = num(q.aadtMin);
  } else if (q.aadtInclNull === '0') {
    clauses.push('frontage_aadt IS NOT NULL');
  }

  if (num(q.freewayMaxMi) != null) { clauses.push('freeway_mi <= @freewayMaxMi'); params.freewayMaxMi = num(q.freewayMaxMi); }

  if (num(q.incomeMin) != null) { clauses.push('c5_income >= @incomeMin'); params.incomeMin = num(q.incomeMin); }
  if (num(q.incomeMax) != null) { clauses.push('c5_income <= @incomeMax'); params.incomeMax = num(q.incomeMax); }
  if (num(q.popMin) != null) { clauses.push('c5_pop >= @popMin'); params.popMin = num(q.popMin); }

  // Active-listing cross-reference (enrich/active-listings.js). 'exclude' drops every parcel that overlaps
  // a for-sale listing; 'excludeExceptSold' drops only those still on the market, keeping sold-only matches.
  if (q.listings === 'exclude') clauses.push('COALESCE(listed_active, 0) = 0 AND COALESCE(listed_sold, 0) = 0');
  else if (q.listings === 'excludeExceptSold') clauses.push('COALESCE(listed_active, 0) = 0');

  // Estate / inheritance signal (db/flag-estate.js): owner-name probate proxy. 'only' = STRONG signals
  // (estate / heirs / life estate / executor / deceased); 'onlyBroad' also keeps the weaker "et al"
  // co-owner proxy. Owner-name derived only — no county source carries a transfer date, so not time-bounded.
  if (q.estate === 'only') clauses.push("COALESCE(estate_flag, 0) = 1 AND COALESCE(estate_reason, '') <> 'et al (co-owners)'");
  else if (q.estate === 'onlyBroad') clauses.push('COALESCE(estate_flag, 0) = 1');

  // ---- drawn-area spatial filter (TRUE filter: count, hexes, parcels, export all honor it) ----
  // A parcel matches when its interior point (rep_lng/rep_lat) is inside the shape. A bbox prefilter (indexed
  // by parcels_rep) narrows before the precise test. q.polygon = JSON [[lng,lat],...]; q.circle = "lng,lat,m".
  if (q.polygon) {
    try {
      const ring = JSON.parse(q.polygon);
      if (Array.isArray(ring) && ring.length >= 3) {
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const pt of ring) {
          const x = Number(pt[0]), y = Number(pt[1]);
          if (x < minX) minX = x; if (y < minY) minY = y; if (x > maxX) maxX = x; if (y > maxY) maxY = y;
        }
        clauses.push('rep_lng BETWEEN @geoLngMin AND @geoLngMax AND rep_lat BETWEEN @geoLatMin AND @geoLatMax AND oml_in_poly(rep_lng, rep_lat, @geoPoly) = 1');
        Object.assign(params, { geoLngMin: minX, geoLngMax: maxX, geoLatMin: minY, geoLatMax: maxY, geoPoly: q.polygon });
      }
    } catch (e) { /* malformed polygon -> ignored */ }
  } else if (q.circle) {
    const p = String(q.circle).split(',').map(Number);
    if (p.length === 3 && p.every(Number.isFinite) && p[2] > 0) {
      const [clng, clat, radM] = p;
      const cosLat = Math.cos((clat * Math.PI) / 180);
      const radDeg = radM / 111320; // ~meters per degree latitude
      const dLng = radDeg / Math.max(0.01, cosLat);
      clauses.push('rep_lat BETWEEN @geoLatMin AND @geoLatMax AND rep_lng BETWEEN @geoLngMin AND @geoLngMax AND ((rep_lat-@geoClat)*(rep_lat-@geoClat) + (rep_lng-@geoClng)*(rep_lng-@geoClng)*@geoCos2) <= @geoRad2');
      Object.assign(params, {
        geoClat: clat, geoClng: clng, geoCos2: cosLat * cosLat, geoRad2: radDeg * radDeg,
        geoLatMin: clat - radDeg, geoLatMax: clat + radDeg, geoLngMin: clng - dLng, geoLngMax: clng + dLng,
      });
    }
  }

  // ---- candidate base  vs  evaluation-isolate ----
  // Geometry gates (widest/avg width, corridor ratio) are LOCKED constants now (services/candidate.js),
  // no longer user-tunable. showPublic/showBuilt/showExempt relax the NON-geometry gates for auditing;
  // onlyPublic/onlyThin/onlyElongated flip the view to show ONLY the excluded categories (OR'd together).
  clauses.push('acres BETWEEN 0.5 AND 50');
  clauses.push('COALESCE(excluded_manual, 0) = 0'); // hand-curated edge-case drops, applied everywhere
  const thin = `(COALESCE(width_ft, 9999) <= ${GEOM.WIDTH_MIN} OR COALESCE(width_mean_ft, 9999) <= ${GEOM.MEAN_MIN})`;
  const isolate = [];
  if (truthy(q.onlyPublic)) isolate.push('COALESCE(is_public, 0) = 1');
  if (truthy(q.onlyThin)) isolate.push(thin);
  if (truthy(q.onlyElongated)) isolate.push(`COALESCE(elongation, 0) > ${GEOM.ELONG_MAX}`);
  if (isolate.length) {
    clauses.push('(' + isolate.join(' OR ') + ')');
  } else {
    if (q.showPublic !== '1') clauses.push('COALESCE(is_public, 0) = 0');
    clauses.push(`COALESCE(width_ft, 9999) >= ${GEOM.WIDTH_MIN}`);
    clauses.push(`COALESCE(width_mean_ft, 9999) >= ${GEOM.MEAN_MIN}`);
    clauses.push(`COALESCE(elongation, 0) <= ${GEOM.ELONG_MAX}`);
    // primary vacancy gate: no appraised building (improvement_value <= impMax, default $0). NULL imp_value
    // (e.g. non-FBCAD sources) passes — those counties fall back to the coverage gate below.
    // two-tier vacancy (NULL-tolerant): no appraised building AND footprint coverage <= COV_MAX.
    if (q.showBuilt !== '1') {
      const impMax = num(q.impMax) != null ? num(q.impMax) : 0;
      clauses.push('(improvement_value IS NULL OR improvement_value <= @impMax)');
      params.impMax = impMax;
      clauses.push(`(building_cov_pct IS NULL OR building_cov_pct <= ${COV_MAX})`);
    }
    // exempt/institutional land (state category X) dropped by default; showExempt reveals it.
    if (q.showExempt !== '1') clauses.push("COALESCE(landuse_cat,'') <> 'X'");
  }

  return { where: clauses.length ? 'WHERE ' + clauses.join(' AND ') : '', params };
}

// GeoJSON ring ([lng,lat], closed) for an H3 cell, ready to drop into a Polygon.
function hexRing(cell) {
  const ring = h3.cellToBoundary(cell, true);
  ring.push(ring[0]);
  return ring;
}

module.exports = { buildWhere, hexRing };
