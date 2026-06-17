'use strict';
/*
 * Owner-by-parcel-count review — this is where the public/municipal/HOA exclusion list is *cemented*,
 * against real data, not guessed. Groups parcels by normalized owner_key, ranks by parcel count, and
 * auto-tags against the agreed seed patterns. Public/institutional owners cluster at the top; a
 * high-count *private developer* is NOT public and stays in. The user approves/edits, then --apply
 * writes is_public / public_reason.
 *
 * Usage:
 *   node db/owner-review.js [--top N]     report: ranked top owners + auto-tag (default 60)
 *   node db/owner-review.js --apply       write is_public/public_reason from the seed patterns
 */
const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = path.join(__dirname, 'parcels.db');

// Seed patterns over the normalized owner_key (UPPERCASE, punctuation->space). [regex, label].
// Auto-tags candidates only; the ranked review is the source of truth.
const SEED = [
  [/UNITED STATES|\bUSA\b|\bU S A\b|\bFEDERAL\b|CORPS OF ENGINEERS|\bUSDA\b|FISH (&|AND) WILDLIFE|NATIONAL (WILDLIFE|FOREST|PARK|SEASHORE)/, 'federal'],
  [/STATE OF TEXAS|TEXAS DEPARTMENT|TEXAS DEPT|\bTXDOT\b|GENERAL LAND OFFICE|\bGLO\b|PARKS AND WILDLIFE|PARKS WILDLIFE/, 'state'],
  [/\b(BRAZORIA|F(OR)?T BEND|HARRIS|GALVESTON|MONTGOMERY|WALLER|LIBERTY|CHAMBERS|AUSTIN) COUNTY\b|\bCOUNTY OF\b|COMMISSIONERS COURT/, 'county'],
  [/\bCITY OF\b|\bTOWN OF\b|\bVILLAGE OF\b/, 'city'],
  [/MUNICIPAL UTILITY|\bMUD\b|\bM U D\b/, 'MUD'],
  [/WATER CONTROL|\bWCID\b|FRESH WATER|\bFWSD\b|WATER SUPPLY|\bWSC\b|UTILITY DIST|WATER AUTHORITY/, 'water/utility district'],
  [/\bLEVEE\b|\bLID\b|DRAINAGE DIST|FLOOD CONTROL|BAYOU ID|BAYOU IMPROVEMENT/, 'levee/drainage/flood'],
  [/NAVIGATION DIST|\bPORT OF\b|PORT AUTHORITY/, 'navigation/port'],
  [/IMPROVEMENT DIST|\bPID\b|MANAGEMENT DIST|\bMMD\b|REDEVELOPMENT DIST|DEVELOPMENT AUTHORITY/, 'improvement/mgmt district'],
  [/EMERGENCY SERVICES|\bESD\b|FIRE DIST|HOSPITAL DIST|CONSERVATION DIST|GROUNDWATER/, 'ESD/hospital/conservation'],
  [/INDEPENDENT SCHOOL|\b[CM]?ISD\b|SCHOOL DIST|COMMUNITY COLLEGE|TECHNICAL COLLEGE|COLLEGE SYSTEM|COLLEGE DIST|\bUNIVERSITY\b|PUBLIC SCHOOL|CHARTER SCHOOL/, 'school/college'],
  [/METROPOLITAN TRANSIT|\bMETRO\b|TRANSIT AUTH|HOUSING AUTH|PARKS AND REC|PARKS REC/, 'transit/housing/parks'],
  [/\bAUTHORITY\b|TRANSPORTATION COMMISSION|TOLL ROAD|DEPARTMENT OF HIGHWAYS|HIGHWAYS (&|AND) PUBLIC/, 'gov authority'],
  // investor-owned infrastructure non-sellers (power / substations / easements / ROW / rail / pipeline)
  [/CENTERPOINT|ENTERGY|\bONCOR\b|\bTNMP\b|TEXAS NEW MEXICO POWER|RELIANT ENERGY|\bNRG\b|ENERGY CENTER|ELECTRIC COOP|TRANSMISSION (CO|LL?C|LP)|UNION PACIFIC|\bBNSF\b|BURLINGTON NORTHERN|\bRAILROAD\b|\bRAILWAY\b|\bRR\b|KINDER MORGAN|ENTERPRISE PRODUCTS|ENERGY TRANSFER|\bENBRIDGE\b|MAGELLAN|PLAINS (PIPELINE|ALL AMERICAN)|\bPIPELINE\b|GULF SOUTH PIPE|PHILLIPS 66 PIPE/, 'utility/infrastructure'],
  // telecom / water utilities & cell towers
  [/AQUA TEXAS|\bSUEZ\b|WATER SERVICE|TELEPHONE|TELECOM|COMMUNICATIONS|SOUTHWESTERN BELL|\bSBC\b|WORLDCOM|CELLULAR|\bAT&T\b|TOWER (INC|LLC|LP|LEASING)|\bSBA TOWER/, 'telecom/water utility'],
  [/HOMEOWNERS|\bHOA\b|\bPOA\b|ASSOCIATION|\bASSOC\b|\bASSN\b|OWNERS ASS|COMMUNITY IMPROVEMENT|COMMUNITY SERVICES|RESIDENTIAL COMMUNITY|MAINTENANCE ASS|NEIGHBORHOOD ASS|MASTER ASS/, 'HOA/POA'],
  // public water bodies (exact-match owner = the watercourse itself; avoids catching "X River Ranch LLC")
  [/^BRAZOS RIVER$|^SAN BERNARD RIVER$|^COLORADO RIVER$|^TRINITY RIVER$|^SAN JACINTO RIVER$/, 'water body'],
];

function matchPublic(ownerKey) {
  if (!ownerKey) return null;
  for (const [re, label] of SEED) if (re.test(ownerKey)) return label;
  return null;
}

const db = new Database(DB_PATH);
const apply = process.argv.includes('--apply');
const topIdx = process.argv.indexOf('--top');
const TOP = topIdx >= 0 ? Number(process.argv[topIdx + 1]) : 60;

const owners = db.prepare(`
  SELECT owner_key, COUNT(*) n, ROUND(SUM(acres),1) acres,
         MAX(owner_name) owner_name, MAX(situs_raw) sample_situs
  FROM parcels WHERE owner_key IS NOT NULL
  GROUP BY owner_key ORDER BY n DESC
`).all();

if (apply) {
  const upPub = db.prepare('UPDATE parcels SET is_public=1, public_reason=? WHERE owner_key=?');
  const upNon = db.prepare('UPDATE parcels SET is_public=0, public_reason=NULL WHERE owner_key=?');
  let flaggedOwners = 0, flaggedParcels = 0;
  const tx = db.transaction(() => {
    for (const o of owners) {
      const label = matchPublic(o.owner_key);
      if (label) { upPub.run(label, o.owner_key); flaggedOwners++; flaggedParcels += o.n; }
      else upNon.run(o.owner_key);
    }
  });
  tx();
  console.log(`Applied seed patterns: flagged ${flaggedParcels} parcels across ${flaggedOwners} owners as is_public=1.`);
  db.close();
  return;
}

// ---- report ----
const totalParcels = owners.reduce((s, o) => s + o.n, 0);
const tagged = owners.filter((o) => matchPublic(o.owner_key));
const taggedParcels = tagged.reduce((s, o) => s + o.n, 0);

console.log(`\nDistinct owners: ${owners.length} | total parcels: ${totalParcels}`);
console.log(`Auto-tagged public/HOA: ${tagged.length} owners, ${taggedParcels} parcels (${(100 * taggedParcels / totalParcels).toFixed(1)}%)\n`);
console.log(`Top ${TOP} owners by parcel count  (✓ = auto-tagged public; blank = kept):`);
console.log('  #par  acres  tag                         owner / sample situs');
for (const o of owners.slice(0, TOP)) {
  const label = matchPublic(o.owner_key);
  const flag = label ? '✓ ' + label : '';
  console.log(
    `  ${String(o.n).padStart(4)}  ${String(o.acres).padStart(6)}  ${flag.padEnd(26).slice(0, 26)}  ${(o.owner_name || '').slice(0, 38)}`
  );
}
db.close();
