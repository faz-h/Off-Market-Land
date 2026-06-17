'use strict';
/*
 * The locked vacant-land candidate definition. The geometry gates (widest/avg width, corridor ratio) are
 * FIXED here, not user-tunable, after being dialed in on the Fort Bend map. This single source of truth is
 * shared by the API query base (services/query.js) and the enrichment passes (enrich/*.js), so value-add
 * enrichment runs on exactly the set that can be a candidate — in every county.
 */
const GEOM = { WIDTH_MIN: 60, MEAN_MIN: 70, ELONG_MAX: 30 };
const COV_MAX = 5; // building-footprint coverage % ceiling — the 2nd vacancy tier (AND with improvement_value)

// Strict candidate universe (no audit relaxations). Acreage was already enforced at ingest; repeated here
// so the predicate stands alone. Used verbatim by the enrichment passes.
// Vacancy is TWO-TIER and NULL-tolerant: no appraised building AND footprint coverage <= COV_MAX. Each tier
// passes when its data is absent, so it's two-tier where footprints exist and degrades to improvement-value
// where they don't.
const CANDIDATE_SQL = [
  'acres BETWEEN 0.5 AND 50',
  'COALESCE(excluded_manual, 0) = 0',
  'COALESCE(is_public, 0) = 0',
  '(improvement_value IS NULL OR improvement_value <= 0)',
  `(building_cov_pct IS NULL OR building_cov_pct <= ${COV_MAX})`,
  "COALESCE(landuse_cat, '') <> 'X'",
  `COALESCE(width_ft, 9999) >= ${GEOM.WIDTH_MIN}`,
  `COALESCE(width_mean_ft, 9999) >= ${GEOM.MEAN_MIN}`,
  `COALESCE(elongation, 0) <= ${GEOM.ELONG_MAX}`,
].join(' AND ');

module.exports = { GEOM, COV_MAX, CANDIDATE_SQL };
