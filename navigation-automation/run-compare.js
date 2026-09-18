const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

function readRun(fileName, label) {
  const filePath = path.resolve(fileName);
  if (!fs.existsSync(filePath)) {
    console.error(`No existe una corrida ${label}. Ejecute primero el crawl y execute correspondientes.`);
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

const qa = readRun('.last-qa-run.json', 'QA');
const prod = readRun('.last-public-run.json', 'pública');
const args = [
  path.join(__dirname, 'compare-navigation-results.js'),
  path.join(prod.outputDir.replace(/^output-/, 'evidence-'), 'reports', 'navigation-execution-results.json'),
  path.join(qa.outputDir.replace(/^output-/, 'evidence-'), 'reports', 'navigation-execution-results.json'),
  `navigation-prod-vs-qa-${qa.runId}.xlsx`
];

const result = spawnSync(process.execPath, args, { stdio: 'inherit' });
process.exit(result.status || 0);