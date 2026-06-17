'use strict';
/*
 * One-time DB seed for fresh deploys (Railway volume first boot). If the SQLite file is missing AND
 * DB_SEED_URL is set, download it before the app starts; otherwise no-op. Safe to run on every boot and
 * locally (the file already exists there). Wired as the first half of the prod start command (railway.json).
 *
 * DB_FILE       absolute path to the SQLite file (the volume mount in prod, e.g. /data/parcels.db)
 * DB_SEED_URL   URL to download the DB from when missing (a signed/expiring URL is recommended — the file
 *               contains owner names/addresses, so don't host it publicly)
 * DB_SEED_AUTH  optional Authorization header value (e.g. "Bearer <token>") for a private source
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const axios = require('axios');

const DB_PATH = process.env.DB_FILE || path.join(__dirname, '..', 'db', 'parcels.db');

async function main() {
  if (fs.existsSync(DB_PATH)) { console.log(`[seed] ${DB_PATH} already present — skipping`); return; }
  const url = process.env.DB_SEED_URL;
  if (!url) { console.log('[seed] DB missing and no DB_SEED_URL set — nothing to seed'); return; }

  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  const tmp = `${DB_PATH}.download`;
  const headers = process.env.DB_SEED_AUTH ? { Authorization: process.env.DB_SEED_AUTH } : {};
  console.log(`[seed] downloading DB -> ${DB_PATH}`);
  const resp = await axios.get(url, { responseType: 'stream', headers, maxRedirects: 5 });
  await new Promise((resolve, reject) => {
    const out = fs.createWriteStream(tmp);
    resp.data.pipe(out);
    out.on('finish', resolve);
    out.on('error', reject);
    resp.data.on('error', reject);
  });
  fs.renameSync(tmp, DB_PATH); // atomic: a partial download never looks like a valid DB
  console.log(`[seed] done (${(fs.statSync(DB_PATH).size / 1e6).toFixed(0)} MB)`);
}

main().catch((e) => { console.error('[seed] failed:', e.message); process.exit(1); });
