'use strict';
/*
 * Funnel report for a county's candidate set — shows how the all-parcel input narrows to vacant-land
 * candidates, stage by stage, so the heuristics can be eyeballed/tuned. Usage:
 *   node db/funnel-report.js [source] [widthFt] [covMax]   (defaults: fbcad:FORT BEND 60 20)
 */
const path = require('path');
const Database = require('better-sqlite3');

const SOURCE = process.argv[2] || 'fbcad:FORT BEND';
const W = Number(process.argv[3] || 60);
const COV = Number(process.argv[4] || 20);
const db = new Database(path.join(__dirname, 'parcels.db'), { readonly: true });
const q = (sql) => db.prepare(sql).get(SOURCE).n;

const ingested = q('SELECT COUNT(*) n FROM parcels WHERE source=?');
const afterPublic = db.prepare('SELECT COUNT(*) n FROM parcels WHERE source=? AND is_public=0').get(SOURCE).n;
const afterRoad = db.prepare('SELECT COUNT(*) n FROM parcels WHERE source=? AND is_public=0 AND COALESCE(width_ft,9999)>=?').get(SOURCE, W).n;
const afterCov = db.prepare('SELECT COUNT(*) n FROM parcels WHERE source=? AND is_public=0 AND COALESCE(width_ft,9999)>=? AND COALESCE(building_cov_pct,0)<=?').get(SOURCE, W, COV).n;

const line = (label, n, prev) => {
  const removed = prev == null ? '' : `  (−${(prev - n).toLocaleString()})`;
  console.log(`  ${String(n).toLocaleString().padStart(9)}  ${label}${removed}`);
};

console.log(`\n=== CANDIDATE FUNNEL — ${SOURCE} (width<${W}ft = road, cov>${COV}% = built) ===`);
line('ingested (0.5–50 ac; pre-ingest acreage filter already applied)', ingested, null);
line('− public / HOA / utility owners', afterPublic, ingested);
line(`− thin slivers (width_ft < ${W})`, afterRoad, afterPublic);
line(`− built (building_cov_pct > ${COV}%)`, afterCov, afterRoad);
console.log(`  ${'='.repeat(9)}`);
line('FINAL candidates', afterCov, null);

// building coverage distribution among non-public, non-road parcels
const covRows = db.prepare(
  `SELECT CASE WHEN building_cov_pct IS NULL THEN 'unscored'
               WHEN building_cov_pct=0 THEN '0%'
               WHEN building_cov_pct<5 THEN '<5%'
               WHEN building_cov_pct<20 THEN '5-20%'
               WHEN building_cov_pct<50 THEN '20-50%'
               ELSE '>=50%' END bucket, COUNT(*) n
   FROM parcels WHERE source=? AND is_public=0 AND COALESCE(width_ft,9999)>=?
   GROUP BY bucket`
).all(SOURCE, W);
console.log('\nbuilding coverage (non-public, non-road):');
for (const r of covRows) console.log(`  ${String(r.n).padStart(7)}  ${r.bucket}`);

// cross-check vs the appraisal-roll vacancy signal
const imp0 = db.prepare('SELECT COUNT(*) n FROM parcels WHERE source=? AND is_public=0 AND COALESCE(width_ft,9999)>=? AND COALESCE(building_cov_pct,0)<=? AND (improvement_value IS NULL OR improvement_value=0)').get(SOURCE, W, COV).n;
console.log(`\nof ${afterCov.toLocaleString()} final candidates, ${imp0.toLocaleString()} also have improvement_value=0 (no building of record); the rest are <=${COV}% built but carry some improvement value (e.g. a home on acreage).`);
db.close();
