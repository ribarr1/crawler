const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const runId = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').replace(/\.\d{3}Z$/, '');
const outputDir = `output-navigation-backoffice-qa-${runId}`;
const metadataPath = path.resolve('.last-qa-run.json');
const args = [
  path.join(__dirname, 'crawl-navigation-auth.js'),
  'https://backoffice.qa.bmcbackoffice.com.co/?_cid_134f3d5c-9305-4d3d-b138-223466013612_cid_',
  '10000',
  outputDir,
  'config.json'
];

const result = spawnSync(process.execPath, args, { stdio: 'inherit' });
if (result.status !== 0) process.exit(result.status || 1);

fs.writeFileSync(metadataPath, JSON.stringify({ runId, outputDir }, null, 2));
console.log(`Inventario QA de la corrida: ${outputDir}`);