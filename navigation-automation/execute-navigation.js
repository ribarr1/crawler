const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const INPUT_FILE = process.argv[2] || 'output-navigation/all-elements.json';
const MAX_ACTIONS = Number(process.argv[3] || 50);

const EVIDENCE_DIR = process.argv[4] || 'evidence-navigation';
const HEADLESS_ARG = process.argv[5];
const SCREENSHOT_DIR = path.join(EVIDENCE_DIR, 'screenshots');
const DOWNLOAD_DIR = path.join(EVIDENCE_DIR, 'downloads');
const REPORT_DIR = path.join(EVIDENCE_DIR, 'reports');

const HEADLESS = HEADLESS_ARG === undefined ? true : String(HEADLESS_ARG).toLowerCase() !== 'false';
const TIMEOUT_MS = 60000;
const CLICK_TIMEOUT_MS = 15000;
const ALLOW_DESTRUCTIVE_ACTIONS = process.env.NAVEGA_ALLOW_DESTRUCTIVE_ACTIONS === 'true';

const ignoreHTTPSErrors = true;

const ALLOWED_CATEGORIES = new Set([
  'link',
  'button',
  'onclick',
  'aria-label',
  'data-testid'
]);

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function cleanText(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
}

function csvEscape(value) {
  const text = String(value ?? '');
  return `"${text.replace(/"/g, '""')}"`;
}

function safeFileName(value) {
  return String(value || 'item')
    .replace(/https?:\/\//g, '')
    .replace(/[<>:"/\\|?*]+/g, ' ')
    .replace(/\s+/g, '_')
    .replace(/[^a-zA-Z0-9áéíóúÁÉÍÓÚñÑüÜ._-]+/g, '')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .substring(0, 80);
}

function isExternalUrl(url, baseUrl) {
  try {
    const a = new URL(url);
    const b = new URL(baseUrl);
    return a.hostname !== b.hostname;
  } catch {
    return false;
  }
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
    const url = new URL(rawUrl, baseUrl);
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
  const ariaKey = normalizeKeyText(item.ariaLabel);
  const testIdKey = normalizeKeyText(item.dataTestId);

  if (hrefKey) {
    return [
      'link',
      item.tag || '',
      hrefKey,
      textKey || ariaKey || testIdKey || selectorKey
    ].join('|');
  }

  return [
    'action',
    pageKey,
    item.category || '',
    item.tag || '',
    item.type || '',
    textKey || ariaKey || testIdKey || selectorKey
  ].join('|');
}

function normalizeHref(href, baseUrl) {
  if (!href) return '';
  try {
    return new URL(href, baseUrl).href;
  } catch {
    return href;
  }
}

function writeCsv(filePath, rows) {
  const header = [
    'caseId',
    'actionKey',
    'pageKey',
    'hrefKey',
    'environment',
    'status',
    'category',
    'tag',
    'type',
    'text',
    'pageUrl',
    'href',
    'openedUrl',
    'selector',
    'recommendedLocator',
    'beforeScreenshot',
    'afterScreenshot',
    'downloadedFile',
    'errorMessage',
    'durationMs',
  ];

  const csvRows = [
    header.join(','),
    ...rows.map(row => header.map(key => csvEscape(row[key])).join(','))
  ];

  fs.writeFileSync(filePath, csvRows.join('\n'), 'utf8');
}

function writeJson(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

async function getVisibleErrorText(page) {
  try {
    const title = cleanText(await page.title()).toLowerCase();
    const bodyText = await page.locator('body').innerText({ timeout: 3000 });
    const text = cleanText(bodyText).toLowerCase();

    const strongErrorHints = [
      '404 not found',
      '403 forbidden',
      '500 internal server error',
      '503 service unavailable',
      'service temporarily unavailable',
      'temporarily unavailable',
      'página no encontrada',
      'pagina no encontrada',
      'sitio no disponible',
      'servicio no disponible',
      'access denied',
      'internal server error',
      'bad gateway',
      'gateway timeout'
    ];

    const titleHit = strongErrorHints.find(hint => title.includes(hint));
    if (titleHit) return `title:${titleHit}`;

    const bodyHit = strongErrorHints.find(hint => text.includes(hint));
    if (bodyHit) return `body:${bodyHit}`;

    const h1Text = await page.locator('h1').first().innerText({ timeout: 1000 }).catch(() => '');
    const h1 = cleanText(h1Text).toLowerCase();

    const h1Hit = strongErrorHints.find(hint => h1.includes(hint));
    if (h1Hit) return `h1:${h1Hit}`;

    return '';
  } catch {
    return '';
  }
}

async function resolveLocator(page, item) {
  const text = cleanText(item.text);
  const selector = item.selector;
  const tag = item.tag;
  const role = item.role;
  const dataTestId = item.dataTestId;
  const ariaLabel = item.ariaLabel;
  const href = item.href;
  const name = item.name;

  const candidates = [];

  if (dataTestId) {
    candidates.push(page.getByTestId(dataTestId).first());
  }

  // Para links, primero href exacto. Esto evita equivocarse con textos repetidos como "Ver más".
  if (tag === 'a' && href) {
    const safeHref = href.replace(/"/g, '\\"');
    candidates.push(page.locator(`a[href="${safeHref}"]`).first());

    try {
      const absoluteHref = new URL(href, item.pageUrl).href;
      candidates.push(page.locator(`a[href="${absoluteHref.replace(/"/g, '\\"')}"]`).first());
    } catch {}

    try {
      const url = new URL(href, item.pageUrl);
      candidates.push(page.locator(`a[href="${url.pathname}${url.hash}"]`).first());
      candidates.push(page.locator(`a[href="${url.href}"]`).first());
    } catch {}
  }

  if (ariaLabel) {
    const safeAria = ariaLabel.replace(/"/g, '\\"');
    candidates.push(page.locator(`[aria-label="${safeAria}"]`).first());
  }

  if (name) {
    const safeName = name.replace(/"/g, '\\"');
    candidates.push(page.locator(`${tag}[name="${safeName}"]`).first());
  }

  if (selector && selector !== 'button') {
    candidates.push(page.locator(selector).first());
  }

  if (role && text) {
    candidates.push(page.getByRole(role, { name: text, exact: true }).first());
    candidates.push(page.getByRole(role, { name: text, exact: false }).first());
  }

  if (tag === 'button' && text) {
    candidates.push(page.getByRole('button', { name: text, exact: true }).first());
    candidates.push(page.getByRole('button', { name: text, exact: false }).first());
    candidates.push(page.locator('button').filter({ hasText: text }).first());
  }

  if (tag === 'a' && text) {
    candidates.push(page.getByRole('link', { name: text, exact: true }).first());
    candidates.push(page.getByRole('link', { name: text, exact: false }).first());
    candidates.push(page.locator('a').filter({ hasText: text }).first());
  }

  if (selector) {
    candidates.push(page.locator(selector).first());
  }

  for (const locator of candidates) {
    try {
      const count = await locator.count();
      if (count > 0) {
        const visible = await locator.isVisible({ timeout: 1500 }).catch(() => false);
        if (visible) return locator;
      }
    } catch {}
  }

  return null;
}

function shouldExecute(item) {
  if (!item) return false;

  const text = cleanText(item.text).toLowerCase();
  const href = String(item.href || '').trim();
  const category = item.category;
  const tag = item.tag;
  const type = item.type;
  const role = String(item.role || '').toLowerCase();
  const selector = String(item.selector || '').toLowerCase();

  if (selector === 'button.ci--search') {
    return false;
  }

  const pagePath = (() => {
    try {
      return new URL(item.pageUrl).pathname.toLowerCase();
    } catch {
      return '';
    }
  })();

  if (tag === 'a' && href === './' && !text && pagePath !== '/') {
    return false;
  }

  if (pagePath.startsWith('/sites/default/files/')) {
    return false;
  }

  const ariaLabel = String(item.ariaLabel || '').toLowerCase();

  const excludedTexts = [
    'pasar al contenido principal',
    'skip to main content',
    'saltar al contenido principal'
  ];

  if (excludedTexts.includes(text)) return false;

  if (href === '#') return false;
  if (href.startsWith('javascript:')) return false;

  // Excluir mensajes técnicos/render errors capturados como elementos.
  if (
    text.includes('mensaje de error') ||
    text.includes('invalid render array key') ||
    text.includes('drupal\\core\\render') ||
    ariaLabel.includes('mensaje de error')
  ) {
    return false;
  }

  // Excluir slides/grupos de carrusel: no son acciones de usuario.
  if (
    tag === 'div' &&
    (role === 'group' || selector.includes('swiper-slide') || /^\[aria-label="\d+\s*\/\s*\d+"\]/.test(selector))
  ) {
    return false;
  }

  // Evitar botones demasiado genéricos sin texto, aria-label, id, clase específica u onclick.
  if (
    tag === 'button' &&
    !text &&
    !item.ariaLabel &&
    !item.id &&
    !item.className &&
    !item.onclick &&
    selector === 'button'
  ) {
    return false;
  }

  if (tag === 'a' && href) return true;
  if (tag === 'button') return true;
  if (tag === 'input' && ['button', 'submit'].includes(type)) return true;

  if (role === 'button' || role === 'link') return true;
  if (category === 'onclick') return true;
  if (category === 'data-testid') return true;

  // Aria-label solo si el elemento parece accionable.
  if (
    category === 'aria-label' &&
    ['a', 'button', 'input', 'select', 'textarea'].includes(tag)
  ) {
    return true;
  }

  return false;
}

function isDestructiveAction(item) {
  const searchableText = [item.text, item.ariaLabel, item.title, item.name, item.selector, item.href]
    .map(normalizeKeyText)
    .join(' ');
  return /\b(eliminar|delete|borrar|erase|remove|destroy|desactivar|deactivate|cancelar cuenta|cancel account)\b/.test(searchableText);
}

function createSkippedResult(item, caseNumber) {
  return {
    caseId: `TC_NAV_${String(caseNumber).padStart(5, '0')}`,
    actionKey: buildActionKey(item),
    pageKey: normalizeUrlForKey(item.pageUrl, item.pageUrl),
    hrefKey: normalizeUrlForKey(item.href, item.pageUrl),
    status: 'SKIPPED_DESTRUCTIVE',
    category: item.category || '', tag: item.tag || '', type: item.type || '', text: cleanText(item.text),
    pageUrl: item.pageUrl || '', href: item.href || '', openedUrl: '', selector: item.selector || '',
    recommendedLocator: item.recommendedLocator || '', beforeScreenshot: '', afterScreenshot: '', downloadedFile: '',
    errorMessage: 'Acción potencialmente destructiva; contabilizada sin ejecutarse.', durationMs: 0
  };
}

function firstSafeName(...values) {
  for (const value of values) {
    const raw = cleanText(value);
    if (!raw) continue;

    const safe = safeFileName(raw);
    if (safe && safe !== 'item') return safe;
  }

  return 'elemento';
}

async function executeItem(browser, context, item, caseNumber) {
  const caseId = `TC_NAV_${String(caseNumber).padStart(5, '0')}`;
  const startTime = Date.now();

  const elementName = firstSafeName(
    item.text,
    item.title,
    item.ariaLabel,
    item.href,
    item.role,
    item.selector,
    `${item.tag}_${item.type || 'element'}`
  );

  const evidenceBaseName = `${caseId}_${elementName}`;

  const beforeScreenshot = path.join(SCREENSHOT_DIR, `${evidenceBaseName}_before.png`);
  const afterScreenshot = path.join(SCREENSHOT_DIR, `${evidenceBaseName}_after.png`);

  const result = {
    caseId,
    status: 'PENDING',
    category: item.category || '',
    tag: item.tag || '',
    type: item.type || '',
    text: cleanText(item.text),
    pageUrl: item.pageUrl || '',
    href: item.href || '',
    openedUrl: '',
    selector: item.selector || '',
    recommendedLocator: item.recommendedLocator || '',
    beforeScreenshot,
    afterScreenshot,
    downloadedFile: '',
    errorMessage: '',
    durationMs: 0,
    actionKey: buildActionKey(item),
    pageKey: normalizeUrlForKey(item.pageUrl, item.pageUrl),
    hrefKey: normalizeUrlForKey(item.href, item.pageUrl),
    environment: ''
  };

  const page = await context.newPage();

  try {
    try {
      await page.goto(item.pageUrl, {
        waitUntil: 'domcontentloaded',
        timeout: TIMEOUT_MS
      });
    } catch (navigationError) {
      console.warn(`Advertencia al cargar página base: ${item.pageUrl} - ${navigationError.message}`);
    }

    await page.waitForTimeout(5000);

    await page.screenshot({
      path: beforeScreenshot,
      fullPage: true
    });

    const locator = await resolveLocator(page, item);

    if (!locator) {
      const fallbackDone = await fallbackNavigateByHref(page, item, result, afterScreenshot);

      if (fallbackDone) {
        return result;
      }

      result.status = 'FAILED_SELECTOR';
      result.errorMessage = `No fue posible construir locator. text="${result.text}", tag="${result.tag}", href="${result.href}", selector="${result.selector}"`;
      return result;
    }

    const count = await locator.count();

    if (count === 0) {
      const fallbackDone = await fallbackNavigateByHref(page, item, result, afterScreenshot);

      if (fallbackDone) {
        return result;
      }

      result.status = 'FAILED_SELECTOR';
      result.errorMessage = `El elemento no fue encontrado. text="${result.text}", tag="${result.tag}", href="${result.href}", selector="${result.selector}"`;
      return result;
    }

    // Nuevo control: no ejecutar elementos deshabilitados
    const isDisabled = await locator.evaluate(el =>
      el.disabled === true ||
      el.getAttribute('disabled') !== null ||
      el.getAttribute('aria-disabled') === 'true' ||
      el.classList.contains('disabled') ||
      el.classList.contains('swiper-button-disabled')
    ).catch(() => false);

    if (isDisabled) {
      result.status = 'SKIPPED_DISABLED';
      result.errorMessage = 'Elemento omitido porque está deshabilitado.';
      
      await page.screenshot({
        path: afterScreenshot,
        fullPage: true
      }).catch(() => {});

      return result;
    }

    await locator.scrollIntoViewIfNeeded({ timeout: CLICK_TIMEOUT_MS });

    const normalizedHref = normalizeHref(item.href, item.pageUrl);

    if (item.tag === 'a' && normalizedHref && isExternalUrl(normalizedHref, item.pageUrl)) {
      result.status = 'PASSED_EXTERNAL';
      result.openedUrl = normalizedHref;

      await locator.click({
        timeout: CLICK_TIMEOUT_MS,
        button: 'left'
      }).catch(() => {});

      await page.waitForTimeout(2000);

      await page.screenshot({
        path: afterScreenshot,
        fullPage: true
      });

      return result;
    }

    const downloadPromise = page.waitForEvent('download', { timeout: 10000 }).catch(() => null);
    const popupPromise = page.waitForEvent('popup', { timeout: 10000 }).catch(() => null);
    const navigationPromise = page.waitForNavigation({
      waitUntil: 'domcontentloaded',
      timeout: 15000
    }).catch(() => null);

    try {
      await locator.click({
        timeout: CLICK_TIMEOUT_MS,
        button: 'left'
      });
    } catch (clickError) {
      const fallbackDone = await fallbackNavigateByHref(page, item, result, afterScreenshot);

      if (fallbackDone) {
        result.errorMessage = `Click no ejecutado, se usó fallback por href. Error original: ${clickError.message}`;
        return result;
      }

      throw clickError;
    }

    const [download, popup] = await Promise.all([
      downloadPromise,
      popupPromise
    ]);

    await navigationPromise;

    if (download) {
      const suggestedName = download.suggestedFilename();
      const downloadFile = path.join(
        DOWNLOAD_DIR,
        `${evidenceBaseName}_${safeFileName(suggestedName)}`
      );

      await download.saveAs(downloadFile);

      result.status = 'PASSED_DOWNLOAD';
      result.downloadedFile = downloadFile;
      result.openedUrl = page.url();

      await page.screenshot({
        path: afterScreenshot,
        fullPage: true
      });

      return result;
    }

    if (popup) {
      await popup.waitForLoadState('domcontentloaded', { timeout: TIMEOUT_MS }).catch(() => {});
      await popup.waitForTimeout(2000);

      result.status = 'PASSED_POPUP';
      result.openedUrl = popup.url();

      await popup.screenshot({
        path: afterScreenshot,
        fullPage: true
      }).catch(async () => {
        await page.screenshot({
          path: afterScreenshot,
          fullPage: true
        });
      });

      await popup.close().catch(() => {});

      return result;
    }

    await page.waitForTimeout(3000);

    result.openedUrl = page.url();

    const visibleError = await getVisibleErrorText(page);

    await page.screenshot({
      path: afterScreenshot,
      fullPage: true
    });

    if (visibleError) {
      result.status = 'FAILED_VISIBLE_ERROR';
      result.errorMessage = `Se detectó posible error visible en pantalla: ${visibleError}`;
      return result;
    }

    if (result.openedUrl !== item.pageUrl) {
      result.status = 'PASSED_NAVIGATION';
    } else {
      result.status = 'PASSED_CLICK';
    }

    return result;
  } catch (error) {
    result.status = error.message.toLowerCase().includes('timeout')
      ? 'FAILED_TIMEOUT'
      : 'FAILED_CLICK';

    result.errorMessage = error.message;

    try {
      await page.screenshot({
        path: afterScreenshot,
        fullPage: true
      });
    } catch {}

    return result;
  } finally {
    result.durationMs = Date.now() - startTime;
    await page.close().catch(() => {});
  }
}

async function fallbackNavigateByHref(page, item, result, afterScreenshot) {
  if (item.tag !== 'a' || !item.href) {
    return false;
  }

  const targetUrl = normalizeHref(item.href, item.pageUrl);

  if (!targetUrl || targetUrl === item.pageUrl) {
    return false;
  }

  try {
    await page.goto(targetUrl, {
      waitUntil: 'domcontentloaded',
      timeout: TIMEOUT_MS
    }).catch(async () => {
      await page.waitForTimeout(5000);
    });

    await page.waitForTimeout(5000);

    result.openedUrl = page.url();

    await page.screenshot({
      path: afterScreenshot,
      fullPage: true
    });

    const visibleError = await getVisibleErrorText(page);

    if (visibleError) {
      result.status = 'FAILED_VISIBLE_ERROR';
      result.errorMessage = `Fallback href ejecutado, pero se detectó error visible: ${visibleError}`;
    } else {
      result.status = isExternalUrl(targetUrl, item.pageUrl)
        ? 'PASSED_EXTERNAL_FALLBACK'
        : 'PASSED_NAVIGATION_FALLBACK';
    }

    return true;
  } catch (error) {
    result.status = 'FAILED_HREF_FALLBACK';
    result.errorMessage = `Falló fallback por href: ${error.message}`;
    return true;
  }
}

(async () => {
  ensureDir(EVIDENCE_DIR);
  ensureDir(SCREENSHOT_DIR);
  ensureDir(DOWNLOAD_DIR);
  ensureDir(REPORT_DIR);

  if (!fs.existsSync(INPUT_FILE)) {
    console.error(`No existe el archivo de entrada: ${INPUT_FILE}`);
    process.exit(1);
  }

  const raw = fs.readFileSync(INPUT_FILE, 'utf8');
  const inventory = JSON.parse(raw);

  const candidateItems = inventory
    .filter(shouldExecute)
    .filter(item => item.pageUrl);
  const skippedDestructiveItems = ALLOW_DESTRUCTIVE_ACTIONS ? [] : candidateItems.filter(isDestructiveAction);
  const executableItems = candidateItems.filter(item => !isDestructiveAction(item)).slice(0, MAX_ACTIONS);

  console.log(`Inventario total: ${inventory.length}`);
  console.log(`Acciones destructivas contabilizadas y omitidas: ${skippedDestructiveItems.length}`);
  console.log(`Elementos ejecutables fase 1: ${executableItems.length}`);
  console.log(`Máximo a ejecutar: ${MAX_ACTIONS}`);

  const browser = await chromium.launch({
    headless: HEADLESS,
    args: [
      '--ignore-certificate-errors',
      '--allow-running-insecure-content'
    ]
  });

  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    acceptDownloads: true,
    viewport: {
      width: 1440,
      height: 1000
    }
  });

  const results = skippedDestructiveItems.map((item, index) => createSkippedResult(item, index + 1));

  let caseNumber = results.length + 1;

  for (const item of executableItems) {
    console.log(`Ejecutando ${caseNumber}/${executableItems.length}: ${cleanText(item.text) || item.selector || item.href}`);

    const result = await executeItem(browser, context, item, caseNumber);
    results.push(result);

    console.log(`  ${result.status}`);

    caseNumber++;
  }

  const csvReport = path.join(REPORT_DIR, 'navigation-execution-results.csv');
  const jsonReport = path.join(REPORT_DIR, 'navigation-execution-results.json');

  writeCsv(csvReport, results);
  writeJson(jsonReport, results);

  const summary = {
    inputFile: INPUT_FILE,
    maxActions: MAX_ACTIONS,
    totalInventory: inventory.length,
    executed: results.filter(x => x.status !== 'SKIPPED_DESTRUCTIVE').length,
    reported: results.length,
    passedClick: results.filter(x => x.status === 'PASSED_CLICK').length,
    passedNavigation: results.filter(x => x.status === 'PASSED_NAVIGATION').length,
    passedDownload: results.filter(x => x.status === 'PASSED_DOWNLOAD').length,
    passedPopup: results.filter(x => x.status === 'PASSED_POPUP').length,
    warningExternal: results.filter(x => x.status === 'WARNING_EXTERNAL').length,
    failedSelector: results.filter(x => x.status === 'FAILED_SELECTOR').length,
    failedClick: results.filter(x => x.status === 'FAILED_CLICK').length,
    failedTimeout: results.filter(x => x.status === 'FAILED_TIMEOUT').length,
    failedVisibleError: results.filter(x => x.status === 'FAILED_VISIBLE_ERROR').length,
    passedExternal: results.filter(x => x.status === 'PASSED_EXTERNAL').length,
    passedNavigationFallback: results.filter(x => x.status === 'PASSED_NAVIGATION_FALLBACK').length,
    passedExternalFallback: results.filter(x => x.status === 'PASSED_EXTERNAL_FALLBACK').length,
    skippedDestructive: results.filter(x => x.status === 'SKIPPED_DESTRUCTIVE').length,
    failedHrefFallback: results.filter(x => x.status === 'FAILED_HREF_FALLBACK').length,
    skippedDisabled: results.filter(x => x.status === 'SKIPPED_DISABLED').length,
  };

  writeJson(path.join(REPORT_DIR, 'navigation-execution-summary.json'), summary);

  console.log('\nFinalizado.');
  console.log(summary);
  console.log(`Reporte CSV: ${csvReport}`);
  console.log(`Reporte JSON: ${jsonReport}`);
  console.log(`Evidencias: ${SCREENSHOT_DIR}`);

  await browser.close();
})();