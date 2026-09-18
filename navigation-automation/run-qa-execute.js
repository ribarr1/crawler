const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const metadataPath = path.resolve('.last-qa-run.json');
if (!fs.existsSync(metadataPath)) {
  console.error('No existe una corrida QA. Ejecute primero: npm run crawl:qa');
  process.exit(1);
}

const { outputDir } = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
const inputFile = path.join(outputDir, 'actionable-unique-elements.json');
const evidenceDir = outputDir.replace(/^output-/, 'evidence-');
const args = [
  path.join(__dirname, 'execute-navigation-auth.js'),
  inputFile,
  'all',
  evidenceDir,
  'config.json',
  'BACKOFFICE_QA'
];

const result = spawnSync(process.execPath, args, { stdio: 'inherit' });
process.exit(result.status || 0);