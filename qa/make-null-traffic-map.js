'use strict';
/* QA: plot a random sample of NULL-traffic parcels on a Leaflet map (satellite + labels)
 * to visually confirm they're genuinely off-the-beaten-path. Output: qa/null-traffic-sample.html */
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const ROOT = path.join(__dirname, '..');
const DB_PATH = path.join(ROOT, 'db', 'parcels.db');
const OUT = path.join(__dirname, 'null-traffic-sample.html');
const SAMPLE = Number(process.argv[2] || 500);

const db = new Database(DB_PATH, { readonly: true });
const rows = db.prepare(
  'SELECT prop_id, county, acres, situs_street, situs_city, rep_lat, rep_lng, geom_json ' +
  'FROM parcels WHERE frontage_aadt IS NULL ORDER BY RANDOM() LIMIT ?'
).all(SAMPLE);
db.close();

const byCounty = {};
const features = rows.map((r) => {
  byCounty[r.county] = (byCounty[r.county] || 0) + 1;
  const situs = [r.situs_street, r.situs_city].filter(Boolean).join(', ');
  return {
    type: 'Feature',
    geometry: JSON.parse(r.geom_json),
    properties: {
      prop_id: r.prop_id, county: r.county, acres: Number(r.acres || 0).toFixed(2),
      situs, lat: r.rep_lat, lng: r.rep_lng,
    },
  };
});
const fc = { type: 'FeatureCollection', features };
const countyLine = Object.entries(byCounty).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${v}`).join(' · ');

const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"/>
<title>NULL-traffic parcels — QA (${features.length})</title>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"/>
<link rel="stylesheet" href="https://unpkg.com/leaflet.markercluster@1.5.3/dist/MarkerCluster.css"/>
<link rel="stylesheet" href="https://unpkg.com/leaflet.markercluster@1.5.3/dist/MarkerCluster.Default.css"/>
<style>
 html,body,#map{height:100%;margin:0}
 .info{position:absolute;z-index:1000;top:10px;right:10px;background:#fff;padding:8px 12px;border-radius:6px;
       font:12px/1.4 -apple-system,sans-serif;box-shadow:0 1px 5px rgba(0,0,0,.4);max-width:280px}
 .info b{font-size:13px}
</style></head>
<body>
<div id="map"></div>
<div class="info">
 <b>${features.length} NULL-traffic parcels</b> (random sample)<br>
 Numbered bubbles = clusters; zoom in to split into individual parcels.<br>
 <span style="color:#ff00ea">●</span> parcel point &nbsp; <span style="color:#ff2d2d">▭</span> boundary<br>
 Toggle Street / Satellite top-right.<br>
 <small>${countyLine}</small>
</div>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<script src="https://unpkg.com/leaflet.markercluster@1.5.3/dist/leaflet.markercluster.js"></script>
<script>
const DATA = ${JSON.stringify(fc)};
const map = L.map('map');
const osm = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19,attribution:'© OpenStreetMap'});
const sat = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',{maxZoom:20,attribution:'Esri World Imagery'});
const labels = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Transportation/MapServer/tile/{z}/{y}/{x}',{maxZoom:20});
sat.addTo(map); labels.addTo(map);
L.control.layers({'Satellite':sat,'Street':osm},{'Road labels':labels}).addTo(map);

// parcel boundaries (visible when zoomed in)
const poly = L.geoJSON(DATA,{
  style:{color:'#ff2d2d',weight:2,fillColor:'#ff2d2d',fillOpacity:0.15},
  onEachFeature:(f,layer)=>{const p=f.properties;
    layer.bindPopup('<b>'+p.county+'</b> · '+p.acres+' ac<br>'+(p.situs||'(no situs)')+'<br>PropID '+p.prop_id+'<br>'+p.lat.toFixed(6)+', '+p.lng.toFixed(6));}
}).addTo(map);

// clustered points (visible at every zoom)
const cluster = L.markerClusterGroup({maxClusterRadius:45,spiderfyOnMaxZoom:true});
DATA.features.forEach(f=>{const p=f.properties;
  const m = L.circleMarker([p.lat,p.lng],{radius:7,color:'#fff',weight:2,fillColor:'#ff00ea',fillOpacity:1});
  m.bindPopup('<b>'+p.county+'</b> · '+p.acres+' ac<br>'+(p.situs||'(no situs)')+'<br>'+p.lat.toFixed(6)+', '+p.lng.toFixed(6));
  cluster.addLayer(m);
});
map.addLayer(cluster);
map.fitBounds(cluster.getBounds().pad(0.05));
</script>
</body></html>`;

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, html);
console.log('wrote', path.relative(ROOT, OUT), '-', features.length, 'parcels;', (html.length / 1e6).toFixed(2), 'MB');
console.log('by county:', countyLine);
