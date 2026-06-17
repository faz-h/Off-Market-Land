'use strict';
/*
 * Shared parcel helpers used by the county ingest (db/ingest-county.js). Text/geometry utilities,
 * plus the county-source extras: CRS reprojection (proj4 fed the shapefile's own .prj WKT — avoids
 * the State-Plane false-easting unit ambiguity), pole-of-inaccessibility (for both the interior
 * point and the inscribed-circle width), and owner-name normalization for grouping.
 */
const fs = require('fs');
const proj4 = require('proj4');
const polylabel = require('polylabel');

const S = (v) => { if (v === null || v === undefined) return null; const s = String(v).trim(); return s === '' ? null : s; };
const N = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };

// "FM 1463 RD, Fulshear, TX 77494" -> {street, city, state, zip}; tolerant of partial situs.
function parseSitus(raw) {
  const out = { street: null, city: null, state: null, zip: null };
  if (!raw) return out;
  let parts = String(raw).split(',').map((x) => x.replace(/\s+/g, ' ').trim()).filter(Boolean);
  if (parts.length) {
    const last = parts[parts.length - 1];
    let m = last.match(/^([A-Za-z]{2})(?:\s+(\d{5})(?:-\d{4})?)?$/);
    if (m) {
      out.state = m[1].toUpperCase();
      out.zip = m[2] || null;
      parts.pop();
    } else {
      m = last.match(/\b([A-Za-z]{2})\s+(\d{5})(?:-\d{4})?$/);
      if (m) {
        out.state = m[1].toUpperCase();
        out.zip = m[2];
        const head = last.slice(0, m.index).trim();
        if (head) parts[parts.length - 1] = head; else parts.pop();
      }
    }
  }
  if (parts.length >= 1) out.street = parts[0] || null;
  if (parts.length >= 2) out.city = parts[parts.length - 1] || null;
  out.state = out.state || 'TX';
  return out;
}

// Largest ring-set of a (Multi)Polygon, by area in the geometry's own units.
function largestPolygonCoords(geom) {
  if (!geom) return null;
  if (geom.type === 'Polygon') return geom.coordinates;
  if (geom.type === 'MultiPolygon') {
    let best = null, bestArea = -1;
    for (const poly of geom.coordinates) {
      const area = Math.abs(ringArea(poly[0] || []));
      if (area > bestArea) { bestArea = area; best = poly; }
    }
    return best;
  }
  return null;
}

// Shoelace area of a single ring (planar; units of the input coords squared).
function ringArea(ring) {
  let a = 0;
  for (let i = 0, n = ring.length, j = n - 1; i < n; j = i++) {
    a += (ring[j][0] + ring[i][0]) * (ring[j][1] - ring[i][1]);
  }
  return a / 2;
}

// Pole of inaccessibility of a ring-set: the deepest interior point and its distance to the
// boundary (= inscribed-circle radius), in the input coordinate units.
function poleInfo(ringSet, precision) {
  const p = polylabel(ringSet, precision);
  return { x: p[0], y: p[1], distance: p.distance };
}

// Build a reprojector from the shapefile's .prj (any CRS) to WGS84 lng/lat.
function loadReprojector(prjPath) {
  const wkt = fs.readFileSync(prjPath, 'utf8').trim();
  const t = proj4(wkt, 'EPSG:4326');
  return (pt) => t.forward(pt);
}

// Deep-map a (Multi)Polygon's coordinates through a point transform (e.g. reprojection).
function mapGeometry(geom, fwd) {
  if (!geom) return null;
  const ring = (r) => r.map(fwd);
  const poly = (p) => p.map(ring);
  if (geom.type === 'Polygon') return { type: 'Polygon', coordinates: geom.coordinates.map(ring) };
  if (geom.type === 'MultiPolygon') return { type: 'MultiPolygon', coordinates: geom.coordinates.map(poly) };
  return geom;
}

// From a WGS84 (Multi)Polygon: the inscribed-circle width (ft) and a guaranteed-interior rep point [lng,lat].
// CRS-independent (projects the largest ring-set to local meters), so any source CRS works once reprojected.
function widthAndRepFrom4326(geom) {
  const ring = largestPolygonCoords(geom);
  if (!ring || !ring[0] || !ring[0].length) return { width_ft: null, rep: null };
  const outer = ring[0];
  let la = 0, lo = 0;
  for (const p of outer) { lo += p[0]; la += p[1]; }
  la /= outer.length; lo /= outer.length;
  const kx = 111320 * Math.cos(la * Math.PI / 180), ky = 110540;
  const ringM = ring.map((r) => r.map(([x, y]) => [(x - lo) * kx, (y - la) * ky]));
  const pole = polylabel(ringM, 1); // meters
  return { width_ft: 2 * pole.distance * 3.28084, rep: [lo + pole[0] / kx, la + pole[1] / ky] };
}

// Normalized owner name for grouping (case/punctuation/whitespace-insensitive).
function normalizeOwnerKey(name) {
  if (!name) return null;
  const k = String(name).toUpperCase().replace(/[^A-Z0-9 &]/g, ' ').replace(/\s+/g, ' ').trim();
  return k || null;
}

module.exports = {
  S, N, parseSitus, largestPolygonCoords, ringArea, poleInfo, loadReprojector, mapGeometry, normalizeOwnerKey,
  widthAndRepFrom4326,
};
