const fs = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');

const PROD_RESULTS = process.argv[2];
const QA_RESULTS = process.argv[3];
const OUTPUT_FILE = process.argv[4] || 'navigation-prod-vs-qa.xlsx';

if (!PROD_RESULTS || !QA_RESULTS) {
  console.error('Uso: node compare-navigation-results.js <prod-results.json> <qa-results.json> <output.xlsx>');
  process.exit(1);
}

function readJson(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`No existe archivo: ${filePath}`);
  }

  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function cleanText(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeKeyText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function normalizeUrlForKey(rawUrl, baseUrl) {
  if (!rawUrl) return '';

  try {
    const url = new URL(rawUrl, baseUrl || rawUrl);
    return `${url.pathname}${url.hash}`.toLowerCase();
  } catch {
    return String(rawUrl || '').toLowerCase();
  }
}

function buildActionKey(item) {
  if (item.actionKey) return item.actionKey;

  const pageKey = normalizeUrlForKey(item.pageUrl, item.pageUrl);
  const hrefKey = normalizeUrlForKey(item.href, item.pageUrl);
  const textKey = normalizeKeyText(item.text);
  const selectorKey = normalizeKeyText(item.selector);

  if (hrefKey) {
    return [
      'link',
      item.tag || '',
      hrefKey,
      textKey || selectorKey
    ].join('|');
  }

  return [
    'action',
    pageKey,
    item.category || '',
    item.tag || '',
    item.type || '',
    textKey || selectorKey
  ].join('|');
}

function pageName(item) {
  const raw = item.openedUrl || item.pageUrl || item.href || '';

  try {
    const url = new URL(raw, item.pageUrl || raw);
    const name = url.pathname.replace(/^\/+|\/+$/g, '') || 'home';
    return decodeURIComponent(name);
  } catch {
    return raw || 'N/A';
  }
}

function titleFromItem(item) {
  const text = cleanText(item.text);
  if (text) return text;

  if (item.href) return `Navegar a ${item.href}`;
  if (item.selector) return `Accionar selector ${item.selector}`;

  return `${item.tag || 'elemento'} ${item.type || ''}`.trim();
}

function descriptionFromItem(item) {
  const title = titleFromItem(item);
  const category = item.category || 'N/A';
  const tag = item.tag || 'N/A';

  return `Validar navegabilidad del elemento "${title}" identificado como category=${category}, tag=${tag}, verificando que la interacción abra pantalla, popup, descarga o ejecute clic sin error técnico.`;
}

function preconditionsFromItem(item, envName) {
  return [
    `Ambiente: ${envName}`,
    `URL origen: ${item.pageUrl || ''}`,
    `Elemento: ${item.category || ''}/${item.tag || ''}`,
    `Tipo: ${item.type || ''}`,
    `Texto: ${cleanText(item.text)}`,
    `Href: ${item.href || ''}`,
    `Selector: ${item.selector || ''}`,
    `ActionKey: ${buildActionKey(item)}`
  ].join('\n');
}

function stepActionFromItem(item) {
  const lines = [
    '1. Abrir la página origen indicada en Preconditions.',
    '2. Esperar carga DOM inicial de la página.',
    '3. Capturar evidencia antes de la acción.',
  ];

  if (item.tag === 'a' && item.href) {
    lines.push(`4. Ubicar el link por href/texto/selector y ejecutar clic sobre: ${item.href}.`);
    lines.push('5. Si el clic visual no es posible por estabilidad/viewport, ejecutar fallback controlado navegando al href.');
  } else {
    lines.push(`4. Ubicar el elemento por selector/rol/texto y ejecutar clic: ${item.selector || item.recommendedLocator || ''}.`);
  }

  lines.push('6. Capturar evidencia después de la acción.');
  lines.push('7. Registrar URL abierta, descarga, popup, estado y errores técnicos.');

  return lines.join('\n');
}

function stepExpectedFromItem(prod, qa) {
  const expected = [
    'La acción debe ejecutarse sin excepción técnica.',
    'La pantalla destino, popup o descarga debe abrirse correctamente.',
    'No debe presentarse error visible tipo 404, 403, 500, 503, access denied o página no encontrada.',
    'Debe generarse evidencia antes y después de la acción.'
  ];

  if (prod && qa) {
    expected.push('El comportamiento debe ser equivalente entre PROD y QA para el mismo ActionKey.');
  } else if (prod && !qa) {
    expected.push('El elemento existe en PROD y no fue encontrado en QA; validar si corresponde a diferencia esperada.');
  } else if (!prod && qa) {
    expected.push('El elemento existe en QA y no fue encontrado en PROD; validar si corresponde a cambio nuevo o diferencia esperada.');
  }

  return expected.join('\n');
}

function isPassed(status) {
  return String(status || '').startsWith('PASSED');
}

function compareStatus(prodStatus, qaStatus) {
  if (prodStatus && !qaStatus) return 'ONLY_PROD';
  if (!prodStatus && qaStatus) return 'ONLY_QA';
  if (prodStatus === qaStatus) return 'MATCH';

  if (isPassed(prodStatus) && isPassed(qaStatus)) {
    return 'EQUIVALENT_PASS';
  }

  if (isPassed(prodStatus) && !isPassed(qaStatus)) {
    return 'REGRESSION_QA';
  }

  if (!isPassed(prodStatus) && isPassed(qaStatus)) {
    return 'IMPROVED_QA';
  }

  return 'DIFFERENT_FAIL';
}

function groupByActionKey(rows, envName) {
  const map = new Map();

  for (const row of rows) {
    const key = buildActionKey(row);

    const enriched = {
      ...row,
      actionKey: key,
      pageKey: row.pageKey || normalizeUrlForKey(row.pageUrl, row.pageUrl),
      hrefKey: row.hrefKey || normalizeUrlForKey(row.href, row.pageUrl),
      environment: envName
    };

    if (!map.has(key)) {
      map.set(key, {
        item: enriched,
        duplicates: []
      });
    } else {
      map.get(key).duplicates.push(enriched);
    }
  }

  return map;
}

function countByStatus(rows) {
  const counts = {};

  for (const row of rows) {
    const status = row.status || 'EMPTY';
    counts[status] = (counts[status] || 0) + 1;
  }

  return counts;
}

function addHeaderStyle(sheet) {
  const header = sheet.getRow(1);
  header.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  header.fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FF1F2937' }
  };
  header.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };

  sheet.views = [{ state: 'frozen', ySplit: 1 }];
  sheet.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: 1, column: sheet.columnCount }
  };
}

function setCommonSheetStyle(sheet) {
  sheet.eachRow((row, rowNumber) => {
    row.alignment = { vertical: 'top', wrapText: true };
    row.eachCell(cell => {
      cell.border = {
        top: { style: 'thin', color: { argb: 'FFE5E7EB' } },
        left: { style: 'thin', color: { argb: 'FFE5E7EB' } },
        bottom: { style: 'thin', color: { argb: 'FFE5E7EB' } },
        right: { style: 'thin', color: { argb: 'FFE5E7EB' } }
      };
    });

    if (rowNumber > 1) {
      row.height = 80;
    }
  });
}

function addStatusFormatting(sheet, statusColumns) {
  for (const col of statusColumns) {
    sheet.getColumn(col).eachCell((cell, rowNumber) => {
      if (rowNumber === 1) return;

      const value = String(cell.value || '');

      if (value.startsWith('PASSED')) {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD1FAE5' } };
      } else if (value.startsWith('FAILED')) {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFEE2E2' } };
      } else if (value.startsWith('ONLY') || value.includes('REGRESSION')) {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFEF3C7' } };
      }
    });
  }
}

async function main() {
  const prodRows = readJson(PROD_RESULTS);
  const qaRows = readJson(QA_RESULTS);

  const prodMap = groupByActionKey(prodRows, 'PROD');
  const qaMap = groupByActionKey(qaRows, 'QA');

  const allKeys = Array.from(new Set([
    ...prodMap.keys(),
    ...qaMap.keys()
  ])).sort();

  const comparisonRows = [];

  for (const key of allKeys) {
    const prodEntry = prodMap.get(key);
    const qaEntry = qaMap.get(key);

    const prod = prodEntry?.item || null;
    const qa = qaEntry?.item || null;
    const base = prod || qa;

    const prodStatus = prod?.status || '';
    const qaStatus = qa?.status || '';

    comparisonRows.push({
      code: base.caseId || key,
      actionKey: key,
      title: titleFromItem(base),
      description: descriptionFromItem(base),
      preconditions: [
        prod ? preconditionsFromItem(prod, 'PROD') : 'No existe en PROD',
        '',
        qa ? preconditionsFromItem(qa, 'QA') : 'No existe en QA'
      ].join('\n'),
      stepAction: stepActionFromItem(base),
      stepExpectedResult: stepExpectedFromItem(prod, qa),
      testLevelCode: 'SYSTEM',
      testTypeCode: 'FUNCTIONAL',
      testPatternCode: 'NAVIGATION_SMOKE',
      page: pageName(base),
      statusProd: prodStatus,
      statusQa: qaStatus,
      comparisonStatus: compareStatus(prodStatus, qaStatus),
      prodOpenedUrl: prod?.openedUrl || '',
      qaOpenedUrl: qa?.openedUrl || '',
      prodBeforeScreenshot: prod?.beforeScreenshot || '',
      prodAfterScreenshot: prod?.afterScreenshot || '',
      qaBeforeScreenshot: qa?.beforeScreenshot || '',
      qaAfterScreenshot: qa?.afterScreenshot || '',
      prodDownloadedFile: prod?.downloadedFile || '',
      qaDownloadedFile: qa?.downloadedFile || '',
      prodErrorMessage: prod?.errorMessage || '',
      qaErrorMessage: qa?.errorMessage || '',
      prodDurationMs: prod?.durationMs || '',
      qaDurationMs: qa?.durationMs || '',
      prodDuplicateCount: prodEntry?.duplicates.length || 0,
      qaDuplicateCount: qaEntry?.duplicates.length || 0
    });
  }

  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'GreenSQA Navigation Comparator';
  workbook.created = new Date();

  const summary = workbook.addWorksheet('00_Summary');
  summary.columns = [
    { header: 'Metric', key: 'metric', width: 34 },
    { header: 'PROD', key: 'prod', width: 18 },
    { header: 'QA', key: 'qa', width: 18 },
    { header: 'Comparison', key: 'comparison', width: 22 }
  ];

  const prodStatusCounts = countByStatus(prodRows);
  const qaStatusCounts = countByStatus(qaRows);

  const matched = comparisonRows.filter(x => x.comparisonStatus === 'MATCH').length;
  const equivalentPass = comparisonRows.filter(x => x.comparisonStatus === 'EQUIVALENT_PASS').length;
  const onlyProd = comparisonRows.filter(x => x.comparisonStatus === 'ONLY_PROD').length;
  const onlyQa = comparisonRows.filter(x => x.comparisonStatus === 'ONLY_QA').length;
  const regressionQa = comparisonRows.filter(x => x.comparisonStatus === 'REGRESSION_QA').length;
  const improvedQa = comparisonRows.filter(x => x.comparisonStatus === 'IMPROVED_QA').length;
  const differentFail = comparisonRows.filter(x => x.comparisonStatus === 'DIFFERENT_FAIL').length;

  summary.addRows([
    { metric: 'Total executed', prod: prodRows.length, qa: qaRows.length, comparison: comparisonRows.length },
    { metric: 'Unique ActionKeys', prod: prodMap.size, qa: qaMap.size, comparison: allKeys.length },
    { metric: 'Exact status match', prod: '', qa: '', comparison: matched },
    { metric: 'Equivalent pass', prod: '', qa: '', comparison: equivalentPass },
    { metric: 'Only PROD', prod: '', qa: '', comparison: onlyProd },
    { metric: 'Only QA', prod: '', qa: '', comparison: onlyQa },
    { metric: 'Regression QA', prod: '', qa: '', comparison: regressionQa },
    { metric: 'Improved QA', prod: '', qa: '', comparison: improvedQa },
    { metric: 'Different fail', prod: '', qa: '', comparison: differentFail }
  ]);

  const allStatuses = Array.from(new Set([
    ...Object.keys(prodStatusCounts),
    ...Object.keys(qaStatusCounts)
  ])).sort();

  summary.addRow({});
  summary.addRow({ metric: 'Status breakdown' });

  for (const status of allStatuses) {
    summary.addRow({
      metric: status,
      prod: prodStatusCounts[status] || 0,
      qa: qaStatusCounts[status] || 0,
      comparison: ''
    });
  }

  addHeaderStyle(summary);
  setCommonSheetStyle(summary);
  summary.getColumn(1).width = 40;

  const comparison = workbook.addWorksheet('01_Comparison');
  comparison.columns = [
    { header: 'code', key: 'code', width: 18 },
    { header: 'Title', key: 'title', width: 34 },
    { header: 'Description', key: 'description', width: 52 },
    { header: 'Preconditions (Variables & Values)', key: 'preconditions', width: 60 },
    { header: 'StepAction', key: 'stepAction', width: 52 },
    { header: 'StepExpectedResult', key: 'stepExpectedResult', width: 52 },
    { header: 'TestLevelCode', key: 'testLevelCode', width: 18 },
    { header: 'TestTypeCode', key: 'testTypeCode', width: 18 },
    { header: 'TestPatternCode', key: 'testPatternCode', width: 22 },
    { header: 'Page', key: 'page', width: 30 },
    { header: 'status prod', key: 'statusProd', width: 24 },
    { header: 'status qa', key: 'statusQa', width: 24 },
    { header: 'comparison status', key: 'comparisonStatus', width: 24 },
    { header: 'actionKey', key: 'actionKey', width: 60 },
    { header: 'prodOpenedUrl', key: 'prodOpenedUrl', width: 48 },
    { header: 'qaOpenedUrl', key: 'qaOpenedUrl', width: 48 },
    { header: 'prodBeforeScreenshot', key: 'prodBeforeScreenshot', width: 48 },
    { header: 'prodAfterScreenshot', key: 'prodAfterScreenshot', width: 48 },
    { header: 'qaBeforeScreenshot', key: 'qaBeforeScreenshot', width: 48 },
    { header: 'qaAfterScreenshot', key: 'qaAfterScreenshot', width: 48 },
    { header: 'prodDownloadedFile', key: 'prodDownloadedFile', width: 42 },
    { header: 'qaDownloadedFile', key: 'qaDownloadedFile', width: 42 },
    { header: 'prodErrorMessage', key: 'prodErrorMessage', width: 60 },
    { header: 'qaErrorMessage', key: 'qaErrorMessage', width: 60 },
    { header: 'prodDurationMs', key: 'prodDurationMs', width: 16 },
    { header: 'qaDurationMs', key: 'qaDurationMs', width: 16 },
    { header: 'prodDuplicateCount', key: 'prodDuplicateCount', width: 18 },
    { header: 'qaDuplicateCount', key: 'qaDuplicateCount', width: 18 }
  ];

  comparison.addRows(comparisonRows);
  addHeaderStyle(comparison);
  setCommonSheetStyle(comparison);
  addStatusFormatting(comparison, [11, 12, 13]);

  const onlyProdSheet = workbook.addWorksheet('02_Only_PROD');
  onlyProdSheet.columns = comparison.columns;
  onlyProdSheet.addRows(comparisonRows.filter(x => x.comparisonStatus === 'ONLY_PROD'));
  addHeaderStyle(onlyProdSheet);
  setCommonSheetStyle(onlyProdSheet);
  addStatusFormatting(onlyProdSheet, [11, 12, 13]);

  const onlyQaSheet = workbook.addWorksheet('03_Only_QA');
  onlyQaSheet.columns = comparison.columns;
  onlyQaSheet.addRows(comparisonRows.filter(x => x.comparisonStatus === 'ONLY_QA'));
  addHeaderStyle(onlyQaSheet);
  setCommonSheetStyle(onlyQaSheet);
  addStatusFormatting(onlyQaSheet, [11, 12, 13]);

  const rawProd = workbook.addWorksheet('04_RAW_PROD');
  const rawQa = workbook.addWorksheet('05_RAW_QA');

  const rawColumns = [
    'caseId', 'actionKey', 'pageKey', 'hrefKey', 'status', 'category', 'tag', 'type',
    'text', 'pageUrl', 'href', 'openedUrl', 'selector', 'recommendedLocator',
    'beforeScreenshot', 'afterScreenshot', 'downloadedFile', 'errorMessage', 'durationMs'
  ].map(key => ({ header: key, key, width: key.includes('Message') ? 60 : 28 }));

  rawProd.columns = rawColumns;
  rawQa.columns = rawColumns;

  rawProd.addRows(prodRows.map(x => ({
    ...x,
    actionKey: buildActionKey(x),
    pageKey: x.pageKey || normalizeUrlForKey(x.pageUrl, x.pageUrl),
    hrefKey: x.hrefKey || normalizeUrlForKey(x.href, x.pageUrl)
  })));

  rawQa.addRows(qaRows.map(x => ({
    ...x,
    actionKey: buildActionKey(x),
    pageKey: x.pageKey || normalizeUrlForKey(x.pageUrl, x.pageUrl),
    hrefKey: x.hrefKey || normalizeUrlForKey(x.href, x.pageUrl)
  })));

  addHeaderStyle(rawProd);
  addHeaderStyle(rawQa);
  setCommonSheetStyle(rawProd);
  setCommonSheetStyle(rawQa);
  addStatusFormatting(rawProd, [5]);
  addStatusFormatting(rawQa, [5]);

  await workbook.xlsx.writeFile(OUTPUT_FILE);

  console.log(`Excel generado: ${OUTPUT_FILE}`);
  console.log({
    prodRows: prodRows.length,
    qaRows: qaRows.length,
    comparisonRows: comparisonRows.length,
    onlyProd,
    onlyQa,
    regressionQa,
    improvedQa
  });
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});