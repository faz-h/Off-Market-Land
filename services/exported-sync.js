'use strict';
/*
 * "Already exported to Airtable" cross-reference. A parcel counts as already-exported exactly when an existing
 * Accounts(Land) row matches it by the SAME dedup key the campaign export uses (County + County Property ID,
 * with a Coordinates fallback) — so "exclude already-exported" on the map is identical to "the export would
 * append a campaign tag rather than create a new row" (services/export.js).
 *
 * Airtable is the source of truth, but matching per map-pan would be far too slow, so this stamps a fast local
 * flag (parcels.in_airtable) + the campaign names the row carries (parcels.airtable_campaigns) for the popup.
 * Idempotent like enrich/active-listings.js: clears every flag, then re-stamps the current matches. Triggered
 * on demand from the UI (POST /api/refresh-exported) and incrementally by the export job itself.
 */
const { fetchExistingLand, lookupExisting } = require('./export');

// Ensure the cross-reference columns exist (so a fresh DB / first run can't fail on a missing column).
function ensureExportedColumns(dbw) {
  const cols = dbw.prepare('PRAGMA table_info(parcels)').all().map((c) => c.name);
  if (!cols.includes('in_airtable')) dbw.prepare('ALTER TABLE parcels ADD COLUMN in_airtable INTEGER').run();
  if (!cols.includes('airtable_campaigns')) dbw.prepare('ALTER TABLE parcels ADD COLUMN airtable_campaigns TEXT').run();
  if (!cols.includes('in_airtable_at')) dbw.prepare('ALTER TABLE parcels ADD COLUMN in_airtable_at TEXT').run();
}

// Pull every Accounts(Land) row from Airtable and stamp parcels.in_airtable / airtable_campaigns for matches.
// Returns { total, matched } where matched = local parcels found in Airtable.
async function syncExported(dbw, { stampedAt } = {}) {
  ensureExportedColumns(dbw);
  const byKey = await fetchExistingLand(); // network: paged Airtable read of all Land accounts
  const now = stampedAt || new Date().toISOString();

  const rows = dbw.prepare('SELECT id, county, prop_id, rep_lat, rep_lng FROM parcels').all();
  const clearAll = dbw.prepare('UPDATE parcels SET in_airtable = 0, airtable_campaigns = NULL');
  const stamp = dbw.prepare('UPDATE parcels SET in_airtable = 1, airtable_campaigns = ?, in_airtable_at = ? WHERE id = ?');

  let matched = 0;
  dbw.transaction(() => {
    clearAll.run();
    for (const row of rows) {
      const hit = lookupExisting(byKey, row);
      if (!hit) continue;
      matched++;
      const campaigns = [...hit.campaigns].filter(Boolean).join(' | ') || null;
      stamp.run(campaigns, now, row.id);
    }
  })();

  return { total: rows.length, matched };
}

module.exports = { ensureExportedColumns, syncExported };
