const { spawnSync } = require('child_process');

const runId = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').replace(/\.\d{3}Z$/, '');
const outputDir = `output-navigation-prod-${runId}`;
const result = spawnSync(process.execPath, [
  require('path').join(__dirname, 'crawl-navigation.js'),
  'https://www.conexionenergeticabmc.com.co/',
  '300',
  outputDir
], { stdio: 'inherit' });

if (result.status !== 0) process.exit(result.status || 1);
require('fs').writeFileSync('.last-public-run.json', JSON.stringify({ runId, outputDir }, null, 2));
console.log(`Inventario público de la corrida: ${outputDir}`);