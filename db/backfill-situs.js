'use strict';
/*
 * One-time (idempotent) backfill: re-derive situs_street/city/state/zip for every parcel from the stored
 * situs_raw using the corrected parseSitus (db/parcel-util.js). Fixes the historic mis-parse where assembled
 * situs ("STREET, CITY, TX, ZIP" — Harris/Waller/Liberty/Chambers) put the ZIP into the City column and left
 * Zip blank, discarding the real city. Touches ONLY the four situs_* columns — no enrichment is disturbed, so
 * this is far cheaper than a full re-ingest. Safe to re-run.
 *
 *   node db/backfill-situs.js            # report + apply
 *   node db/backfill-situs.js --dry-run  # report only, no writes
 */
const path = require('path');
const Database = require('better-sqlite3');
const util = require('./parcel-util');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'parcels.db');
const DRY = process.argv.includes('--dry-run');

function main() {
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  const rows = db.prepare('SELECT id, situs_raw, situs_street, situs_city, situs_state, situs_zip FROM parcels').all();
  const upd = db.prepare('UPDATE parcels SET situs_street=@street, situs_city=@city, situs_state=@state, situs_zip=@zip WHERE id=@id');

  let changedCity = 0, changedZip = 0, changedAny = 0;
  const pending = [];
  for (const r of rows) {
    const s = util.parseSitus(r.situs_raw);
    const diff = s.street !== r.situs_street || s.city !== r.situs_city || s.state !== r.situs_state || s.zip !== r.situs_zip;
    if (!diff) continue;
    if (s.city !== r.situs_city) changedCity++;
    if (s.zip !== r.situs_zip) changedZip++;
    changedAny++;
    pending.push({ id: r.id, street: s.street, city: s.city, state: s.state, zip: s.zip });
  }

  console.log(`Scanned ${rows.length} parcels.`);
  console.log(`  rows whose situs_* changes: ${changedAny}  (city changed: ${changedCity}, zip changed: ${changedZip})`);
  if (DRY) { console.log('  --dry-run: no writes.'); return; }
  if (pending.length) db.transaction((list) => { for (const it of list) upd.run(it); })(pending);
  console.log(`  applied ${pending.length} updates.`);
}

main();
