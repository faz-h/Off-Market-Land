'use strict';
/*
 * Reverse-geocode a parcel's interior point into a human-readable "near <street> in <city>" string for the
 * Accounts `Land - Location Text Field`. Logic is ported from the Outreach App (functions/CRM/Import/
 * locationService.js) so the wording matches existing rows: it probes the center + 4 cardinal points to find
 * the nearest NAMED street, applies the FM / Beltway 8 / I-10 relabelings, and falls back to just the city.
 *
 * Cost control: each call hits Google up to 5 times (~$5/1k calls => ~$25/1k parcels). Results are cached in
 * parcels.location_text so a parcel is geocoded ONCE, ever — re-exports and overlapping batches are free.
 */
const axios = require('axios');

async function getLocationDescription(lat, lng, apiKey) {
  if (!apiKey) return '';
  if (!lat || !lng || isNaN(lat) || isNaN(lng)) return '';
  const searchPoints = [
    { lat, lng }, { lat: lat + 0.001, lng }, { lat: lat - 0.001, lng },
    { lat, lng: lng + 0.001 }, { lat, lng: lng - 0.001 },
  ];
  const streetData = new Map(); // street -> { city, distance }
  let closestCity = null;

  for (const pt of searchPoints) {
    try {
      const resp = await axios.get('https://maps.googleapis.com/maps/api/geocode/json', {
        params: { latlng: `${pt.lat},${pt.lng}`, result_type: 'street_address|route', key: apiKey },
        timeout: 15000,
      });
      for (const result of resp.data.results || []) {
        let streetName = null, cityName = null;
        for (const c of result.address_components) {
          if (c.types.includes('route')) {
            streetName = c.long_name
              .replace(/Farm-To-Market Road/gi, 'FM').replace(/Farm to Market Road/gi, 'FM')
              .replace(/Farm-To-Market/gi, 'FM').replace(/Farm to Market/gi, 'FM');
            if (streetName.toLowerCase().includes('sam houston parkway')) streetName = 'Beltway 8';
            if (streetName.toLowerCase().includes('east freeway')) streetName = 'I-10';
          }
          if (c.types.includes('locality') || c.types.includes('sublocality')
            || c.types.includes('administrative_area_level_3') || c.types.includes('postal_town')) {
            cityName = c.long_name;
          }
        }
        if (streetName && !cityName && result.formatted_address) {
          const parts = result.formatted_address.split(', ');
          if (parts.length >= 3) cityName = parts[1].trim();
        }
        if (streetName && cityName) {
          if (/unnamed|no name/i.test(streetName)) continue;
          const distance = Math.abs(pt.lat - lat) + Math.abs(pt.lng - lng);
          if (!streetData.has(streetName) || streetData.get(streetName).distance > distance) {
            streetData.set(streetName, { city: cityName, distance });
          }
          if (!closestCity || distance < closestCity.distance) closestCity = { name: cityName, distance };
        }
      }
    } catch (e) { /* skip this probe point */ }
  }

  let closestStreet = null, min = Infinity;
  for (const [name, d] of streetData) if (d.distance < min) { min = d.distance; closestStreet = { name, city: d.city }; }
  if (closestStreet) return `near ${closestStreet.name} in ${closestStreet.city}`;
  if (closestCity) return `in ${closestCity.name}`;
  return '';
}

function ensureLocationColumns(db) {
  const have = new Set(db.prepare('PRAGMA table_info(parcels)').all().map((c) => c.name));
  if (!have.has('location_text')) db.prepare('ALTER TABLE parcels ADD COLUMN location_text TEXT').run();
  if (!have.has('location_text_at')) db.prepare('ALTER TABLE parcels ADD COLUMN location_text_at TEXT').run();
  // Reverse-geocode city/zip fallback for parcels the CAD never gave a situs city OR zip (geo_*='' = looked up,
  // none found — so we never retry). Empty string is the "attempted, nothing" sentinel, NULL = never attempted.
  if (!have.has('geo_city')) db.prepare('ALTER TABLE parcels ADD COLUMN geo_city TEXT').run();
  if (!have.has('geo_zip')) db.prepare('ALTER TABLE parcels ADD COLUMN geo_zip TEXT').run();
  if (!have.has('geo_lookup_at')) db.prepare('ALTER TABLE parcels ADD COLUMN geo_lookup_at TEXT').run();
}

const isEmpty = (v) => v == null || String(v).trim() === '';

/*
 * One plain (unrestricted) reverse geocode of an interior point -> { city, zip } from the returned address
 * components. Google returns a postal_code for essentially any valid US point, so this reliably yields at least
 * a zip; locality (city) is taken with the same fallbacks getLocationDescription uses. Returns '' for a field
 * not found. Separate from getLocationDescription (which restricts result_type to streets) so the broad
 * administrative components are visible.
 */
async function reverseCityZip(lat, lng, apiKey) {
  if (!apiKey || !lat || !lng || isNaN(lat) || isNaN(lng)) return { city: '', zip: '' };
  try {
    const resp = await axios.get('https://maps.googleapis.com/maps/api/geocode/json', {
      params: { latlng: `${lat},${lng}`, key: apiKey }, timeout: 15000,
    });
    let city = '', zip = '';
    for (const result of resp.data.results || []) {     // most-specific result first
      for (const c of result.address_components || []) {
        if (!zip && c.types.includes('postal_code')) zip = c.long_name;
        if (!city && (c.types.includes('locality') || c.types.includes('sublocality')
          || c.types.includes('postal_town') || c.types.includes('administrative_area_level_3'))) city = c.long_name;
      }
      if (city && zip) break;
    }
    return { city, zip };
  } catch (e) { return { city: '', zip: '' }; }
}

/*
 * Fill geo_city/geo_zip for batch rows that the CAD left with NEITHER a situs city NOR a situs zip and that have
 * never been looked up (geo_city/geo_zip both NULL). Caches the result (incl. '' for "nothing found", so a point
 * is geocoded ONCE, ever). Mutates each row's .geo_city/.geo_zip in place + writes through. Returns the count
 * newly looked up. db must be a WRITABLE better-sqlite3 handle. Pairs with the export City/Zip fallback so every
 * exported parcel ends up with at least one of the two.
 */
async function geocodeCityZipUncached(db, rows, { apiKey, concurrency = 8, onProgress } = {}) {
  ensureLocationColumns(db);
  const todo = rows.filter((r) => isEmpty(r.situs_city) && isEmpty(r.situs_zip)
    && r.geo_city == null && r.geo_zip == null && r.rep_lat != null && r.rep_lng != null);
  if (!todo.length) { if (onProgress) onProgress(0, 0); return 0; }
  const upd = db.prepare("UPDATE parcels SET geo_city = ?, geo_zip = ?, geo_lookup_at = datetime('now') WHERE id = ?");
  let next = 0, done = 0;
  const worker = async () => {
    while (next < todo.length) {
      const r = todo[next++];
      let city = '', zip = '';
      try { ({ city, zip } = await reverseCityZip(r.rep_lat, r.rep_lng, apiKey)); } catch (e) { city = ''; zip = ''; }
      upd.run(city || '', zip || '', r.id);   // synchronous write — safe to interleave with other workers' awaits
      r.geo_city = city || '';
      r.geo_zip = zip || '';
      done++;
      if (onProgress && (done % 5 === 0 || done === todo.length)) onProgress(done, todo.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, todo.length) }, worker));
  return todo.length;
}

/*
 * Geocode every batch row that has never been geocoded (location_text IS NULL), caching the result (incl. the
 * empty string for "no result", so we never retry it). Mutates each row's .location_text in place and writes
 * through to the DB. Returns the number of parcels newly geocoded. onProgress(done, total) is for the no-cache
 * subset only. db must be a WRITABLE better-sqlite3 handle.
 */
async function geocodeUncached(db, rows, { apiKey, concurrency = 8, onProgress } = {}) {
  ensureLocationColumns(db);
  const todo = rows.filter((r) => r.location_text == null && r.rep_lat != null && r.rep_lng != null);
  if (!todo.length) { if (onProgress) onProgress(0, 0); return 0; }
  const upd = db.prepare("UPDATE parcels SET location_text = ?, location_text_at = datetime('now') WHERE id = ?");
  let next = 0, done = 0;
  const worker = async () => {
    while (next < todo.length) {
      const r = todo[next++];
      let text = '';
      try { text = await getLocationDescription(r.rep_lat, r.rep_lng, apiKey); } catch (e) { text = ''; }
      upd.run(text || '', r.id);   // synchronous write — safe to interleave with other workers' awaits
      r.location_text = text || '';
      r.location_text_at = new Date().toISOString().replace('T', ' ').slice(0, 19);
      done++;
      if (onProgress && (done % 5 === 0 || done === todo.length)) onProgress(done, todo.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, todo.length) }, worker));
  return todo.length;
}

module.exports = { getLocationDescription, ensureLocationColumns, geocodeUncached, reverseCityZip, geocodeCityZipUncached };
