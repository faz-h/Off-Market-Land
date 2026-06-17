'use strict';
/*
 * One-time DB seed for fresh deploys (Railway volume first boot). Runs as the first half of the prod start
 * command (railway.json), before app.js. It resolves the DB in this order and is a no-op locally:
 *
 *   1. If "<DB_FILE>.gz" exists on the volume (uploaded out-of-band via `railway volume files upload`),
 *      decompress it OVER DB_FILE (so a partial/corrupt prior file is replaced), then delete the .gz.
 *   2. Else if DB_FILE already exists, do nothing.
 *   3. Else if DB_SEED_URL is set, download it (gunzipping when the URL ends in .gz).
 *
 * DB_FILE       absolute path to the SQLite file (the volume mount in prod, e.g. /data/parcels.db)
 * DB_SEED_URL   optional URL to fetch the DB from when missing (use a signed/expiring URL — the DB holds PII)
 * DB_SEED_AUTH  optional Authorization header value for a private DB_SEED_URL
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const axios = require('axios');

const DB_PATH = process.env.DB_FILE || path.join(__dirname, '..', 'db', 'parcels.db');
const GZ_PATH = `${DB_PATH}.gz`;
const mb = (p) => (fs.statSync(p).size / 1e6).toFixed(0);

function gunzipTo(src, dest) {
  return new Promise((resolve, reject) => {
    const tmp = `${dest}.tmp`;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const stream = fs.createReadStream(src).pipe(zlib.createGunzip()).pipe(fs.createWriteStream(tmp));
    stream.on('finish', () => { fs.renameSync(tmp, dest); resolve(); }); // atomic overwrite of any prior file
    stream.on('error', reject);
  });
}

async function downloadTo(url, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const headers = process.env.DB_SEED_AUTH ? { Authorization: process.env.DB_SEED_AUTH } : {};
  const resp = await axios.get(url, { responseType: 'stream', headers, maxRedirects: 5 });
  await new Promise((resolve, reject) => {
    const out = fs.createWriteStream(dest);
    resp.data.pipe(out);
    out.on('finish', resolve);
    out.on('error', reject);
    resp.data.on('error', reject);
  });
}

async function main() {
  if (fs.existsSync(GZ_PATH)) {
    console.log(`[seed] found ${GZ_PATH} — decompressing over ${DB_PATH}`);
    await gunzipTo(GZ_PATH, DB_PATH);
    fs.rmSync(GZ_PATH, { force: true });
    console.log(`[seed] done (${mb(DB_PATH)} MB)`);
    return;
  }
  if (fs.existsSync(DB_PATH)) { console.log(`[seed] ${DB_PATH} already present — skipping`); return; }
  const url = process.env.DB_SEED_URL;
  if (!url) { console.log('[seed] no DB, no .gz, and no DB_SEED_URL — nothing to seed'); return; }

  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  if (/\.gz($|\?)/i.test(url)) {
    const tmpGz = `${DB_PATH}.url.gz`;
    console.log('[seed] downloading gzipped DB from DB_SEED_URL');
    await downloadTo(url, tmpGz);
    await gunzipTo(tmpGz, DB_PATH);
    fs.rmSync(tmpGz, { force: true });
  } else {
    console.log('[seed] downloading DB from DB_SEED_URL');
    const tmp = `${DB_PATH}.download`;
    await downloadTo(url, tmp);
    fs.renameSync(tmp, DB_PATH);
  }
  console.log(`[seed] done (${mb(DB_PATH)} MB)`);
}

main().catch((e) => { console.error('[seed] failed:', e.message); process.exit(1); });
