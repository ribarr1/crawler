// Navega Auth Crawl v10 - Backoffice/microfrontend/iframe friendly
require('dotenv').config();
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const CONFIG_FILE = process.argv[5] || 'config.json';

function readConfig(filePath) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return {};
    console.log(`Leyendo configuración desde "${filePath}"`);
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    console.warn(`No fue posible leer config "${filePath}": ${error.message}`);
    return {};
  }
}

const CONFIG = readConfig(CONFIG_FILE);

const START_URL = process.argv[2] || CONFIG.startUrl || 'https://backoffice.qa.bmcbackoffice.com.co/';
const MAX_PAGES = Number(process.argv[3] || CONFIG.maxPages || 50);
const OUTPUT_DIR = process.argv[4] || CONFIG.outputDir || 'output-navigation';

const SAME_DOMAIN_ONLY = CONFIG.sameDomainOnly ?? true;
const HEADLESS = CONFIG.headless ?? true;
const TIMEOUT_MS = CONFIG.timeoutMs || 90000;
const POST_LOAD_WAIT_MS = CONFIG.postLoadWaitMs || 5000;
const CRAWL_FRAMES = CONFIG.crawlFrames ?? true;

function cleanText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function csvEscape(value) {
  const text = String(value ?? '');
  return `"${text.replace(/"/g, '""')}"`;
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function getEnvOrValue(envName, directValue) {
  if (envName && process.env[envName]) return process.env[envName];
  return directValue || '';
}

function splitSelectors(selector) {
  return String(selector || '').split(',').map(x => x.trim()).filter(Boolean);
}

function safeFileName(url, index) {
  let name = 'page';
  try {
    const u = new URL(url);
    name = `${u.pathname}${u.hash}`
      .replace(/^\/+|\/+$|^#+/g, '')
      .replace(/[^a-zA-Z0-9-_]+/g, '-')
      .replace(/-+/g, '-')
      .toLowerCase();
  } catch {
    name = String(url || 'page').replace(/[^a-zA-Z0-9-_]+/g, '-').toLowerCase();
  }

  if (!name) name = 'home';
  return `page-${String(index).padStart(3, '0')}-${name.substring(0, 80)}.csv`;
}

function normalizeUrl(rawUrl, baseUrl) {
  try {
    const url = new URL(rawUrl, baseUrl);
    url.hash = '';
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    return url.href;
  } catch {
    return null;
  }
}

function isInternalUrl(url, startUrl) {
  try {
    const current = new URL(url);
    const start = new URL(startUrl);
    return current.hostname === start.hostname;
  } catch {
    return false;
  }
}

function shouldCrawlUrl(url) {
  try {
    const u = new URL(url);
    const p = u.pathname.toLowerCase();

    if (p.startsWith('/sites/default/files/')) return false;
    if (p.includes('/logout')) return false;
    if (p.includes('/sign-out')) return false;
    if (p.includes('/auth/logout')) return false;

    const blockedExtensions = [
      '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.zip', '.rar',
      '.png', '.jpg', '.jpeg', '.webp', '.svg', '.gif', '.mp4', '.mp3'
    ];

    if (blockedExtensions.some(ext => p.endsWith(ext))) return false;
    return true;
  } catch {
    return false;
  }
}

function shouldInspectFrame(frameUrl) {
  const value = String(frameUrl || '').toLowerCase();
  if (!value) return false;
  if (value.startsWith('chrome-error://')) return false;
  if (value.startsWith('about:blank')) return false;
  if (value.startsWith('devtools://')) return false;
  return true;
}

function writeCsv(filePath, rows) {
  const header = [
    'pageIndex', 'pageUrl', 'frameIndex', 'frameUrl', 'index', 'category', 'tag',
    'type', 'text', 'href', 'role', 'id', 'className', 'ariaLabel', 'title',
    'dataTestId', 'name', 'selector', 'recommendedLocator', 'normalizedHref',
    'domPath', 'isActionable', 'actionKey'
  ];

  const csvRows = [
    header.join(','),
    ...rows.map(item => header.map(key => csvEscape(item[key])).join(','))
  ];

  fs.writeFileSync(filePath, csvRows.join('\n'), 'utf8');
}

function writeJson(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

async function debugEvidence(page, outputDir, label) {
  const debugDir = path.join(outputDir, 'debug-login');
  ensureDir(debugDir);

  const safeLabel = String(label || 'debug').replace(/[^a-zA-Z0-9_-]+/g, '_');
  const screenshotPath = path.join(debugDir, `${safeLabel}.png`);
  const htmlPath = path.join(debugDir, `${safeLabel}.html`);

  await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});
  const html = await page.content().catch(() => '');
  fs.writeFileSync(htmlPath, html, 'utf8');

  console.log(`Auth debug screenshot: ${screenshotPath}`);
  console.log(`Auth debug html: ${htmlPath}`);
}

async function inspectDom(page, outputDir, label) {
  const debugDir = path.join(outputDir, 'debug-login');
  ensureDir(debugDir);
  const snapshot = [];

  for (const frame of page.frames()) {
    if (!shouldInspectFrame(frame.url())) {
      snapshot.push({ frameUrl: frame.url(), url: frame.url(), title: '', skipped: true, reason: 'frame técnico/no inspeccionable', inputs: [], buttons: [], links: [] });
      continue;
    }

    const info = await frame.evaluate(() => {
      const inputs = Array.from(document.querySelectorAll('input')).map((el, index) => ({
        index: index + 1,
        id: el.id || '',
        name: el.getAttribute('name') || '',
        type: el.getAttribute('type') || '',
        formcontrolname: el.getAttribute('formcontrolname') || '',
        placeholder: el.getAttribute('placeholder') || '',
        outerHTML: el.outerHTML.substring(0, 500)
      }));

      const buttons = Array.from(document.querySelectorAll('button, input[type="submit"], input[type="button"]')).map((el, index) => ({
        index: index + 1,
        id: el.id || '',
        name: el.getAttribute('name') || '',
        type: el.getAttribute('type') || '',
        text: (el.innerText || el.textContent || el.getAttribute('value') || '').trim(),
        disabled: el.disabled === true || el.getAttribute('disabled') !== null,
        outerHTML: el.outerHTML.substring(0, 500)
      }));

      const links = Array.from(document.querySelectorAll('a[href]')).map((el, index) => ({
        index: index + 1,
        href: el.getAttribute('href') || '',
        text: (el.innerText || el.textContent || el.getAttribute('aria-label') || '').trim().substring(0, 200)
      }));

      return { url: window.location.href, title: document.title, inputs, buttons, links };
    }).catch(error => ({
      url: frame.url(),
      title: '',
      error: error.message,
      inputs: [],
      buttons: [],
      links: []
    }));

    snapshot.push({ frameUrl: frame.url(), ...info });
  }

  const filePath = path.join(debugDir, `${label}_dom_snapshot.json`);
  fs.writeFileSync(filePath, JSON.stringify(snapshot, null, 2), 'utf8');
  console.log(`DOM snapshot: ${filePath}`);
}

async function findLocatorInPageOrFrames(page, selector, label, timeoutMs) {
  const selectors = splitSelectors(selector);
  const deadline = Date.now() + timeoutMs;
  let lastError = null;

  while (Date.now() < deadline) {
    for (const frame of page.frames()) {
      if (!shouldInspectFrame(frame.url())) continue;
      for (const currentSelector of selectors) {
        try {
          const locator = frame.locator(currentSelector).first();
          const count = await locator.count().catch(() => 0);
          if (count <= 0) continue;

          const visible = await locator.isVisible({ timeout: 1000 }).catch(() => false);
          if (!visible) continue;

          return { locator, selector: currentSelector, frameUrl: frame.url() };
        } catch (error) {
          lastError = error;
        }
      }
    }
    await page.waitForTimeout(500);
  }

  throw new Error(`No fue posible encontrar ${label}. Selectores: ${selectors.join(' | ')}. URL actual: ${page.url()}. Error: ${lastError ? lastError.message : 'sin coincidencias'}`);
}

async function fillFirst(page, selector, value, label) {
  const found = await findLocatorInPageOrFrames(page, selector, label, Math.min(TIMEOUT_MS, 90000));

  await found.locator.click({ timeout: 10000 }).catch(() => {});
  await found.locator.fill('', { timeout: 10000 }).catch(() => {});
  await found.locator.type(String(value), { delay: 35, timeout: 30000 });

  await found.locator.evaluate(el => {
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new Event('blur', { bubbles: true }));
  }).catch(() => {});

  console.log(`Auth: ${label} diligenciado con selector: ${found.selector} | frame: ${found.frameUrl}`);
}

async function clickFirst(page, selector, label) {
  const found = await findLocatorInPageOrFrames(page, selector, label, Math.min(TIMEOUT_MS, 90000));

  // Angular puede tardar en habilitar el botón después de llenar usuario/clave.
  await found.locator.waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});

  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const disabled = await found.locator.evaluate(el =>
      el.disabled === true || el.getAttribute('disabled') !== null || el.getAttribute('aria-disabled') === 'true'
    ).catch(() => false);

    if (!disabled) break;
    await page.waitForTimeout(500);
  }

  try {
    await found.locator.click({ timeout: 15000 });
  } catch {
    await found.locator.evaluate(el => el.click());
  }

  console.log(`Auth: ${label} ejecutado con selector: ${found.selector} | frame: ${found.frameUrl}`);
}


async function clickOptionalInPageOrFrames(page, selector, label, timeoutMs = 8000) {
  if (!selector) return false;
  const selectors = splitSelectors(selector);
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    for (const frame of page.frames()) {
      if (!shouldInspectFrame(frame.url())) continue;
      for (const currentSelector of selectors) {
        try {
          const locator = frame.locator(currentSelector).first();
          const count = await locator.count().catch(() => 0);
          if (count <= 0) continue;

          const visible = await locator.isVisible({ timeout: 1000 }).catch(() => false);
          if (!visible) continue;

          const disabled = await locator.evaluate(el =>
            el.disabled === true ||
            el.getAttribute('disabled') !== null ||
            el.getAttribute('aria-disabled') === 'true'
          ).catch(() => false);

          if (disabled) continue;

          await locator.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
          await locator.click({ timeout: 5000 }).catch(async () => {
            await locator.evaluate(el => el.click()).catch(() => {});
          });

          console.log(`Post-login action: ${label} ejecutado con selector: ${currentSelector} | frame: ${frame.url()}`);
          return true;
        } catch {}
      }
    }
    await page.waitForTimeout(500);
  }

  console.warn(`Post-login action: no fue posible ejecutar ${label}. Selectores: ${selectors.join(' | ')}`);
  return false;
}

async function runPostLoginActions(page) {
  const actions = CONFIG.postLoginActions || CONFIG.auth?.postLoginActions || [];
  if (!Array.isArray(actions) || actions.length === 0) return;

  console.log(`Post-login actions configuradas: ${actions.length}`);

  for (const [index, action] of actions.entries()) {
    if (!action || action.enabled === false) continue;

    if (action.type === 'wait') {
      const ms = Number(action.waitMs || action.ms || 1000);
      console.log(`Post-login action ${index + 1}: wait ${ms}ms`);
      await page.waitForTimeout(ms);
      continue;
    }

    if (action.type === 'click') {
      await clickOptionalInPageOrFrames(
        page,
        action.selector,
        action.label || `click_${index + 1}`,
        Number(action.timeoutMs || 8000)
      );
      await page.waitForLoadState('networkidle', { timeout: TIMEOUT_MS }).catch(() => {});
      await page.waitForTimeout(Number(action.afterWaitMs || 1500));
    }
  }
}

async function performLoginIfNeeded(page, context) {
  const auth = CONFIG.auth || {};
  if (!auth.enabled) {
    console.log('Auth: deshabilitado. Se ejecuta crawl público.');
    return START_URL;
  }

  const loginUrl = auth.loginUrl || START_URL;
  const username = getEnvOrValue(auth.usernameEnv, auth.username);
  const password = getEnvOrValue(auth.passwordEnv, auth.password);

  if (!username || !password) {
    throw new Error(`Auth habilitado, pero faltan credenciales. Configure ${auth.usernameEnv || 'NAVEGA_USER'} y ${auth.passwordEnv || 'NAVEGA_PASSWORD'}.`);
  }

  const usernameSelector = auth.usernameSelector || '#username, input#username, input[name="username"], input[formcontrolname="username"], input[placeholder="Ingrese su usuario"], input[type="text"]';
  const passwordSelector = auth.passwordSelector || '#password, input#password, input[name="password"], input[formcontrolname="password"], input[type="password"]';
  const submitSelector = auth.submitSelector || '#btn-login, button#btn-login, button:has-text("INGRESAR"), button:has-text("Ingresar"), button.btnPrincipal';

  console.log(`Auth: accediendo a login ${loginUrl}`);

  await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: TIMEOUT_MS });
  await page.waitForLoadState('networkidle', { timeout: TIMEOUT_MS }).catch(() => {});
  await page.waitForTimeout(auth.preLoginWaitMs || 5000);

  console.log(`Auth: página login cargada. URL actual: ${page.url()}`);
  console.log(`Auth: título página: ${await page.title().catch(() => '')}`);

  if (auth.debugScreenshot) {
    await debugEvidence(page, OUTPUT_DIR, 'login_loaded');
    await inspectDom(page, OUTPUT_DIR, 'login_loaded');
  }

  await fillFirst(page, usernameSelector, username, 'usuario');
  await fillFirst(page, passwordSelector, password, 'contraseña');

  await Promise.all([
    page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: TIMEOUT_MS }).catch(() => null),
    clickFirst(page, submitSelector, 'botón de ingreso')
  ]);

  await page.waitForLoadState('networkidle', { timeout: TIMEOUT_MS }).catch(() => {});
  await page.waitForTimeout(auth.postLoginWaitMs || 7000);

  await runPostLoginActions(page);

  if (auth.debugScreenshot) {
    await debugEvidence(page, OUTPUT_DIR, 'after_login');
    await inspectDom(page, OUTPUT_DIR, 'after_login');
  }

  if (auth.successSelector) {
    await findLocatorInPageOrFrames(page, auth.successSelector, 'selector de éxito login', TIMEOUT_MS);
  }

  const storageStateFile = path.join(OUTPUT_DIR, auth.storageStateFile || 'auth-storage-state.json');
  await context.storageState({ path: storageStateFile });
  console.log(`Auth: login confirmado. Storage state guardado en ${storageStateFile}`);

  return auth.postLoginStartUrl || CONFIG.crawlStartUrl || page.url() || START_URL;
}

async function extractElementsFromFrame(frame, pageIndex, frameIndex, mainPageUrl) {
  if (!shouldInspectFrame(frame.url())) return [];

  return await frame.evaluate(({ pageIndex, frameIndex, mainPageUrl }) => {
    const selectors = [
      'a[href]', 'button', 'input[type="button"]', 'input[type="submit"]',
      'input[type="text"]', 'input[type="email"]', 'input[type="password"]',
      'input[type="number"]', 'input[type="search"]', 'textarea', 'select',
      '[role="button"]', '[role="link"]', '[role="menuitem"]', '[onclick]', '[data-testid]',
      '[routerLink]', '[routerlink]', '[ng-reflect-router-link]', '[mat-menu-item]',
      '[tabindex="0"]', '[class*="menu"]', '[class*="Menu"]', '[class*="nav"]', '[class*="Nav"]',
      // Home/dashboard visual tiles: deben inventariarse aunque no funcionen,
      // porque el execute captura evidencia antes/después y reporta no navegación.
      '[class*="card"]', '[class*="Card"]', '[class*="tile"]', '[class*="Tile"]',
      '[class*="box"]', '[class*="Box"]', '[class*="module"]', '[class*="Module"]',
      '[style*="background"]', '[title]', 'img[alt]',
      'a[aria-label]', 'button[aria-label]', 'input[aria-label]',
      'select[aria-label]', 'textarea[aria-label]'
    ];

    const nodes = Array.from(document.querySelectorAll(selectors.join(',')));

    function getCategory(el) {
      const tag = el.tagName.toLowerCase();
      if (tag === 'a' && el.getAttribute('href')) return 'link';
      if (el.getAttribute('routerLink') || el.getAttribute('routerlink') || el.getAttribute('ng-reflect-router-link')) return 'link';
      if (tag === 'button') return 'button';
      if (tag === 'input' || tag === 'textarea' || tag === 'select') return 'input';
      if (el.getAttribute('data-testid')) return 'data-testid';
      if (el.getAttribute('aria-label')) return 'aria-label';
      if (el.getAttribute('onclick')) return 'onclick';
      if ((el.getAttribute('role') || '').toLowerCase() === 'button') return 'button';
      if ((el.getAttribute('role') || '').toLowerCase() === 'link') return 'link';
      return 'other';
    }

    function cssEscapeValue(value) {
      return String(value || '').replace(/"/g, '\\"');
    }

    function isDrupalErrorElement(el, text, ariaLabel) {
      const full = `${text || ''} ${ariaLabel || ''}`.toLowerCase();
      return full.includes('mensaje de error') ||
        full.includes('invalid render array key') ||
        full.includes('drupal\\core\\render') ||
        full.includes('twig_render_template') ||
        full.includes('symfony\\component\\httpkernel');
    }

    function isCarouselNonActionable(el) {
      const tag = el.tagName.toLowerCase();
      const role = (el.getAttribute('role') || '').toLowerCase();
      const ariaLabel = el.getAttribute('aria-label') || '';
      const className = el.getAttribute('class') || '';
      return tag === 'div' && (role === 'group' || className.includes('swiper-slide') || /^\d+\s*\/\s*\d+$/.test(ariaLabel));
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

    function buildActionKey(data) {
      const pageKey = normalizeUrlForKey(data.pageUrl || mainPageUrl || window.location.href, window.location.href);
      const frameKey = normalizeUrlForKey(data.frameUrl || '', window.location.href);
      const hrefKey = normalizeUrlForKey(data.href, window.location.href);
      const textKey = normalizeKeyText(data.text);
      const selectorKey = normalizeKeyText(data.selector);
      const ariaKey = normalizeKeyText(data.ariaLabel);
      const testIdKey = normalizeKeyText(data.dataTestId);
      const classKey = normalizeKeyText(data.className);

      // Navegación lateral del shell: es global y no debe duplicarse por cada ruta Angular.
      if (classKey.includes('boxnavibutton') && textKey) {
        return ['nav', 'shell', textKey].join('|');
      }

      // Tarjetas visuales del home/dashboard: se conservan como acciones de negocio.
      // Si no navegan, el execute debe evidenciar FAILED_NO_NAVIGATION.
      if (pageKey.includes('/#/home') && textKey && (
        classKey.includes('card') || classKey.includes('tile') || classKey.includes('module') ||
        classKey.includes('box') || selectorKey.includes('background')
      )) {
        return ['nav', 'home-card', textKey.substring(0, 80)].join('|');
      }

      // Menús internos de microfrontends: se estabilizan por ruta funcional + texto.
      if (classKey.includes('dropdown-item') && textKey) {
        return ['nav', 'microfrontend', pageKey, textKey].join('|');
      }

      if (hrefKey) {
        return ['link', data.tag || '', hrefKey, textKey || ariaKey || testIdKey || selectorKey].join('|');
      }

      // Acciones con id son más estables que texto/selector genérico.
      if (data.id) {
        return ['action', pageKey, 'id', normalizeKeyText(data.id)].join('|');
      }

      return ['action', pageKey, data.category || '', data.tag || '', data.type || '', textKey || ariaKey || testIdKey || selectorKey || frameKey].join('|');
    }

    function isActionableElement(el) {
      const tag = el.tagName.toLowerCase();
      const type = (el.getAttribute('type') || '').toLowerCase();
      const role = (el.getAttribute('role') || '').toLowerCase();
      const href = el.getAttribute('href') || el.getAttribute('routerLink') || el.getAttribute('routerlink') || el.getAttribute('ng-reflect-router-link') || '';
      const onclick = el.getAttribute('onclick') || '';
      const className = el.getAttribute('class') || '';
      const routerLink = el.getAttribute('routerLink') || el.getAttribute('routerlink') || el.getAttribute('ng-reflect-router-link') || '';
      const disabled = el.disabled === true;
      const ariaDisabled = (el.getAttribute('aria-disabled') || '').toLowerCase() === 'true';

      if (disabled || ariaDisabled) return false;

      const text = el.innerText || el.textContent || el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('value') || '';
      const ariaLabel = el.getAttribute('aria-label') || '';
      const clean = String(text || '').replace(/\s+/g, ' ').trim().toLowerCase();
      const currentPath = window.location.pathname || '/';

      if (tag === 'a' && href === './' && !clean && currentPath !== '/') return false;
      if (isDrupalErrorElement(el, clean, ariaLabel)) return false;
      if (isCarouselNonActionable(el)) return false;
      if (['pasar al contenido principal', 'skip to main content', 'saltar al contenido principal'].includes(clean)) return false;
      if (href === '#' || href.startsWith('javascript:')) return false;
      if (clean === 'visibility') return false;
      if (clean === 'cerrar sesion' || clean === 'cerrar sesión' || clean === 'logout') return false;
      if (className.includes('btnCerrarSesion') || className.includes('btnNombreUsuario')) return false;
      const clsLower = className.toLowerCase();
      if (clsLower.includes('ham-nav') || clsLower.includes('toggle_menu')) return false;
      if (!clean && tag === 'button' && clsLower.includes('row')) return false;
      if (clsLower.includes('sidenav')) return false;
      if (clsLower.includes('dropdown-menu')) return false;
      if (clsLower.includes('superiornav')) return false;
      if (clean && clean.length > 160 && tag === 'div') return false;

      if (tag === 'a' && href) return true;
      if (routerLink) return true;
      if (tag === 'button') return true;
      if (tag === 'input' && ['button', 'submit'].includes(type)) return true;
      if (role === 'button' || role === 'link' || role === 'menuitem') return true;
      if (onclick) return true;
      if (el.getAttribute('data-testid')) return true;
      if (clean && (
        className.toLowerCase().includes('menu') ||
        className.toLowerCase().includes('nav') ||
        className.toLowerCase().includes('card') ||
        className.toLowerCase().includes('tile') ||
        className.toLowerCase().includes('module') ||
        className.toLowerCase().includes('box') ||
        (el.getAttribute('style') || '').toLowerCase().includes('background') ||
        el.getAttribute('tabindex') === '0'
      )) return true;
      return false;
    }

    function buildDomPath(element) {
      const parts = [];
      let current = element;
      while (current && current.nodeType === Node.ELEMENT_NODE && parts.length < 6) {
        let part = current.tagName.toLowerCase();
        if (current.id) {
          part += `#${current.id}`;
          parts.unshift(part);
          break;
        }
        const cls = (current.getAttribute('class') || '').split(/\s+/).filter(Boolean).slice(0, 2).join('.');
        if (cls) part += `.${cls}`;
        parts.unshift(part);
        current = current.parentElement;
      }
      return parts.join(' > ');
    }

    return nodes.map((el, index) => {
      const tag = el.tagName.toLowerCase();
      const text = el.innerText || el.textContent || el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('value') || '';
      const cleanVisibleText = String(text || '').replace(/\s+/g, ' ').trim();
      const href = el.getAttribute('href') || el.getAttribute('routerLink') || el.getAttribute('routerlink') || el.getAttribute('ng-reflect-router-link') || '';
      let normalizedHref = '';
      try { normalizedHref = href ? new URL(href, window.location.href).href : ''; } catch { normalizedHref = href; }

      const role = el.getAttribute('role') || '';
      const id = el.getAttribute('id') || '';
      const className = el.getAttribute('class') || '';
      const ariaLabel = el.getAttribute('aria-label') || '';
      const title = el.getAttribute('title') || '';
      const dataTestId = el.getAttribute('data-testid') || '';
      const name = el.getAttribute('name') || '';
      const type = el.getAttribute('type') || '';

      let selector = tag;
      const routerLinkValue = el.getAttribute('routerLink') || el.getAttribute('routerlink') || el.getAttribute('ng-reflect-router-link') || '';

      if (id) selector = `#${id}`;
      else if (dataTestId) selector = `[data-testid="${cssEscapeValue(dataTestId)}"]`;
      else if (routerLinkValue) selector = `[ng-reflect-router-link="${cssEscapeValue(routerLinkValue)}"]`;
      else if (ariaLabel) selector = `[aria-label="${cssEscapeValue(ariaLabel)}"]`;
      else if (name) selector = `${tag}[name="${cssEscapeValue(name)}"]`;
      else if (href) selector = `${tag}[href="${cssEscapeValue(href)}"]`;
      else if (className) {
        const classes = className.split(/\s+/).filter(Boolean);
        const firstClass = classes[0];
        const safeTextForSelector = cssEscapeValue(cleanVisibleText);

        if (classes.includes('boxNaviButton') && cleanVisibleText) {
          selector = `${tag}.boxNaviButton:has-text("${safeTextForSelector}")`;
        } else if (firstClass) {
          selector = `${tag}.${firstClass}`;
        }
      }

      let recommendedLocator = '';
      if (dataTestId) recommendedLocator = `page.getByTestId('${dataTestId.replace(/'/g, "\\'")}')`;
      else if (role && cleanVisibleText) recommendedLocator = `page.getByRole('${role}', { name: '${cleanVisibleText.replace(/'/g, "\\'")}' })`;
      else if (tag === 'button' && cleanVisibleText) recommendedLocator = `page.getByRole('button', { name: '${cleanVisibleText.replace(/'/g, "\\'")}' })`;
      else if (tag === 'a' && href) recommendedLocator = `page.locator('a[href="${href.replace(/"/g, '\\"')}"]').first()`;
      else if (tag === 'a' && cleanVisibleText) recommendedLocator = `page.getByRole('link', { name: '${cleanVisibleText.replace(/'/g, "\\'")}' })`;
      else if (ariaLabel) recommendedLocator = `page.getByLabel('${ariaLabel.replace(/'/g, "\\'")}')`;
      else if (className.split(/\s+/).filter(Boolean).includes('boxNaviButton') && cleanVisibleText) {
        recommendedLocator = `page.locator('div.boxNaviButton').filter({ hasText: '${cleanVisibleText.replace(/'/g, "\\'")}' }).first()`;
      } else recommendedLocator = `page.locator('${selector.replace(/'/g, "\\'")}')`;

      const category = getCategory(el);
      const actionKey = buildActionKey({
        pageUrl: mainPageUrl,
        category,
        tag,
        type,
        text: cleanVisibleText,
        href,
        selector,
        ariaLabel,
        dataTestId,
        className,
        id
      });

      return {
        pageIndex,
        pageUrl: mainPageUrl,
        frameIndex,
        frameUrl: window.location.href,
        index: index + 1,
        category,
        tag,
        type,
        text: cleanVisibleText,
        href,
        role,
        id,
        className,
        ariaLabel,
        title,
        dataTestId,
        name,
        selector,
        recommendedLocator,
        normalizedHref,
        domPath: buildDomPath(el),
        isActionable: isActionableElement(el),
        actionKey
      };
    });
  }, { pageIndex, frameIndex, mainPageUrl });
}

async function extractElements(page, pageIndex) {
  const frames = (CRAWL_FRAMES ? page.frames() : [page.mainFrame()]).filter(frame => shouldInspectFrame(frame.url()));
  const rows = [];
  let frameIndex = 0;

  for (const frame of frames) {
    frameIndex += 1;
    const frameRows = await extractElementsFromFrame(frame, pageIndex, frameIndex, page.url()).catch(error => {
      console.warn(`No se pudieron extraer elementos del frame ${frame.url()}: ${error.message}`);
      return [];
    });
    rows.push(...frameRows);
  }

  return rows;
}


async function collectMenuCandidates(page) {
  const cfg = CONFIG.menuClickDiscovery || {};
  const selector = cfg.selector || '.boxNaviButton, [class*="boxNaviButton"], [role="menuitem"], [routerLink], [routerlink], [ng-reflect-router-link]';
  const skipTexts = new Set((cfg.skipTexts || ['Cerrar sesión', 'Pruebas QA', 'visibility'])
    .map(x => cleanText(x).toLowerCase())
    .filter(Boolean));

  const candidates = [];

  for (const frame of page.frames()) {
    if (!shouldInspectFrame(frame.url())) continue;
    const rows = await frame.$$eval(selector, (nodes) => nodes.map((el, index) => {
      const text = String(el.innerText || el.textContent || el.getAttribute('aria-label') || el.getAttribute('title') || '').replace(/\s+/g, ' ').trim();
      const cls = el.getAttribute('class') || '';
      const id = el.getAttribute('id') || '';
      const routerLink = el.getAttribute('routerLink') || el.getAttribute('routerlink') || el.getAttribute('ng-reflect-router-link') || '';
      return { index, text, className: cls, id, routerLink };
    })).catch(() => []);

    for (const row of rows) {
      const text = cleanText(row.text);
      if (!text) continue;
      if (skipTexts.has(text.toLowerCase())) continue;
      if (String(row.className || '').toLowerCase().includes('sidenav')) continue;

      candidates.push({
        frameUrl: frame.url(),
        text,
        className: row.className || '',
        id: row.id || '',
        routerLink: row.routerLink || ''
      });
    }
  }

  const seen = new Set();
  return candidates.filter(item => {
    const key = `${item.frameUrl}|${item.text}|${item.routerLink}`.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function clickMenuCandidate(page, candidate) {
  const cfg = CONFIG.menuClickDiscovery || {};
  const selector = cfg.selector || '.boxNaviButton, [class*="boxNaviButton"], [role="menuitem"], [routerLink], [routerlink], [ng-reflect-router-link]';
  const timeoutMs = Number(cfg.clickTimeoutMs || 8000);

  for (const frame of page.frames()) {
    if (!shouldInspectFrame(frame.url())) continue;

    const locators = [];

    if (candidate.id) {
      locators.push(frame.locator(`#${candidate.id}`).first());
    }

    if (candidate.routerLink) {
      const safe = String(candidate.routerLink).replace(/"/g, '\\"');
      locators.push(frame.locator(`[ng-reflect-router-link="${safe}"]`).first());
      locators.push(frame.locator(`[routerLink="${safe}"]`).first());
      locators.push(frame.locator(`[routerlink="${safe}"]`).first());
    }

    locators.push(frame.locator(selector).filter({ hasText: candidate.text }).first());
    locators.push(frame.getByText(candidate.text, { exact: true }).first());
    locators.push(frame.getByText(candidate.text, { exact: false }).first());

    for (const locator of locators) {
      try {
        const count = await locator.count().catch(() => 0);
        if (count <= 0) continue;
        const visible = await locator.isVisible({ timeout: 1000 }).catch(() => false);
        if (!visible) continue;

        await locator.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
        await locator.click({ timeout: timeoutMs }).catch(async () => {
          await locator.evaluate(el => el.click()).catch(() => {});
        });
        return true;
      } catch {}
    }
  }

  return false;
}


async function clickFirstVisibleInFrames(page, selector, text, timeoutMs) {
  for (const frame of page.frames()) {
    if (!shouldInspectFrame(frame.url())) continue;

    const locators = [];
    if (text) {
      locators.push(frame.locator(selector).filter({ hasText: text }).first());
      locators.push(frame.getByRole('button', { name: text, exact: true }).first());
      locators.push(frame.getByText(text, { exact: true }).first());
      locators.push(frame.getByText(text, { exact: false }).first());
    } else {
      locators.push(frame.locator(selector).first());
    }

    for (const locator of locators) {
      try {
        const count = await locator.count().catch(() => 0);
        if (count <= 0) continue;
        const visible = await locator.isVisible({ timeout: 1000 }).catch(() => false);
        if (!visible) continue;
        await locator.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
        await locator.click({ timeout: timeoutMs }).catch(async () => {
          await locator.evaluate(el => el.click()).catch(() => {});
        });
        return true;
      } catch {}
    }
  }
  return false;
}

async function openLocalDropdownMenu(page) {
  const cfg = CONFIG.submenuClickDiscovery || {};
  const menuSelector = cfg.menuSelector || '#dropdownBasic1, button#dropdownBasic1, button.dropdown-toggle, button:has-text("Menú"), button:has-text("Menu")';
  const timeoutMs = Number(cfg.clickTimeoutMs || 8000);
  return await clickFirstVisibleInFrames(page, menuSelector, '', timeoutMs);
}

async function collectSubmenuCandidates(page) {
  const cfg = CONFIG.submenuClickDiscovery || {};
  const itemSelector = cfg.itemSelector || 'button.dropdown-item, .dropdown-item, [class*="dropdown-item"], [role="menuitem"]';
  const skipTexts = new Set((cfg.skipTexts || ['Cerrar sesión', 'Pruebas QA', 'visibility'])
    .map(x => cleanText(x).toLowerCase())
    .filter(Boolean));

  const candidates = [];

  for (const frame of page.frames()) {
    if (!shouldInspectFrame(frame.url())) continue;
    const rows = await frame.$$eval(itemSelector, (nodes) => nodes.map((el, index) => {
      const text = String(el.innerText || el.textContent || el.getAttribute('aria-label') || el.getAttribute('title') || '').replace(/\s+/g, ' ').trim();
      const cls = el.getAttribute('class') || '';
      const id = el.getAttribute('id') || '';
      return { index, text, className: cls, id };
    })).catch(() => []);

    for (const row of rows) {
      const text = cleanText(row.text);
      if (!text) continue;
      if (skipTexts.has(text.toLowerCase())) continue;
      candidates.push({
        frameUrl: frame.url(),
        text,
        className: row.className || '',
        id: row.id || ''
      });
    }
  }

  const seen = new Set();
  return candidates.filter(item => {
    const key = `${page.url()}|${item.text}`.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function discoverByClickingSubmenus(page, pageIndex) {
  const cfg = CONFIG.submenuClickDiscovery || {};
  const enabled = cfg.enabled ?? true;
  const result = { clicked: [], elements: [] };

  if (!enabled) return result;

  await openLocalDropdownMenu(page);
  await page.waitForTimeout(Number(cfg.beforeCollectWaitMs || 800));

  const candidates = (await collectSubmenuCandidates(page)).slice(0, Number(cfg.maxItems || 30));
  if (!candidates.length) return result;

  console.log(`Submenu click discovery: candidatos=${candidates.length}`);

  const itemSelector = cfg.itemSelector || 'button.dropdown-item, .dropdown-item, [class*="dropdown-item"], [role="menuitem"]';
  const timeoutMs = Number(cfg.clickTimeoutMs || 8000);

  for (const [idx, candidate] of candidates.entries()) {
    try {
      await openLocalDropdownMenu(page);
      await page.waitForTimeout(Number(cfg.beforeClickWaitMs || 500));

      const beforeUrl = page.url();
      const clicked = await clickFirstVisibleInFrames(page, itemSelector, candidate.text, timeoutMs);
      if (!clicked) {
        result.clicked.push({ ...candidate, status: 'NOT_CLICKED', beforeUrl, afterUrl: page.url() });
        continue;
      }

      await page.waitForLoadState('networkidle', { timeout: TIMEOUT_MS }).catch(() => {});
      await page.waitForTimeout(Number(cfg.afterClickWaitMs || 2200));

      const afterUrl = page.url();
      const subPageIndex = `${pageIndex}.sub${String(idx + 1).padStart(2, '0')}`;
      const elements = await extractElements(page, subPageIndex);
      result.elements.push(...elements);
      result.clicked.push({
        ...candidate,
        status: 'CLICKED',
        beforeUrl,
        afterUrl,
        elements: elements.length,
        actionable: elements.filter(x => x.isActionable).length
      });

      if (CONFIG.debugCrawlSnapshot) {
        await inspectDom(page, OUTPUT_DIR, `submenu_click_${String(idx + 1).padStart(3, '0')}_${safeFileName(candidate.text, 0).replace(/^page-000-/, '')}`);
      }

      console.log(`  Submenu click ${idx + 1}/${candidates.length}: ${candidate.text} | ${beforeUrl} => ${afterUrl} | Elementos=${elements.length}`);
    } catch (error) {
      result.clicked.push({ ...candidate, status: 'ERROR', error: error.message, afterUrl: page.url() });
      console.warn(`  Submenu click error: ${candidate.text} - ${error.message}`);
    }
  }

  return result;
}

async function discoverByClickingMenu(page, pageIndex) {
  const cfg = CONFIG.menuClickDiscovery || {};
  const enabled = cfg.enabled ?? true;
  const result = { clicked: [], elements: [], discoveredUrls: [] };

  if (!enabled) return result;

  const candidates = (await collectMenuCandidates(page)).slice(0, Number(cfg.maxItems || 40));
  console.log(`Menu click discovery: candidatos=${candidates.length}`);

  for (const [idx, candidate] of candidates.entries()) {
    try {
      await runPostLoginActions(page);
      await page.waitForTimeout(Number(cfg.beforeClickWaitMs || 800));

      const beforeUrl = page.url();
      const clicked = await clickMenuCandidate(page, candidate);
      if (!clicked) {
        result.clicked.push({ ...candidate, status: 'NOT_CLICKED', beforeUrl, afterUrl: page.url() });
        continue;
      }

      await page.waitForLoadState('networkidle', { timeout: TIMEOUT_MS }).catch(() => {});
      await page.waitForTimeout(Number(cfg.afterClickWaitMs || 2500));

      const afterUrl = page.url();
      const clickPageIndex = `${pageIndex}.${String(idx + 1).padStart(2, '0')}`;
      const elements = await extractElements(page, clickPageIndex);
      result.elements.push(...elements);

      const submenuDiscovery = await discoverByClickingSubmenus(page, clickPageIndex);
      result.elements.push(...submenuDiscovery.elements);

      result.clicked.push({
        ...candidate,
        status: 'CLICKED',
        beforeUrl,
        afterUrl,
        elements: elements.length,
        actionable: elements.filter(x => x.isActionable).length
      });

      if ((cfg.enqueueDiscoveredUrls ?? false) && afterUrl && afterUrl !== beforeUrl && shouldCrawlUrl(afterUrl)) {
        result.discoveredUrls.push(afterUrl);
      }

      if (CONFIG.debugCrawlSnapshot) {
        await inspectDom(page, OUTPUT_DIR, `menu_click_${String(idx + 1).padStart(3, '0')}_${safeFileName(candidate.text, 0).replace(/^page-000-/, '')}`);
      }

      console.log(`  Menu click ${idx + 1}/${candidates.length}: ${candidate.text} | ${beforeUrl} => ${afterUrl} | Elementos=${elements.length}`);
    } catch (error) {
      result.clicked.push({ ...candidate, status: 'ERROR', error: error.message, afterUrl: page.url() });
      console.warn(`  Menu click error: ${candidate.text} - ${error.message}`);
    }
  }

  return result;
}

async function extractLinks(page, currentUrl, startUrl) {
  const frames = (CRAWL_FRAMES ? page.frames() : [page.mainFrame()]).filter(frame => shouldInspectFrame(frame.url()));
  const normalized = [];

  for (const frame of frames) {
    const hrefs = await frame.$$eval('a[href]', anchors => anchors.map(a => a.getAttribute('href')).filter(Boolean)).catch(() => []);
    const frameUrl = frame.url() || currentUrl;

    for (const href of hrefs) {
      const url = normalizeUrl(href, frameUrl);
      if (!url) continue;
      if (!shouldCrawlUrl(url)) continue;
      if (SAME_DOMAIN_ONLY && !isInternalUrl(url, startUrl)) continue;
      normalized.push(url);
    }
  }

  return [...new Set(normalized)];
}

function uniqueByAction(rows) {
  const seen = new Set();
  return rows.filter(item => {
    const key = String(item.actionKey || [item.tag, item.type, item.text, item.normalizedHref || item.href, item.selector].join('|')).toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

(async () => {
  ensureDir(OUTPUT_DIR);
  ensureDir(path.join(OUTPUT_DIR, 'pages'));

  const browser = await chromium.launch({
    headless: HEADLESS,
    args: ['--ignore-certificate-errors', '--allow-running-insecure-content']
  });

  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 1440, height: 1000 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36'
  });

  const page = await context.newPage();
  const crawlStartUrl = await performLoginIfNeeded(page, context);

  const queue = [crawlStartUrl];
  const visited = new Set();
  const allElements = [];
  const failedPages = [];
  let pageIndex = 0;

  while (queue.length > 0 && visited.size < MAX_PAGES) {
    const currentUrl = queue.shift();
    if (!currentUrl || visited.has(currentUrl)) continue;

    visited.add(currentUrl);
    pageIndex += 1;
    console.log(`Visitando ${pageIndex}/${MAX_PAGES}: ${currentUrl}`);

    try {
      const alreadyOnPage = page.url() === currentUrl;

      if (!alreadyOnPage) {
        await page.goto(currentUrl, { waitUntil: 'domcontentloaded', timeout: TIMEOUT_MS }).catch(error => {
          console.warn(`Advertencia de navegación en ${currentUrl}: ${error.message}`);
        });
      }

      await page.waitForLoadState('networkidle', { timeout: TIMEOUT_MS }).catch(() => {});
      await page.waitForTimeout(POST_LOAD_WAIT_MS);

      if (CONFIG.debugCrawlSnapshot) {
        await inspectDom(page, OUTPUT_DIR, `crawl_page_${String(pageIndex).padStart(3, '0')}`);
      }

      const elements = await extractElements(page, pageIndex);
      allElements.push(...elements);

      const pageFile = path.join(OUTPUT_DIR, 'pages', safeFileName(currentUrl, pageIndex));
      writeCsv(pageFile, elements);

      console.log(`  Frames: ${page.frames().length} | Elementos: ${elements.length} | Accionables: ${elements.filter(x => x.isActionable).length}`);

      if (pageIndex === 1 || CONFIG.menuClickDiscovery?.runOnEveryPage) {
        const menuDiscovery = await discoverByClickingMenu(page, pageIndex);

        if (menuDiscovery.elements.length > 0) {
          allElements.push(...menuDiscovery.elements);
        }

        writeJson(path.join(OUTPUT_DIR, 'menu-click-discovery.json'), menuDiscovery.clicked);

        for (const discoveredUrl of menuDiscovery.discoveredUrls) {
          if (!visited.has(discoveredUrl) && !queue.includes(discoveredUrl)) queue.push(discoveredUrl);
        }
      }

      const allowGenericLinkQueue = CONFIG.enqueueLinks ?? (!CONFIG.auth?.enabled);
      if (allowGenericLinkQueue) {
        const links = await extractLinks(page, currentUrl, START_URL);
        for (const link of links) {
          if (!visited.has(link) && !queue.includes(link)) queue.push(link);
        }
      }
    } catch (error) {
      console.error(`Error visitando ${currentUrl}: ${error.message}`);
      failedPages.push({ url: currentUrl, error: error.message });
    }
  }

  const actionableElements = allElements.filter(x => x.isActionable);
  const actionableUniqueElements = uniqueByAction(actionableElements);

  writeCsv(path.join(OUTPUT_DIR, 'all-elements.csv'), allElements);
  writeJson(path.join(OUTPUT_DIR, 'all-elements.json'), allElements);
  writeCsv(path.join(OUTPUT_DIR, 'actionable-elements.csv'), actionableElements);
  writeJson(path.join(OUTPUT_DIR, 'actionable-elements.json'), actionableElements);
  writeCsv(path.join(OUTPUT_DIR, 'actionable-unique-elements.csv'), actionableUniqueElements);
  writeJson(path.join(OUTPUT_DIR, 'actionable-unique-elements.json'), actionableUniqueElements);

  writeCsv(path.join(OUTPUT_DIR, 'links.csv'), allElements.filter(x => x.category === 'link'));
  writeCsv(path.join(OUTPUT_DIR, 'buttons.csv'), allElements.filter(x => x.category === 'button'));
  writeCsv(path.join(OUTPUT_DIR, 'inputs.csv'), allElements.filter(x => x.category === 'input'));
  writeCsv(path.join(OUTPUT_DIR, 'onclick.csv'), allElements.filter(x => x.category === 'onclick'));
  writeCsv(path.join(OUTPUT_DIR, 'aria-label.csv'), allElements.filter(x => x.ariaLabel));
  writeCsv(path.join(OUTPUT_DIR, 'data-testid.csv'), allElements.filter(x => x.dataTestId));

  const routeSummaryMap = new Map();
  for (const item of allElements) {
    const route = (() => {
      try { return new URL(item.pageUrl).hash || new URL(item.pageUrl).pathname || item.pageUrl; }
      catch { return item.pageUrl || ''; }
    })();
    if (!routeSummaryMap.has(route)) {
      routeSummaryMap.set(route, { route, totalElements: 0, actionableElements: 0, buttons: 0, links: 0, inputs: 0, frames: new Set() });
    }
    const bucket = routeSummaryMap.get(route);
    bucket.totalElements += 1;
    if (item.isActionable) bucket.actionableElements += 1;
    if (item.category === 'button') bucket.buttons += 1;
    if (item.category === 'link') bucket.links += 1;
    if (item.category === 'input') bucket.inputs += 1;
    if (item.frameUrl) bucket.frames.add(item.frameUrl);
  }

  const routeSummary = Array.from(routeSummaryMap.values()).map(x => ({
    ...x,
    frames: Array.from(x.frames),
    frameCount: x.frames.size
  }));

  const crawlSummary = {
    startUrl: START_URL,
    crawlStartUrl,
    maxPages: MAX_PAGES,
    crawlFrames: CRAWL_FRAMES,
    visited: Array.from(visited),
    failedPages,
    totalElements: allElements.length,
    totalLinks: allElements.filter(x => x.category === 'link').length,
    totalButtons: allElements.filter(x => x.category === 'button').length,
    totalInputs: allElements.filter(x => x.category === 'input').length,
    totalActionableElements: actionableElements.length,
    totalActionableUniqueElements: actionableUniqueElements.length,
    routeSummary
  };

  writeJson(path.join(OUTPUT_DIR, 'pages-visited.json'), crawlSummary);
  writeJson(path.join(OUTPUT_DIR, 'crawl-summary.json'), crawlSummary);

  console.log('\nFinalizado.');
  console.log(`Páginas visitadas: ${visited.size}`);
  console.log(`Elementos encontrados: ${allElements.length}`);
  console.log(`Accionables únicos: ${actionableUniqueElements.length}`);
  console.log(`Salida: ${OUTPUT_DIR}`);

  await context.close().catch(() => {});
  await browser.close();
})();
