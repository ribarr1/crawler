const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const BASE_CONFIG_PATH = path.join(ROOT, 'config.json');
const BASE_CONFIG = JSON.parse(fs.readFileSync(BASE_CONFIG_PATH, 'utf8'));
const RUN_ID = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').replace(/\.\d{3}Z$/, '');
const MAX_PAGES = process.env.NAVEGA_MODULE_MAX_PAGES || '100';

const ALL_MODULES = [
  { name: 'user', route: '#/user', entryText: 'Parámetros del Sistema' },
  { name: 'on-boarding', route: '#/on-boarding', entryText: 'Vinculación' },
  { name: 'leo', route: '#/leo', entryText: 'Libro Electrónico de Ordenes' },
  { name: 'sponsor-admin', route: '#/sponsor-admin', entryText: 'Operadores y Promotores' },
  { name: 'operations', route: '#/operations', entryText: 'Seguimiento de operaciones' }
];
const MODULES = process.env.NAVEGA_MODULES
  ? ALL_MODULES.filter(module => process.env.NAVEGA_MODULES.split(',').map(value => value.trim()).includes(module.name))
  : ALL_MODULES;

function runNode(script, args) {
  const result = spawnSync(process.execPath, [path.join(__dirname, script), ...args], { stdio: 'inherit' });
  if (result.error) {
    console.error(`No fue posible ejecutar ${script}: ${result.error.message}`);
    return 1;
  }
  return result.status === null ? 1 : result.status;
}

function moduleConfig(module) {
  return {
    ...BASE_CONFIG,
    startUrl: BASE_CONFIG.startUrl,
    maxPages: Number(MAX_PAGES),
    freshLoginOnExecute: true,
    enqueueLinks: true,
    postLoginActions: [
      { type: 'click', label: 'abrir_menu_lateral', selector: 'button.row.ham-nav, button.ham-nav, .ham-nav', timeoutMs: 10000, afterWaitMs: 1500 },
      { type: 'click', label: `abrir_modulo_${module.name}`, selector: `div.cajaUnica:has-text("${module.entryText}"), div.boxImagenes:has-text("${module.entryText}")`, timeoutMs: 20000, afterWaitMs: 4000 }
    ],
    menuClickDiscovery: {
      ...(BASE_CONFIG.menuClickDiscovery || {}),
      enabled: false,
      runOnEveryPage: false,
      enqueueDiscoveredUrls: false
    },
    submenuClickDiscovery: {
      ...(BASE_CONFIG.submenuClickDiscovery || {}),
      enabled: true
    }
  };
}

function main() {
  const runRoot = `output-navigation-backoffice-qa-modules-${RUN_ID}`;
  const evidenceRoot = `evidence-navigation-backoffice-qa-modules-${RUN_ID}`;
  const tempRoot = path.join(ROOT, '.qa-module-config');
  fs.mkdirSync(tempRoot, { recursive: true });

  console.log(`Corrida modular QA: ${RUN_ID}`);
  console.log(`Módulos: ${MODULES.map(module => module.name).join(', ')}`);

  for (const module of MODULES) {
    const outputDir = path.join(runRoot, module.name);
    const evidenceDir = path.join(evidenceRoot, module.name);
    const configPath = path.join(tempRoot, `${module.name}-${RUN_ID}.json`);
    fs.writeFileSync(configPath, JSON.stringify(moduleConfig(module), null, 2));

    console.log(`\n=== ${module.name} | crawl ===`);
    const crawlStatus = runNode('crawl-navigation-auth.js', [
      moduleConfig(module).startUrl,
      MAX_PAGES,
      outputDir,
      configPath
    ]);
    if (crawlStatus !== 0) {
      console.error(`Módulo ${module.name}: crawl falló. Se continúa con el siguiente módulo.`);
      continue;
    }

    console.log(`\n=== ${module.name} | execute ===`);
    const executeStatus = runNode('execute-navigation-auth.js', [
      path.join(outputDir, 'actionable-unique-elements.json'),
      'all',
      evidenceDir,
      configPath,
      'BACKOFFICE_QA'
    ]);
    if (executeStatus !== 0) {
      console.error(`Módulo ${module.name}: execute falló. Se continúa con el siguiente módulo.`);
    }
  }

  fs.writeFileSync(path.join(ROOT, '.last-qa-modules-run.json'), JSON.stringify({
    runId: RUN_ID,
    outputRoot: runRoot,
    evidenceRoot,
    modules: MODULES.map(module => module.name)
  }, null, 2));
  console.log(`\nCorrida modular finalizada: ${runRoot}`);
  console.log(`Evidencias: ${evidenceRoot}`);
}

main();