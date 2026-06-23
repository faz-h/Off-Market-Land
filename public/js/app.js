'use strict';
/*
 * Off Market Land — spatial filter preview. The map answers "where is my filter producing too many /
 * too few?" before export. It does NOT plot 45k points: it draws an H3 hex choropleth (count or match
 * rate per cell) whose resolution follows zoom, and only drops to real parcel polygons once you zoom in
 * far enough or the whole filtered set is small. Aggregation is server-side (a GROUP BY over precomputed
 * h3_rN columns), so the browser only ever receives ~tens to hundreds of features.
 */
(function () {
  const COUNTIES = ['MONTGOMERY', 'HARRIS', 'BRAZORIA', 'FORT BEND', 'WALLER', 'GALVESTON', 'LIBERTY', 'CHAMBERS', 'AUSTIN'];
  const FLOOD_ZONES = ['None', '500-Year', '100-Year', 'Floodway'];
  const RAMP = ['#ffffb2', '#fed976', '#feb24c', '#fd8d3c', '#f03b20', '#bd0026'];
  const PARCEL_THRESHOLD = 1500; // filtered set <= this -> show individual parcels instead of hexes
  const POLY_ZOOM = 14; // at this zoom+ individual parcels render as polygons; below, as points
  let universeTotal = 0; // total parcels ingested (set from /api/stats)

  // ---- map ----
  const map = L.map('map', { center: [29.95, -95.45], zoom: 8, doubleClickZoom: true });
  const street = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' }).addTo(map);
  const sat = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { maxZoom: 20, attribution: 'Esri World Imagery' });
  const labels = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Transportation/MapServer/tile/{z}/{y}/{x}', { maxZoom: 20 });
  L.control.layers({ Street: street, Satellite: sat }, { 'Road labels': labels }).addTo(map);
  let dataLayer = L.geoJSON(null).addTo(map);
  let lastMode = 'hex';
  let usingBbox = false; // true when the current view is viewport-limited (refetch on pan)
  let geoFilter = null;  // drawn-area filter: { type:'polygon', coords:[[lng,lat]...] } | { type:'circle', clng, clat, radM }

  // ---- build filter controls ----
  const countyList = document.getElementById('county-list');
  COUNTIES.forEach((c) => {
    countyList.insertAdjacentHTML('beforeend',
      `<label class="chk"><input type="checkbox" name="county" value="${c}" checked> ${title(c)}</label>`);
  });
  const floodList = document.getElementById('flood-list');
  FLOOD_ZONES.forEach((f) => {
    floodList.insertAdjacentHTML('beforeend',
      `<label class="chk"><input type="checkbox" name="flood" value="${f}" checked> ${f}</label>`);
  });

  // ---- read current filter state into query params ----
  const el = (id) => document.getElementById(id);
  const val = (id) => el(id).value.trim();
  const checkedVals = (name) => [...document.querySelectorAll(`input[name=${name}]:checked`)].map((i) => i.value);
  const metric = () => document.querySelector('input[name=metric]:checked').value;

  function readFilters() {
    const q = {};
    const counties = checkedVals('county');
    if (counties.length && counties.length < COUNTIES.length) q.county = counties.join(',');
    if (val('acresMin')) q.acresMin = val('acresMin');
    if (val('acresMax')) q.acresMax = val('acresMax');
    const flood = checkedVals('flood');
    if (flood.length && flood.length < FLOOD_ZONES.length) q.flood = flood.join(',');
    if (val('floodPctMax')) q.floodPctMax = val('floodPctMax');
    if (document.querySelector('input[name=pipeline]:checked').value === 'none') q.pipeline = 'none';
    const listings = document.querySelector('input[name=listings]:checked').value;
    if (listings !== 'any') q.listings = listings;
    const exported = document.querySelector('input[name=exported]:checked').value;
    if (exported !== 'any') q.exported = exported;
    const estate = document.querySelector('input[name=estate]:checked').value;
    if (estate !== 'any') q.estate = estate;
    if (val('aadtMin')) q.aadtMin = val('aadtMin');
    if (el('aadtInclNull').checked) q.aadtInclNull = '1'; else q.aadtInclNull = '0';
    if (val('nearRoadMaxFt')) q.nearRoadMaxFt = val('nearRoadMaxFt');
    if (val('nearRoadAadtMin')) q.nearRoadAadtMin = val('nearRoadAadtMin');
    if (val('freewayMaxMi')) q.freewayMaxMi = val('freewayMaxMi');
    if (val('incomeMin')) q.incomeMin = val('incomeMin');
    if (val('incomeMax')) q.incomeMax = val('incomeMax');
    if (val('popMin')) q.popMin = val('popMin');
    // candidate-funnel audit controls
    if (el('showPublic').checked) q.showPublic = '1';
    if (el('showBuilt').checked) q.showBuilt = '1';
    if (el('showExempt').checked) q.showExempt = '1';
    if (val('impMax') !== '') q.impMax = val('impMax');
    // evaluation: view ONLY excluded categories
    if (el('onlyPublic').checked) q.onlyPublic = '1';
    if (el('onlyThin').checked) q.onlyThin = '1';
    if (el('onlyElongated').checked) q.onlyElongated = '1';
    // drawn-area spatial filter (true filter — also carried into export via this same query object)
    if (geoFilter && geoFilter.type === 'polygon' && geoFilter.coords.length >= 3) q.polygon = JSON.stringify(geoFilter.coords);
    else if (geoFilter && geoFilter.type === 'circle') q.circle = `${geoFilter.clng},${geoFilter.clat},${Math.round(geoFilter.radM)}`;
    return q;
  }
  const qs = (o) => new URLSearchParams(o).toString();
  const fetchJSON = (u) => fetch(u).then((r) => r.json());

  // ---- zoom -> hex resolution (null = show parcels) ----
  function resForZoom(z) {
    if (z <= 8) return 5;
    if (z === 9) return 6;
    if (z === 10) return 7;
    if (z === 11) return 8;
    return null;
  }

  // ---- quantile color scale over the visible values ----
  function makeScale(values) {
    const sorted = values.filter((v) => v > 0).sort((a, b) => a - b);
    if (!sorted.length) return { color: () => null, breaks: [], min: 0, max: 0 };
    const breaks = [];
    for (let i = 1; i < RAMP.length; i++) breaks.push(sorted[Math.floor((i / RAMP.length) * sorted.length)]);
    const color = (v) => {
      if (v <= 0) return null;
      let idx = 0;
      while (idx < breaks.length && v >= breaks[idx]) idx++;
      return RAMP[idx];
    };
    return { color, breaks, min: sorted[0], max: sorted[sorted.length - 1] };
  }

  // ---- refresh pipeline (token guards against out-of-order responses) ----
  let token = 0;
  let refreshTimer = null;
  const schedule = () => { clearTimeout(refreshTimer); refreshTimer = setTimeout(refresh, 220); };

  async function refresh() {
    const my = ++token;
    const q = readFilters();
    const countData = await fetchJSON('/api/count?' + qs(q));
    if (my !== token) return;
    renderCount(countData.total);
    renderProfile(countData.byCounty);

    const res = resForZoom(map.getZoom());
    if (countData.total <= PARCEL_THRESHOLD || res === null) {
      await renderParcels(q, countData.total, my);
    } else {
      await renderHexes(q, res, my);
    }
  }

  async function renderHexes(q, res, my) {
    const data = await fetchJSON('/api/aggregate?res=' + res + '&' + qs(q));
    if (my !== token) return;
    lastMode = 'hex';
    const m = metric();
    const valueOf = (f) => (m === 'rate' ? f.properties.rate : f.properties.count);
    const scale = makeScale(data.features.map(valueOf));
    usingBbox = false;
    setLayer(data, {
      style: (f) => {
        const c = scale.color(valueOf(f));
        return { color: '#222', weight: 0.4, fillColor: c || '#000', fillOpacity: c ? 0.62 : 0 };
      },
      onEachFeature: (f, layer) => {
        const p = f.properties;
        layer.bindPopup(
          `<b>${p.count.toLocaleString()}</b> matches of ${p.total.toLocaleString()} parcels here` +
          `<br>match rate <b>${(p.rate * 100).toFixed(1)}%</b>` +
          `<br><small>double-click to zoom in / drill down</small>`);
        if (data.features.length <= 130) {
          const txt = m === 'rate' ? Math.round(p.rate * 100) + '%' : p.count.toLocaleString();
          layer.bindTooltip(txt, { permanent: true, direction: 'center', className: 'hex-label' });
        }
      },
    });
    renderLegend(m, scale, `Hex view · res ${res} · ${data.features.length} cells`);
  }

  // Individual parcels: rep-point markers when zoomed out (boundaries illegible), polygons once zoomed in.
  async function renderParcels(q, total, my) {
    const polyMode = map.getZoom() >= POLY_ZOOM;
    usingBbox = total > PARCEL_THRESHOLD;
    const params = Object.assign({ geom: polyMode ? 'polygon' : 'point', limit: polyMode ? 2000 : 8000 }, q);
    if (usingBbox) {
      const b = map.getBounds();
      params.bbox = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()].join(',');
    }
    const data = await fetchJSON('/api/parcels?' + qs(params));
    if (my !== token) return;
    lastMode = polyMode ? 'polygons' : 'points';
    setLayer(data, polyMode ? {
      style: () => ({ color: '#d61f1f', weight: 1, fillColor: '#ff5b5b', fillOpacity: 0.28 }),
      onEachFeature: parcelPopup,
    } : {
      pointToLayer: (f, latlng) => L.circleMarker(latlng, { radius: 4, color: '#fff', weight: 1, fillColor: '#e3261f', fillOpacity: 0.9 }),
      onEachFeature: parcelPopup,
    });
    const kind = polyMode ? 'Parcels' : 'Points';
    const tail = polyMode ? '' : ' — zoom in for boundaries';
    const note = data.capped
      ? `${kind} · ${data.returned.toLocaleString()} of ${data.matched.toLocaleString()} shown (pan/zoom or tighten filters)${tail}`
      : `${kind} · ${data.returned.toLocaleString()} parcels${tail}`;
    renderLegend(null, null, note, kind);
  }

  function parcelPopup(f, layer) {
    const p = f.properties;
    const pub = p.is_public ? ` <span style="color:#c00">[public: ${p.public_reason || '?'}]</span>` : '';
    const imp = p.improvement_value != null ? '$' + Number(p.improvement_value).toLocaleString() : '—';
    const w = (v) => (v != null ? Math.round(v) : '?');
    layer.bindPopup(
      `<b>${p.owner || '(no owner)'}</b>${pub}` +
      `<br>${title(p.county)} · ${Number(p.acres || 0).toFixed(2)} ac · class ${p.landuse || '—'}` +
      `<br>${p.situs || '(no situs)'}` +
      `<br>imp ${imp} · width ${w(p.width_ft)}/${w(p.width_mean_ft)}ft · ${p.elongation != null ? Math.round(p.elongation) + ':1' : '?'} long` +
      `<br>Flood: ${p.flood_zone || '—'} · AADT: ${p.aadt != null ? p.aadt.toLocaleString() : 'unknown'}` +
      (p.aadt == null && p.near_road_frontier && p.near_road_frontier.length
        ? '<br>Near main road' + (p.near_road_frontier.length > 1 ? 's' : '') + ': '
          + p.near_road_frontier.map((e) => `${e[2] || '—'} ${Number(e[1]).toLocaleString()}@${e[0]}ft`).join(' · ') : '') +
      estateLine(p) +
      listingLine(p) +
      exportedLine(p) +
      `<br><small>PropID ${p.prop_id}</small> · <a href="#" onclick="return omlExclude('${p.prop_id}')">exclude</a>`,
      { maxWidth: 320 });
  }

  // Estate / inheritance badge: owner-name probate proxy (db/flag-estate.js). The reason shows signal
  // strength; "et al (co-owners)" is the weak tier, the rest are strong.
  function estateLine(p) {
    if (!p.estate_flag) return '';
    return `<br><span style="color:#7a3ea8;font-weight:700">INHERITED / ESTATE</span> · ${p.estate_reason || 'estate'}`;
  }

  // Listing cross-reference badge: active listings dominate; a sold-only match shows greyed "SOLD".
  function listingLine(p) {
    if (!p.listed_active && !p.listed_sold) return '';
    const sold = !p.listed_active && p.listed_sold;
    const label = sold ? 'SOLD' : 'ACTIVELY LISTED';
    const color = sold ? '#888' : '#e08600';
    const status = p.listing_status && p.listing_status !== (sold ? 'Sold' : '') ? ` · ${p.listing_status}` : '';
    const price = p.listing_price != null ? ' · $' + Number(p.listing_price).toLocaleString() : '';
    const link = p.listing_url ? ` · <a href="${p.listing_url}" target="_blank" rel="noopener">view listing</a>` : '';
    return `<br><span style="color:${color};font-weight:700">${label}</span>${status}${price}${link}`;
  }

  // Already-exported badge: parcel matches an existing Airtable Accounts(Land) row, so a re-export would
  // append the new campaign tag rather than create a duplicate. Shows the campaign(s) the row is already in.
  function exportedLine(p) {
    if (!p.in_airtable) return '';
    const camps = p.airtable_campaigns ? ` · ${p.airtable_campaigns}` : '';
    return `<br><span style="color:#1a7f37;font-weight:700">ALREADY IN AIRTABLE</span>${camps}`;
  }

  // manual exclude: drop a hand-picked parcel from candidates, then re-render
  window.omlExclude = (id) => {
    fetch('/api/exclude?prop_id=' + encodeURIComponent(id), { method: 'POST' })
      .then((r) => r.json()).then(() => { map.closePopup(); schedule(); });
    return false;
  };

  function setLayer(geojson, opts) {
    map.removeLayer(dataLayer);
    dataLayer = L.geoJSON(geojson, opts).addTo(map);
  }

  // ---- sidebar + legend rendering ----
  function renderCount(total) {
    const big = el('count-big');
    big.textContent = total.toLocaleString();
    big.classList.toggle('warn', total > 8000);
    el('count-lbl').textContent = `candidate parcels of ${universeTotal.toLocaleString()} ingested`;
  }

  function renderProfile(byCounty) {
    const max = byCounty.reduce((m, c) => Math.max(m, c.n), 0) || 1;
    el('profile').innerHTML = byCounty.map((c) =>
      `<div class="bar-row"><span class="name">${title(c.county)}</span>` +
      `<span class="track"><span class="fill" style="width:${(c.n / max * 100).toFixed(0)}%"></span></span>` +
      `<span class="n">${c.n.toLocaleString()}</span></div>`).join('') || '<div class="sub">No matches.</div>';
  }

  function renderLegend(m, scale, note, parcelKind) {
    const lg = el('legend');
    lg.style.display = 'block';
    if (!m || !scale || !scale.breaks.length) {
      el('legend-title').textContent = parcelKind || 'Parcels';
      el('legend-scale').innerHTML = parcelKind === 'Points'
        ? '<i style="background:#e3261f;flex:0 0 12px;height:12px;border-radius:50%"></i>'
        : '<i style="background:#ff5b5b"></i>';
      el('legend-ticks').innerHTML = '';
      el('legend-note').textContent = note;
      return;
    }
    el('legend-title').textContent = m === 'rate' ? 'Match rate per hex' : 'Matches per hex';
    el('legend-scale').innerHTML = RAMP.map((c) => `<i style="background:${c}"></i>`).join('');
    const fmt = m === 'rate' ? (v) => Math.round(v * 100) + '%' : (v) => Math.round(v).toLocaleString();
    const ticks = [scale.min, ...scale.breaks, scale.max];
    el('legend-ticks').innerHTML = `<span>${fmt(ticks[0])}</span><span>${fmt(ticks[ticks.length - 1])}</span>`;
    el('legend-note').textContent = note;
  }

  // ---- events ----
  document.getElementById('filters').addEventListener('input', schedule);
  document.getElementById('filters').addEventListener('change', schedule);
  el('reset').addEventListener('click', () => {
    document.querySelectorAll('#filters input[type=number]').forEach((i) => { i.value = ''; });
    document.querySelectorAll('#filters input[type=checkbox]').forEach((i) => { i.checked = true; });
    document.querySelector('input[name=pipeline][value=any]').checked = true;
    document.querySelector('input[name=listings][value=any]').checked = true;
    document.querySelector('input[name=exported][value=any]').checked = true;
    document.querySelector('input[name=estate][value=any]').checked = true;
    document.querySelector('input[name=metric][value=count]').checked = true;
    clearGeo();
    schedule();
  });
  // "Refresh from Airtable" — re-pull the already-exported flags from Airtable, then re-render the map.
  el('refresh-exported').addEventListener('click', (e) => {
    e.preventDefault();
    const status = el('refresh-exported-status');
    status.style.color = '#555';
    status.textContent = 'Refreshing…';
    fetch('/api/refresh-exported', { method: 'POST' })
      .then((r) => r.json())
      .then((d) => {
        if (!d.ok) { status.style.color = '#c00'; status.textContent = 'Failed: ' + (d.error || 'error'); return; }
        status.style.color = '#0a7d3c';
        status.textContent = `✓ ${Number(d.matched).toLocaleString()} parcels already in Airtable`;
        schedule();
      })
      .catch((err) => { status.style.color = '#c00'; status.textContent = 'Failed: ' + err.message; });
    return false;
  });
  map.on('zoomend', schedule);
  map.on('moveend', () => { if (usingBbox) schedule(); });

  // ---- draw-area spatial filter (polygon / radius) ----
  const drawnGroup = new L.FeatureGroup().addTo(map);
  const drawControl = new L.Control.Draw({
    position: 'topleft',
    draw: {
      polygon: { showArea: false, allowIntersection: true, shapeOptions: { color: '#1c6fe0', weight: 2 } },
      circle: { shapeOptions: { color: '#1c6fe0', weight: 2 } },
      rectangle: false, polyline: false, marker: false, circlemarker: false,
    },
    edit: false,
  });
  map.addControl(drawControl);
  map.on(L.Draw.Event.CREATED, (e) => {
    drawnGroup.clearLayers();
    drawnGroup.addLayer(e.layer);
    if (e.layerType === 'circle') {
      const c = e.layer.getLatLng();
      geoFilter = { type: 'circle', clng: c.lng, clat: c.lat, radM: e.layer.getRadius() };
    } else {
      geoFilter = { type: 'polygon', coords: e.layer.getLatLngs()[0].map((p) => [p.lng, p.lat]) };
    }
    updateGeoChip();
    schedule();
  });
  function clearGeo() { drawnGroup.clearLayers(); geoFilter = null; updateGeoChip(); }
  function updateGeoChip() {
    const active = !!geoFilter;
    el('geo-active').style.display = active ? 'flex' : 'none';
    el('geo-hint').style.display = active ? 'none' : 'block';
    if (active) el('geo-status').textContent = geoFilter.type === 'circle'
      ? `Radius ${(geoFilter.radM / 1609.34).toFixed(2)} mi active` : 'Polygon area active';
  }
  el('geo-clear').addEventListener('click', () => { clearGeo(); schedule(); });

  // ---- finalize batch → export (Airtable + Excel) ----
  let campaignNames = new Set(); // lowercased names already used in Airtable (uniqueness guard)
  let pollTimer = null;
  const destFlags = () => { const v = document.querySelector('input[name=dest]:checked').value; return { airtable: v !== 'excel', excel: v !== 'airtable' }; };

  function openExport() {
    clearInterval(pollTimer); pollTimer = null;
    el('campaignName').value = '';
    el('campaignName').classList.remove('bad');
    el('campaign-msg').textContent = '';
    el('export-progress').style.display = 'none';
    el('export-progress').innerHTML = '';
    el('export-run').textContent = 'Run export';
    el('export-run').disabled = true;
    document.querySelector('input[name=dest][value=airtable]').checked = true;
    el('export-modal').style.display = 'flex';
    el('campaignName').focus();
    const q = readFilters();
    el('export-count').textContent = 'Loading batch size…';
    fetchJSON('/api/count?' + qs(q)).then((d) => {
      el('export-modal').dataset.count = d.total;
      el('export-count').textContent = `This batch = ${d.total.toLocaleString()} candidate parcels (current filters).`;
      updateEstimate();
    });
    fetchJSON('/api/export/campaigns').then((d) => {
      campaignNames = new Set((d.names || []).map((n) => n.trim().toLowerCase()));
      validateCampaign();
    }).catch(() => {});
  }
  function closeExport() { clearInterval(pollTimer); pollTimer = null; el('export-modal').style.display = 'none'; }

  function validateCampaign() {
    const name = el('campaignName').value.trim();
    const msg = el('campaign-msg'); const inp = el('campaignName');
    if (!name) { inp.classList.remove('bad'); msg.textContent = ''; el('export-run').disabled = true; return false; }
    if (campaignNames.has(name.toLowerCase())) {
      inp.classList.add('bad'); msg.className = 'warn-msg';
      msg.textContent = 'That campaign name is already in use — pick a unique name.';
      el('export-run').disabled = true; return false;
    }
    inp.classList.remove('bad'); msg.className = 'ok-msg'; msg.textContent = 'Name available.';
    el('export-run').disabled = false; return true;
  }

  function updateEstimate() {
    const count = Number(el('export-modal').dataset.count || 0);
    const parts = [`Up to ~$${(count * 0.025).toFixed(2)} in first-time geocoding (cached after — re-exports are free).`];
    if (destFlags().airtable) parts.push(`Airtable write ≈ ${Math.max(1, Math.round(count * 0.024 / 60))} min.`);
    el('export-estimate').innerHTML = parts.join('<br>');
  }

  const showProgress = (html) => { const p = el('export-progress'); p.style.display = 'block'; p.innerHTML = html; };
  const bar = (done, total) => { const pct = total ? Math.round(100 * done / total) : (done ? 100 : 0); return `<div class="progress-track"><div class="progress-fill" style="width:${pct}%"></div></div>`; };

  async function runExport() {
    if (!validateCampaign()) return;
    const { airtable, excel } = destFlags();
    const body = { campaignName: el('campaignName').value.trim(), airtable, excel, filters: readFilters() };
    el('export-run').disabled = true; el('export-run').textContent = 'Starting…';
    let resp;
    try {
      resp = await fetch('/api/export', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
        .then((r) => r.json().then((j) => ({ ok: r.ok, j })));
    } catch (e) {
      showProgress(`<div class="warn-msg">Network error: ${e.message}</div>`);
      el('export-run').disabled = false; el('export-run').textContent = 'Run export'; return;
    }
    if (!resp.ok) {
      showProgress(`<div class="warn-msg">${resp.j.error || 'export failed'}</div>`);
      el('export-run').disabled = false; el('export-run').textContent = 'Run export';
      if (resp.j.error && /already in use/.test(resp.j.error)) validateCampaign();
      return;
    }
    el('export-run').textContent = 'Running…';
    pollTimer = setInterval(() => pollStatus(resp.j.jobId), 1500);
    pollStatus(resp.j.jobId);
  }

  async function pollStatus(jobId) {
    let s;
    try { s = await fetchJSON('/api/export/status/' + jobId); } catch (e) { return; }
    if (s.phase === 'error') {
      clearInterval(pollTimer); showProgress(`<div class="warn-msg">Error: ${s.error}</div>`);
      el('export-run').disabled = false; el('export-run').textContent = 'Run export'; return;
    }
    if (s.phase === 'geocoding') {
      const t = s.geocode.total;
      showProgress((t ? `Geocoding new locations… ${s.geocode.done}/${t}` : 'Locations already cached…') + bar(s.geocode.done, t || 1));
    } else if (s.phase === 'airtable') {
      showProgress(`Writing to Airtable… ${s.airtable.done}/${s.airtable.total}` + bar(s.airtable.done, s.airtable.total || 1));
    } else if (s.phase === 'excel') {
      showProgress('Building Excel file…' + bar(1, 1));
    } else if (s.phase === 'done') {
      clearInterval(pollTimer);
      const sm = s.summary || {};
      let html = '<div class="export-summary"><b>Done.</b><br>';
      if (sm.airtable) html += `Airtable: ${sm.airtable.created} created · ${sm.airtable.appended} tagged onto existing · ${sm.airtable.alreadyTagged} already in this campaign.<br>`;
      if (sm.excel) html += `Excel: ${sm.excel.count} rows — <a href="/api/export/download/${jobId}">download ${sm.excel.name}</a><br>`;
      html += '</div>';
      showProgress(html);
      el('export-run').textContent = 'Done';
      fetchJSON('/api/export/campaigns').then((d) => { campaignNames = new Set((d.names || []).map((n) => n.trim().toLowerCase())); }).catch(() => {});
    }
  }

  el('open-export').addEventListener('click', openExport);
  el('export-cancel').addEventListener('click', closeExport);
  el('export-run').addEventListener('click', runExport);
  el('campaignName').addEventListener('input', validateCampaign);
  el('dest-seg').addEventListener('change', updateEstimate);
  el('export-modal').addEventListener('click', (e) => { if (e.target === el('export-modal')) closeExport(); });

  function title(s) { return String(s).toLowerCase().replace(/\b\w/g, (m) => m.toUpperCase()); }

  fetchJSON('/api/stats').then((s) => {
    universeTotal = s.total || 0;
    const label = s.byCounty && s.byCounty.length === 1 ? title(s.byCounty[0].county) + ' County' : 'Greater Houston MSA';
    el('universe').textContent = `${label} · ${universeTotal.toLocaleString()} parcels ingested`;
  }).catch(() => {}).finally(refresh);
})();
