'use strict';
/*
 * Estate / inheritance owner-name flag — the cheap "probate signal" pass. County appraisal rolls write
 * estate/heir language into the owner field when a property has passed (or is passing) through inheritance
 * or probate: "ESTATE OF X", "X ESTATE", "HEIRS", "LIFE ESTATE", executor/administrator, "ET AL". We can't
 * see WHEN ownership changed (no deed/sale date in any county GIS source we ingest), so this flags parcels
 * whose ownership *has gone through* inheritance, not strictly "recently" — but an estate that has sat on
 * the roll unsold is itself a strong motivated-seller signal. Mirrors db/owner-review.js: matches the
 * normalized owner_key (uppercase, punctuation->space) against seed patterns, grouped by owner.
 *
 * Strict corporate/false-positive exclusion keeps precision high: "REAL ESTATE", developments named
 * "...ESTATES" (plural — never matches \bESTATE\b), and entity suffixes (LLC/LTD/INC/CORP/LP/...) are NOT
 * inheritance and are dropped. TRUST is deliberately NOT matched — that's estate planning, not inheritance.
 *
 * Usage:
 *   node db/flag-estate.js            report: counts by signal + how many are vacant-land candidates
 *   node db/flag-estate.js --apply    write estate_flag / estate_reason from the seed patterns
 */
const path = require('path');
const Database = require('better-sqlite3');
const { CANDIDATE_SQL } = require('../services/candidate');

const DB_PATH = path.join(__dirname, 'parcels.db');

// Entity / false-positive guards. If the owner_key matches any of these it is NOT an inherited estate
// (a company, a subdivision, a brokerage), regardless of the signal patterns below.
const EXCLUDE = [
  /\bREAL ESTATE\b/,
  /\bLLC\b|\bL L C\b|\bLTD\b|\bINC\b|\bCORP\b|\bCORPORATION\b|\bCOMPANY\b|\bLP\b|\bLLP\b|\bPARTNERSHIP\b|\bPARTNERS\b/,
  /\bHOA\b|\bPOA\b|ASSOCIATION|\bASSOC\b|\bASSN\b|HOMEOWNER/,
];

// Inheritance/probate signal patterns over the normalized owner_key, strongest/most-specific first.
// [regex, reason-label]. The first match wins; the label surfaces in the parcel popup so the user can
// judge signal strength (estate/heirs/executor are strong; "et al" is the weak co-owner proxy).
const SIGNAL = [
  [/\bLIFE ESTATE\b/, 'life estate'],
  [/\bHEIRS?\b/, 'heirs'],                                                  // \b avoids BOUKHEIR / HEIRONIMUS
  [/\bEXECUT(OR|RIX)?\b|\bADMINISTRAT(OR|RIX|RICES)?\b|\bADMR\b|\bEXR\b/, 'executor/administrator'],
  [/\bDECEASED\b|\bDEC D\b|\bDECD\b/, 'deceased'],                          // owner_key turns DEC'D -> DEC D
  [/\bESTATE\b/, 'estate'],                                                // singular ESTATE only; ESTATES (plural, e.g. subdivisions) fails the trailing \b
  [/\bET AL\b/, 'et al (co-owners)'],                                       // weak inheritance proxy
];

function matchEstate(ownerKey) {
  if (!ownerKey) return null;
  for (const re of EXCLUDE) if (re.test(ownerKey)) return null;
  for (const [re, label] of SIGNAL) if (re.test(ownerKey)) return label;
  return null;
}

function ensureColumns(db) {
  const have = new Set(db.prepare('PRAGMA table_info(parcels)').all().map((c) => c.name));
  if (!have.has('estate_flag')) db.prepare('ALTER TABLE parcels ADD COLUMN estate_flag INTEGER').run();
  if (!have.has('estate_reason')) db.prepare('ALTER TABLE parcels ADD COLUMN estate_reason TEXT').run();
  db.prepare('CREATE INDEX IF NOT EXISTS parcels_estate_flag ON parcels(estate_flag)').run();
}

const db = new Database(DB_PATH);
ensureColumns(db);
const apply = process.argv.includes('--apply');

const owners = db.prepare(`
  SELECT owner_key, COUNT(*) n, MAX(owner_name) owner_name
  FROM parcels WHERE owner_key IS NOT NULL
  GROUP BY owner_key
`).all();

if (apply) {
  const upYes = db.prepare('UPDATE parcels SET estate_flag=1, estate_reason=? WHERE owner_key=?');
  const upNo = db.prepare('UPDATE parcels SET estate_flag=0, estate_reason=NULL WHERE owner_key=?');
  let flaggedOwners = 0, flaggedParcels = 0;
  const tx = db.transaction(() => {
    // reset rows with a NULL owner_key too (can't carry a signal) so re-runs are clean
    db.prepare('UPDATE parcels SET estate_flag=0, estate_reason=NULL WHERE owner_key IS NULL').run();
    for (const o of owners) {
      const label = matchEstate(o.owner_key);
      if (label) { upYes.run(label, o.owner_key); flaggedOwners++; flaggedParcels += o.n; }
      else upNo.run(o.owner_key);
    }
  });
  tx();
  console.log(`Applied estate patterns: flagged ${flaggedParcels} parcels across ${flaggedOwners} owners as estate_flag=1.`);
  db.close();
  return;
}

// ---- report ----
const byReason = new Map();
let taggedOwners = 0, taggedParcels = 0;
for (const o of owners) {
  const label = matchEstate(o.owner_key);
  if (!label) continue;
  taggedOwners++; taggedParcels += o.n;
  byReason.set(label, (byReason.get(label) || 0) + o.n);
}
const totalParcels = owners.reduce((s, o) => s + o.n, 0);

console.log(`\nDistinct owners: ${owners.length} | total parcels (with owner): ${totalParcels}`);
console.log(`Estate/inheritance signal: ${taggedOwners} owners, ${taggedParcels} parcels (${(100 * taggedParcels / totalParcels).toFixed(2)}%)\n`);
console.log('  by signal (all parcels):');
for (const [label, n] of [...byReason.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`    ${String(n).padStart(6)}  ${label}`);
}

// How many flagged parcels survive into the vacant-land candidate universe — the set that matters for outreach.
// Build a one-off matcher table on owner_key to count candidates by reason without re-applying.
const flaggedKeys = new Set(owners.filter((o) => matchEstate(o.owner_key)).map((o) => o.owner_key));
let candTotal = 0, candFlagged = 0;
for (const row of db.prepare(`SELECT owner_key FROM parcels WHERE ${CANDIDATE_SQL}`).iterate()) {
  candTotal++;
  if (row.owner_key && flaggedKeys.has(row.owner_key)) candFlagged++;
}
console.log(`\n  vacant-land candidates: ${candTotal} | with estate signal: ${candFlagged} (${(100 * candFlagged / candTotal).toFixed(2)}%)`);
console.log('\n  (run with --apply to write estate_flag / estate_reason)');

console.log('\n  sample flagged owners:');
for (const o of owners.filter((x) => matchEstate(x.owner_key)).slice(0, 15)) {
  console.log(`    [${matchEstate(o.owner_key).padEnd(22)}] ${(o.owner_name || '').slice(0, 44)}`);
}
db.close();
