'use strict';
/*
 * Orchestrate the enrichment compute passes in order against already-downloaded layers.
 * Downloads/refresh are separate one-time steps (download-flood.js, download-pipelines.js,
 * download-traffic.js, add-austin-census.js). Re-runnable end-to-end after a parcel re-ingest
 * or a layer refresh. Each pass opens/closes its own SQLite connection, so they run sequentially.
 */
const { execSync } = require('child_process');
const path = require('path');

const STEPS = ['flood.js', 'pipelines.js', 'traffic.js', 'census.js', 'highway.js'];
const t0 = Date.now();
for (const s of STEPS) {
  console.log(`\n===== ${s} =====`);
  execSync(`node ${JSON.stringify(path.join(__dirname, s))}`, { stdio: 'inherit' });
}
console.log(`\nAll enrichment passes complete in ${((Date.now() - t0) / 1000).toFixed(0)}s.`);
