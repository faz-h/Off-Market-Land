'use strict';
/*
 * Drawn-area spatial filter helpers. The map lets the user draw a polygon or a radius; that shape becomes a
 * TRUE filter (it flows through buildWhere into count / hexes / parcels / export), matching a parcel when its
 * representative interior point falls inside the shape.
 *
 * Polygon containment can't be expressed in plain SQL, so we register a scalar UDF (oml_in_poly) on the query
 * connection and call it from buildWhere. The polygon JSON is identical for every row in a query, so we
 * memoize the parse (cache of size 1). Radius is pure SQL math in buildWhere — no UDF needed.
 */

// ring: array of [lng, lat]. Standard even-odd ray casting; the ring is treated as closed (wraps last->first).
function pointInPolygon(lng, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1];
    const xj = ring[j][0], yj = ring[j][1];
    const intersect = ((yi > lat) !== (yj > lat)) && (lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

// Register oml_in_poly(lng, lat, polyJson) -> 1/0 on a better-sqlite3 connection.
function registerGeoFns(db) {
  let memoKey = null, memoRing = null;
  db.function('oml_in_poly', { deterministic: true }, (lng, lat, polyJson) => {
    if (lng == null || lat == null || !polyJson) return 0;
    if (polyJson !== memoKey) {
      try { memoRing = JSON.parse(polyJson); } catch (e) { memoRing = null; }
      memoKey = polyJson;
    }
    if (!Array.isArray(memoRing) || memoRing.length < 3) return 0;
    return pointInPolygon(lng, lat, memoRing) ? 1 : 0;
  });
}

module.exports = { pointInPolygon, registerGeoFns };
