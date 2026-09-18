const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const metadataPath = path.resolve('.last-public-run.json');
if (!fs.existsSync(metadataPath)) {
  console.error('No existe una corrida pública. Ejecute primero: npm run crawl:public');
  process.exit(1);
}

const { outputDir } = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
const visibleArg = process.argv[2] || 'true';
const evidenceDir = outputDir.replace(/^output-/, 'evidence-');
const result = spawnSync(process.execPath, [
  path.join(__dirname, 'execute-navigation.js'),
  path.join(outputDir, 'actionable-elements.json'),
  '50',
  evidenceDir,
  visibleArg
], { stdio: 'inherit' });

process.exit(result.status || 0);