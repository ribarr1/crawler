require('dotenv').config();
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const INPUT_FILE = process.argv[2] || 'output-navigation/actionable-unique-elements.json';
const MAX_ACTIONS_ARG = process.argv[3] || '50';
const MAX_ACTIONS = String(MAX_ACTIONS_ARG).toLowerCase() === 'all' ? Number.MAX_SAFE_INTEGER : Number(MAX_ACTIONS_ARG || 50);
const EVIDENCE_DIR = process.argv[4] || 'evidence-navigation';
const CONFIG_FILE = process.argv[5] || '';
const ENVIRONMENT = process.argv[6] || '';

const INPUT_DIR = path.dirname(INPUT_FILE);
const SCREENSHOT_DIR = path.join(EVIDENCE_DIR, 'screenshots');
const DOWNLOAD_DIR = path.join(EVIDENCE_DIR, 'downloads');
const REPORT_DIR = path.join(EVIDENCE_DIR, 'reports');

function readConfig(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return {};
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

const CONFIG = readConfig(CONFIG_FILE);
const HEADLESS = CONFIG.headlessExecute ?? CONFIG.headless ?? true;
const TIMEOUT_MS = Number(CONFIG.timeoutMs || 90000);
const CLICK_TIMEOUT_MS = Number(CONFIG.clickTimeoutMs || 15000);
const POST_ACTION_WAIT_MS = Number(CONFIG.postActionWaitMs || 3500);
const ALLOW_DESTRUCTIVE_ACTIONS = CONFIG.allowDestructiveActions === true || process.env.NAVEGA_ALLOW_DESTRUCTIVE_ACTIONS === 'true';

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function cleanText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
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
  if (hrefKey) return ['link', item.tag || '', hrefKey, textKey || ariaKey || testIdKey || selectorKey].join('|');
  return ['action', pageKey, item.category || '', item.tag || '', item.type || '', textKey || ariaKey || testIdKey || selectorKey].join('|');
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
    .substring(0, 90) || 'item';
}

function writeJson(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

function writeCsv(filePath, rows) {
  const header = [
    'caseId','actionKey','pageKey','hrefKey','environment','status','category','tag','type','text',
    'pageUrl','frameUrl','href','openedUrl','selector','recommendedLocator','beforeScreenshot','afterScreenshot',
    'downloadedFile','errorMessage','durationMs'
  ];
  const csvRows = [header.join(','), ...rows.map(row => header.map(key => csvEscape(row[key])).join(','))];
  fs.writeFileSync(filePath, csvRows.join('\n'), 'utf8');
}

function normalizeHref(href, baseUrl) {
  if (!href) return '';
  try { return new URL(href, baseUrl).href; } catch { return href; }
}

function isExternalUrl(url, baseUrl) {
  try { return new URL(url).hostname !== new URL(baseUrl).hostname; } catch { return false; }
}

function shouldInspectFrame(url) {
  if (!url) return false;
  const lower = url.toLowerCase();
  return !lower.startsWith('about:blank') && !lower.startsWith('chrome-error://') && !lower.startsWith('devtools://');
}

function shouldExecute(item) {
  if (!item || !item.pageUrl) return false;
  if (item.isActionable === false) return false;

  const text = normalizeKeyText(item.text);
  const href = String(item.href || '').trim();
  const tag = String(item.tag || '').toLowerCase();
  const type = String(item.type || '').toLowerCase();
  const role = String(item.role || '').toLowerCase();
  const selector = String(item.selector || '').toLowerCase();
  const cls = String(item.className || '').toLowerCase();
  const actionKey = String(item.actionKey || '').toLowerCase();

  if (CONFIG.freshLoginOnExecute === true && actionKey.startsWith('nav|shell|')) return false;

  if (text.includes('cerrar sesion') || text.includes('cerrar sesión') || text === 'logout' || text === 'pruebas qa') return false;
  if (cls.includes('btncerrarsesion') || cls.includes('btnnombreusuario')) return false;
  if (selector.includes('btncerrarsesion')) return false;
  if (href === '#' || href.startsWith('javascript:')) return false;
  // Conservamos nav|shell y nav|home-card: son alcance de navegación visual.
  if (actionKey.startsWith('nav|shell|') || actionKey.startsWith('nav|home-card|')) return true;
  if (tag === 'a' && href) return true;
  if (tag === 'button') return true;
  if (tag === 'input' && ['button', 'submit'].includes(type)) return true;
  if (role === 'button' || role === 'link') return true;
  if (['onclick', 'data-testid', 'aria-label', 'link', 'button'].includes(String(item.category || '').toLowerCase())) return true;
  return false;
}

function isDestructiveAction(item) {
  const searchableText = [item.text, item.ariaLabel, item.title, item.name, item.selector, item.href]
    .map(normalizeKeyText)
    .join(' ');
  return /\b(eliminar|delete|borrar|erase|remove|destroy|desactivar|deactivate|cancelar cuenta|cancel account)\b/.test(searchableText);
}

function splitSelectors(selector) {
  return String(selector || '').split(',').map(value => value.trim()).filter(Boolean);
}

async function findVisibleInFrames(page, selector, timeoutMs = 15000) {
  const selectors = splitSelectors(selector);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const frame of page.frames()) {
      if (!shouldInspectFrame(frame.url())) continue;
      for (const currentSelector of selectors) {
        const locator = frame.locator(currentSelector).first();
        if (await locator.count().catch(() => 0) && await locator.isVisible({ timeout: 500 }).catch(() => false)) {
          return locator;
        }
      }
    }
    await page.waitForTimeout(300);
  }
  return null;
}

async function loginAndBootstrap(page, item) {
  const auth = CONFIG.auth || {};
  if (!auth.enabled || CONFIG.freshLoginOnExecute !== true) return;

  const username = process.env[auth.usernameEnv || 'NAVEGA_USER'];
  const password = process.env[auth.passwordEnv || 'NAVEGA_PASSWORD'];
  if (!username || !password) throw new Error('Faltan credenciales para login durante execute.');

  await page.goto(auth.loginUrl || CONFIG.startUrl, { waitUntil: 'domcontentloaded', timeout: TIMEOUT_MS });
  const usernameLocator = await findVisibleInFrames(page, auth.usernameSelector || 'input[type="text"]');
  const passwordLocator = await findVisibleInFrames(page, auth.passwordSelector || 'input[type="password"]');
  if (!usernameLocator || !passwordLocator) throw new Error('No se encontraron los campos de login durante execute.');
  await usernameLocator.fill(username);
  await passwordLocator.fill(password);
  const submitLocator = await findVisibleInFrames(page, auth.submitSelector || 'button[type="submit"]');
  if (!submitLocator) throw new Error('No se encontró el botón de login durante execute.');
  await submitLocator.click({ timeout: CLICK_TIMEOUT_MS });
  await page.waitForLoadState('networkidle', { timeout: TIMEOUT_MS }).catch(() => {});
  await page.waitForTimeout(Number(auth.postLoginWaitMs || 6000));

  for (const action of CONFIG.postLoginActions || []) {
    if (action.type !== 'click' || !action.selector) continue;
    const locator = await findVisibleInFrames(page, action.selector, Number(action.timeoutMs || 15000));
    if (!locator) throw new Error(`No fue posible ejecutar bootstrap: ${action.label || action.selector}`);
    await locator.click({ timeout: CLICK_TIMEOUT_MS }).catch(() => locator.evaluate(element => element.click()));
    await page.waitForTimeout(Number(action.afterWaitMs || 1500));
  }

  const expectedHash = (() => {
    try { return new URL(item.pageUrl).hash; } catch { return ''; }
  })();
  if (expectedHash) {
    await page.waitForURL(url => url.hash === expectedHash, { timeout: TIMEOUT_MS }).catch(() => {});
    await page.waitForTimeout(Number(CONFIG.moduleReadyWaitMs || 3000));
  }
}

function createSkippedResult(item, caseNumber) {
  return {
    caseId: `TC_NAV_${String(caseNumber).padStart(5, '0')}`,
    actionKey: buildActionKey(item),
    pageKey: normalizeUrlForKey(item.pageUrl, item.pageUrl),
    hrefKey: normalizeUrlForKey(item.href, item.pageUrl),
    environment: ENVIRONMENT,
    status: 'SKIPPED_DESTRUCTIVE',
    category: item.category || '', tag: item.tag || '', type: item.type || '', text: cleanText(item.text),
    pageUrl: item.pageUrl || '', frameUrl: item.frameUrl || '', href: item.href || '', openedUrl: '', selector: item.selector || '',
    recommendedLocator: item.recommendedLocator || '', beforeScreenshot: '', afterScreenshot: '', downloadedFile: '',
    errorMessage: 'Acción potencialmente destructiva; contabilizada sin ejecutarse.', durationMs: 0
  };
}

async function getVisibleErrorText(page) {
  try {
    const title = cleanText(await page.title()).toLowerCase();
    const bodyText = await page.locator('body').innerText({ timeout: 3000 }).catch(() => '');
    const text = cleanText(bodyText).toLowerCase();
    const strongErrorHints = [
      '404 not found','403 forbidden','500 internal server error','503 service unavailable',
      'service temporarily unavailable','temporarily unavailable','página no encontrada','pagina no encontrada',
      'sitio no disponible','servicio no disponible','access denied','internal server error','bad gateway','gateway timeout'
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
  } catch { return ''; }
}

async function ensureShellMenuOpen(page, item) {
  const actionKey = String(item.actionKey || '').toLowerCase();
  const text = cleanText(item.text);
  if (!actionKey.startsWith('nav|shell|') || !text) return;
  const visible = await page.locator('div.boxNaviButton').filter({ hasText: text }).first().isVisible({ timeout: 1000 }).catch(() => false);
  if (visible) return;
  const ham = page.locator('button.row.ham-nav, button.ham-nav, .ham-nav').first();
  if (await ham.count().catch(() => 0)) {
    await ham.click({ timeout: CLICK_TIMEOUT_MS }).catch(() => {});
    await page.waitForTimeout(1000);
  }
}

async function ensureMicroMenuOpen(page, item) {
  if (!String(item.className || '').toLowerCase().includes('dropdown-item') && !String(item.actionKey || '').toLowerCase().startsWith('nav|microfrontend|')) return;
  for (const frame of page.frames().filter(f => shouldInspectFrame(f.url()))) {
    const itemVisible = await frame.locator('.dropdown-item, button.dropdown-item').filter({ hasText: cleanText(item.text) }).first().isVisible({ timeout: 600 }).catch(() => false);
    if (itemVisible) return;
    const menu = frame.locator('#dropdownBasic1, button#dropdownBasic1, button.dropdown-toggle').first();
    if (await menu.count().catch(() => 0)) {
      await menu.click({ timeout: CLICK_TIMEOUT_MS }).catch(() => {});
      await page.waitForTimeout(800);
      return;
    }
  }
}

function candidateFrames(page, item) {
  const frames = page.frames().filter(f => shouldInspectFrame(f.url()));
  const itemFrameKey = normalizeUrlForKey(item.frameUrl || '', item.pageUrl || '');
  const scored = frames.map(frame => {
    const key = normalizeUrlForKey(frame.url(), item.pageUrl || page.url());
    let score = 0;
    if (item.frameUrl && key === itemFrameKey) score += 10;
    if (item.frameUrl && frame.url().includes((item.frameUrl.split('#')[1] || '___'))) score += 5;
    if (item.frameIndex && String(item.frameIndex) === String(frames.indexOf(frame) + 1)) score += 1;
    return { frame, score };
  });
  return scored.sort((a,b) => b.score - a.score).map(x => x.frame);
}

function locatorsForFrame(frame, item) {
  const text = cleanText(item.text);
  const selector = item.selector;
  const tag = String(item.tag || '').toLowerCase();
  const role = item.role;
  const dataTestId = item.dataTestId;
  const ariaLabel = item.ariaLabel;
  const href = item.href;
  const name = item.name;
  const candidates = [];

  if (dataTestId) candidates.push(frame.getByTestId(dataTestId).first());
  if (tag === 'a' && href) {
    const safeHref = href.replace(/"/g, '\\"');
    candidates.push(frame.locator(`a[href="${safeHref}"]`).first());
  }
  if (ariaLabel) candidates.push(frame.locator(`[aria-label="${ariaLabel.replace(/"/g, '\\"')}"]`).first());
  if (name && tag) candidates.push(frame.locator(`${tag}[name="${name.replace(/"/g, '\\"')}"]`).first());
  if (selector && selector !== 'button' && !selector.includes(':has-text')) candidates.push(frame.locator(selector).first());
  if (selector && selector.includes(':has-text')) candidates.push(frame.locator(selector).first());
  if (String(item.className || '').includes('boxNaviButton') && text) candidates.push(frame.locator('div.boxNaviButton').filter({ hasText: text }).first());
  if (String(item.className || '').includes('dropdown-item') && text) candidates.push(frame.locator('.dropdown-item').filter({ hasText: text }).first());
  if (role && text) {
    candidates.push(frame.getByRole(role, { name: text, exact: true }).first());
    candidates.push(frame.getByRole(role, { name: text, exact: false }).first());
  }
  if (tag === 'button' && text) {
    candidates.push(frame.getByRole('button', { name: text, exact: true }).first());
    candidates.push(frame.getByRole('button', { name: text, exact: false }).first());
    candidates.push(frame.locator('button').filter({ hasText: text }).first());
  }
  if (tag === 'a' && text) {
    candidates.push(frame.getByRole('link', { name: text, exact: true }).first());
    candidates.push(frame.getByRole('link', { name: text, exact: false }).first());
    candidates.push(frame.locator('a').filter({ hasText: text }).first());
  }
  if (text && String(item.actionKey || '').toLowerCase().startsWith('nav|home-card|')) {
    candidates.push(frame.locator('div, a, button, section, article').filter({ hasText: text }).first());
  }
  if (selector) candidates.push(frame.locator(selector).first());
  return candidates;
}

async function resolveLocator(page, item) {
  await ensureShellMenuOpen(page, item);
  await ensureMicroMenuOpen(page, item);

  for (const frame of candidateFrames(page, item)) {
    for (const locator of locatorsForFrame(frame, item)) {
      try {
        const count = await locator.count();
        if (count > 0) {
          const visible = await locator.isVisible({ timeout: 1200 }).catch(() => false);
          if (visible) return locator;
        }
      } catch {}
    }
  }
  return null;
}

async function fallbackNavigateByHref(page, item, result, afterScreenshot) {
  if (String(item.tag || '').toLowerCase() !== 'a' || !item.href) return false;
  const targetUrl = normalizeHref(item.href, item.pageUrl);
  if (!targetUrl || targetUrl === item.pageUrl) return false;
  try {
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: TIMEOUT_MS }).catch(async () => page.waitForTimeout(4000));
    await page.waitForTimeout(2500);
    result.openedUrl = page.url();
    await page.screenshot({ path: afterScreenshot, fullPage: true }).catch(() => {});
    const visibleError = await getVisibleErrorText(page);
    if (visibleError) {
      result.status = 'FAILED_VISIBLE_ERROR';
      result.errorMessage = `Fallback href ejecutado, pero se detectó error visible: ${visibleError}`;
    } else {
      result.status = isExternalUrl(targetUrl, item.pageUrl) ? 'PASSED_EXTERNAL_FALLBACK' : 'PASSED_NAVIGATION_FALLBACK';
    }
    return true;
  } catch (error) {
    result.status = 'FAILED_HREF_FALLBACK';
    result.errorMessage = `Falló fallback por href: ${error.message}`;
    return true;
  }
}

async function executeItem(context, item, caseNumber) {
  const caseId = `TC_NAV_${String(caseNumber).padStart(5, '0')}`;
  const startTime = Date.now();
  const elementName = safeFileName(item.text || item.title || item.ariaLabel || item.href || item.selector || `${item.tag || 'element'}`);
  const evidenceBaseName = `${caseId}_${elementName}`;
  const beforeScreenshot = path.join(SCREENSHOT_DIR, `${evidenceBaseName}_before.png`);
  const afterScreenshot = path.join(SCREENSHOT_DIR, `${evidenceBaseName}_after.png`);

  const result = {
    caseId,
    actionKey: buildActionKey(item),
    pageKey: normalizeUrlForKey(item.pageUrl, item.pageUrl),
    hrefKey: normalizeUrlForKey(item.href, item.pageUrl),
    environment: ENVIRONMENT,
    status: 'PENDING',
    category: item.category || '', tag: item.tag || '', type: item.type || '', text: cleanText(item.text),
    pageUrl: item.pageUrl || '', frameUrl: item.frameUrl || '', href: item.href || '', openedUrl: '', selector: item.selector || '',
    recommendedLocator: item.recommendedLocator || '', beforeScreenshot, afterScreenshot, downloadedFile: '', errorMessage: '', durationMs: 0
  };

  const page = await context.newPage();
  try {
    await loginAndBootstrap(page, item);
    const bootstrappedRoute = normalizeUrlForKey(page.url(), page.url());
    const itemRoute = normalizeUrlForKey(item.pageUrl, page.url());
    if (CONFIG.freshLoginOnExecute !== true || bootstrappedRoute !== itemRoute) {
      await page.goto(item.pageUrl, { waitUntil: 'domcontentloaded', timeout: TIMEOUT_MS }).catch(err => {
        console.warn(`Advertencia al cargar página base: ${item.pageUrl} - ${err.message}`);
      });
    }
    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(2500);
    await page.screenshot({ path: beforeScreenshot, fullPage: true });

    const urlBefore = page.url();
    const locator = await resolveLocator(page, item);
    if (!locator) {
      const fallbackDone = await fallbackNavigateByHref(page, item, result, afterScreenshot);
      if (fallbackDone) return result;
      result.status = 'FAILED_SELECTOR';
      result.errorMessage = `No fue posible localizar el elemento en página o frames. text="${result.text}", selector="${result.selector}", frameUrl="${result.frameUrl}"`;
      await page.screenshot({ path: afterScreenshot, fullPage: true }).catch(() => {});
      return result;
    }

    const isDisabled = await locator.evaluate(el =>
      el.disabled === true || el.getAttribute('disabled') !== null || el.getAttribute('aria-disabled') === 'true' ||
      el.classList.contains('disabled') || el.classList.contains('swiper-button-disabled')
    ).catch(() => false);
    if (isDisabled) {
      result.status = 'SKIPPED_DISABLED';
      result.errorMessage = 'Elemento omitido porque está deshabilitado.';
      await page.screenshot({ path: afterScreenshot, fullPage: true }).catch(() => {});
      return result;
    }

    await locator.scrollIntoViewIfNeeded({ timeout: CLICK_TIMEOUT_MS }).catch(() => {});

    const normalizedHref = normalizeHref(item.href, item.pageUrl);
    if (String(item.tag || '').toLowerCase() === 'a' && normalizedHref && isExternalUrl(normalizedHref, item.pageUrl)) {
      result.status = 'PASSED_EXTERNAL';
      result.openedUrl = normalizedHref;
      await locator.click({ timeout: CLICK_TIMEOUT_MS, button: 'left' }).catch(() => {});
      await page.waitForTimeout(1500);
      await page.screenshot({ path: afterScreenshot, fullPage: true });
      return result;
    }

    const downloadPromise = page.waitForEvent('download', { timeout: 10000 }).catch(() => null);
    const popupPromise = page.waitForEvent('popup', { timeout: 10000 }).catch(() => null);
    const navigationPromise = page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 12000 }).catch(() => null);

    try {
      await locator.click({ timeout: CLICK_TIMEOUT_MS, button: 'left' });
    } catch (clickError) {
      const fallbackDone = await fallbackNavigateByHref(page, item, result, afterScreenshot);
      if (fallbackDone) {
        result.errorMessage = `Click no ejecutado, se usó fallback por href. Error original: ${clickError.message}`;
        return result;
      }
      throw clickError;
    }

    const [download, popup] = await Promise.all([downloadPromise, popupPromise]);
    await navigationPromise;
    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(POST_ACTION_WAIT_MS);

    if (download) {
      const suggestedName = download.suggestedFilename();
      const downloadFile = path.join(DOWNLOAD_DIR, `${evidenceBaseName}_${safeFileName(suggestedName)}`);
      await download.saveAs(downloadFile);
      result.status = 'PASSED_DOWNLOAD';
      result.downloadedFile = downloadFile;
      result.openedUrl = page.url();
      await page.screenshot({ path: afterScreenshot, fullPage: true });
      return result;
    }

    if (popup) {
      await popup.waitForLoadState('domcontentloaded', { timeout: TIMEOUT_MS }).catch(() => {});
      await popup.waitForTimeout(1500);
      result.status = 'PASSED_POPUP';
      result.openedUrl = popup.url();
      await popup.screenshot({ path: afterScreenshot, fullPage: true }).catch(async () => page.screenshot({ path: afterScreenshot, fullPage: true }));
      await popup.close().catch(() => {});
      return result;
    }

    result.openedUrl = page.url();
    await page.screenshot({ path: afterScreenshot, fullPage: true });
    const visibleError = await getVisibleErrorText(page);
    if (visibleError) {
      result.status = 'FAILED_VISIBLE_ERROR';
      result.errorMessage = `Se detectó posible error visible en pantalla: ${visibleError}`;
      return result;
    }

    const routeChanged = normalizeUrlForKey(result.openedUrl, result.pageUrl) !== normalizeUrlForKey(urlBefore, result.pageUrl);
    if (routeChanged) {
      result.status = 'PASSED_NAVIGATION';
    } else if (String(result.actionKey || '').startsWith('nav|shell|') || String(result.actionKey || '').startsWith('nav|home-card|')) {
      result.status = 'FAILED_NO_NAVIGATION';
      result.errorMessage = 'La acción de navegación visual fue ejecutada, pero no cambió la URL/ruta. Revisar evidencia before/after.';
    } else {
      result.status = 'PASSED_CLICK';
    }

    return result;
  } catch (error) {
    result.status = String(error.message || '').toLowerCase().includes('timeout') ? 'FAILED_TIMEOUT' : 'FAILED_CLICK';
    result.errorMessage = error.message;
    await page.screenshot({ path: afterScreenshot, fullPage: true }).catch(() => {});
    return result;
  } finally {
    result.durationMs = Date.now() - startTime;
    await page.close().catch(() => {});
  }
}

(async () => {
  ensureDir(EVIDENCE_DIR); ensureDir(SCREENSHOT_DIR); ensureDir(DOWNLOAD_DIR); ensureDir(REPORT_DIR);
  if (!fs.existsSync(INPUT_FILE)) {
    console.error(`No existe el archivo de entrada: ${INPUT_FILE}`);
    process.exit(1);
  }

  const inventory = JSON.parse(fs.readFileSync(INPUT_FILE, 'utf8'));
  const candidateItems = inventory.filter(shouldExecute).filter(item => item.pageUrl);
  const skippedDestructiveItems = ALLOW_DESTRUCTIVE_ACTIONS ? [] : candidateItems.filter(isDestructiveAction);
  const executableItems = candidateItems.filter(item => !isDestructiveAction(item)).slice(0, MAX_ACTIONS);
  console.log(`Inventario total: ${inventory.length}`);
  console.log(`Acciones destructivas contabilizadas y omitidas: ${skippedDestructiveItems.length}`);
  console.log(`Elementos ejecutables: ${executableItems.length}`);
  console.log(`Máximo a ejecutar: ${MAX_ACTIONS === Number.MAX_SAFE_INTEGER ? 'all' : MAX_ACTIONS}`);

  const storageCandidates = [
    path.join(INPUT_DIR, 'auth-storage-state.json'),
    path.join(path.dirname(INPUT_DIR), 'auth-storage-state.json'),
    CONFIG.auth && CONFIG.auth.storageStateFile ? path.resolve(CONFIG.auth.storageStateFile) : '',
    CONFIG.auth && CONFIG.auth.storageStatePath ? path.resolve(path.dirname(CONFIG_FILE || '.'), CONFIG.auth.storageStatePath) : ''
  ].filter(Boolean);
  const storageState = storageCandidates.find(p => fs.existsSync(p));
  if (storageState) console.log(`Usando storageState: ${storageState}`);
  else console.warn('No se encontró auth-storage-state.json. Si la app requiere sesión, ejecute primero el crawl autenticado.');

  const browser = await chromium.launch({
    headless: HEADLESS,
    args: ['--ignore-certificate-errors', '--allow-running-insecure-content']
  });
  const contextOptions = {
    ignoreHTTPSErrors: true,
    acceptDownloads: true,
    viewport: { width: 1440, height: 1000 }
  };
  if (storageState) contextOptions.storageState = storageState;
  const context = await browser.newContext(contextOptions);
  const results = skippedDestructiveItems.map((item, index) => createSkippedResult(item, index + 1));
  let caseNumber = results.length + 1;
  for (const item of executableItems) {
    console.log(`Ejecutando ${caseNumber}/${executableItems.length}: ${cleanText(item.text) || item.selector || item.href}`);
    const result = await executeItem(context, item, caseNumber);
    results.push(result);
    console.log(`  ${result.status}`);
    caseNumber++;
  }

  const csvReport = path.join(REPORT_DIR, 'navigation-execution-results.csv');
  const jsonReport = path.join(REPORT_DIR, 'navigation-execution-results.json');
  writeCsv(csvReport, results);
  writeJson(jsonReport, results);

  const count = status => results.filter(x => x.status === status).length;
  const summary = {
    inputFile: INPUT_FILE,
    environment: ENVIRONMENT,
    maxActions: MAX_ACTIONS === Number.MAX_SAFE_INTEGER ? 'all' : MAX_ACTIONS,
    totalInventory: inventory.length,
    executed: results.filter(x => x.status !== 'SKIPPED_DESTRUCTIVE').length,
    reported: results.length,
    passedClick: count('PASSED_CLICK'),
    passedNavigation: count('PASSED_NAVIGATION'),
    passedDownload: count('PASSED_DOWNLOAD'),
    passedPopup: count('PASSED_POPUP'),
    passedExternal: count('PASSED_EXTERNAL'),
    passedNavigationFallback: count('PASSED_NAVIGATION_FALLBACK'),
    passedExternalFallback: count('PASSED_EXTERNAL_FALLBACK'),
    failedSelector: count('FAILED_SELECTOR'),
    failedClick: count('FAILED_CLICK'),
    failedTimeout: count('FAILED_TIMEOUT'),
    failedVisibleError: count('FAILED_VISIBLE_ERROR'),
    failedHrefFallback: count('FAILED_HREF_FALLBACK'),
    failedNoNavigation: count('FAILED_NO_NAVIGATION'),
    skippedDisabled: count('SKIPPED_DISABLED'),
    skippedDestructive: count('SKIPPED_DESTRUCTIVE')
  };
  writeJson(path.join(REPORT_DIR, 'navigation-execution-summary.json'), summary);
  console.log('\nFinalizado.');
  console.log(summary);
  console.log(`Reporte CSV: ${csvReport}`);
  console.log(`Reporte JSON: ${jsonReport}`);
  console.log(`Evidencias: ${SCREENSHOT_DIR}`);
  await browser.close();
})();
