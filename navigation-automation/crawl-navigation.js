const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const START_URL = process.argv[2] || 'https://backoffice.qa.bmcbackoffice.com.co/';
const MAX_PAGES = Number(process.argv[3] || 50);

const OUTPUT_DIR = process.argv[4] || 'output-navigation';

const SAME_DOMAIN_ONLY = true;

function cleanText(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
}

function csvEscape(value) {
  const text = String(value ?? '');
  return `"${text.replace(/"/g, '""')}"`;
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function safeFileName(url, index) {
  const u = new URL(url);
  let name = u.pathname
    .replace(/^\/+|\/+$/g, '')
    .replace(/[^a-zA-Z0-9-_]+/g, '-')
    .replace(/-+/g, '-')
    .toLowerCase();

  if (!name) name = 'home';

  return `page-${String(index).padStart(3, '0')}-${name}.csv`;
}

function normalizeUrl(rawUrl, baseUrl) {
  try {
    const url = new URL(rawUrl, baseUrl);

    url.hash = '';

    if (!['http:', 'https:'].includes(url.protocol)) {
      return null;
    }

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

function writeCsv(filePath, rows) {
  const header = [
    'pageIndex',
    'pageUrl',
    'index',
    'category',
    'tag',
    'type',
    'text',
    'href',
    'role',
    'id',
    'className',
    'ariaLabel',
    'title',
    'dataTestId',
    'name',
    'selector',
    'recommendedLocator',
    'normalizedHref',
    'domPath',
    'isActionable',
    'actionKey'
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

async function extractElements(page, pageIndex) {
  return await page.evaluate((pageIndex) => {
    const selectors = [
      'a[href]',
      'button',
      'input[type="button"]',
      'input[type="submit"]',
      'input[type="text"]',
      'input[type="email"]',
      'input[type="password"]',
      'input[type="number"]',
      'input[type="search"]',
      'textarea',
      'select',
      '[role="button"]',
      '[role="link"]',
      '[onclick]',
      '[data-testid]',
      'a[aria-label]',
      'button[aria-label]',
      'input[aria-label]',
      'select[aria-label]',
      'textarea[aria-label]'
    ];

    const nodes = Array.from(document.querySelectorAll(selectors.join(',')));

    function getCategory(el) {
      const tag = el.tagName.toLowerCase();

      if (tag === 'a' && el.getAttribute('href')) return 'link';
      if (tag === 'button') return 'button';
      if (tag === 'input' || tag === 'textarea' || tag === 'select') return 'input';
      if (el.getAttribute('data-testid')) return 'data-testid';
      if (el.getAttribute('aria-label')) return 'aria-label';
      if (el.getAttribute('onclick')) return 'onclick';
      if (el.getAttribute('role') === 'button') return 'button';
      if (el.getAttribute('role') === 'link') return 'link';

      return 'other';
    }

    function cssEscapeValue(value) {
      return String(value || '').replace(/"/g, '\\"');
    }

    function isDrupalErrorElement(el, text, ariaLabel) {
      const full = `${text || ''} ${ariaLabel || ''}`.toLowerCase();

      return (
        full.includes('mensaje de error') ||
        full.includes('invalid render array key') ||
        full.includes('drupal\\core\\render') ||
        full.includes('twig_render_template') ||
        full.includes('symfony\\component\\httpkernel')
      );
    }

    function isCarouselNonActionable(el) {
      const tag = el.tagName.toLowerCase();
      const role = (el.getAttribute('role') || '').toLowerCase();
      const ariaLabel = el.getAttribute('aria-label') || '';
      const className = el.getAttribute('class') || '';

      return (
        tag === 'div' &&
        (
          role === 'group' ||
          className.includes('swiper-slide') ||
          /^\d+\s*\/\s*\d+$/.test(ariaLabel)
        )
      );
    }

    function isActionableElement(el) {
      const tag = el.tagName.toLowerCase();
      const type = (el.getAttribute('type') || '').toLowerCase();
      const role = (el.getAttribute('role') || '').toLowerCase();
      const href = el.getAttribute('href') || '';
      const onclick = el.getAttribute('onclick') || '';

      const disabled = el.disabled === true;
      const ariaDisabled = (el.getAttribute('aria-disabled') || '').toLowerCase() === 'true';

      if (disabled || ariaDisabled) return false;

      const text =
        el.innerText ||
        el.textContent ||
        el.getAttribute('aria-label') ||
        el.getAttribute('title') ||
        el.getAttribute('value') ||
        '';
      const ariaLabel = el.getAttribute('aria-label') || '';

      const clean = String(text || '').replace(/\s+/g, ' ').trim().toLowerCase();

      const currentPath = window.location.pathname || '/';

      if (tag === 'a' && href === './' && !clean && currentPath !== '/') {
        return false;
      }

      if (isDrupalErrorElement(el, clean, ariaLabel)) return false;
      if (isCarouselNonActionable(el)) return false;

      if (clean === 'pasar al contenido principal') return false;
      if (clean === 'skip to main content') return false;
      if (clean === 'saltar al contenido principal') return false;

      if (href === '#') return false;
      if (href.startsWith('javascript:')) return false;

      if (tag === 'a' && href) return true;
      if (tag === 'button') return true;
      if (tag === 'input' && ['button', 'submit'].includes(type)) return true;
      if (role === 'button' || role === 'link') return true;
      if (onclick) return true;
      if (el.getAttribute('data-testid')) return true;

      return false;
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
      const pageKey = normalizeUrlForKey(data.pageUrl || window.location.href, window.location.href);
      const hrefKey = normalizeUrlForKey(data.href, window.location.href);
      const textKey = normalizeKeyText(data.text);
      const selectorKey = normalizeKeyText(data.selector);
      const ariaKey = normalizeKeyText(data.ariaLabel);
      const testIdKey = normalizeKeyText(data.dataTestId);

      if (hrefKey) {
        return [
          'link',
          data.tag || '',
          hrefKey,
          textKey || ariaKey || testIdKey || selectorKey
        ].join('|');
      }

      return [
        'action',
        pageKey,
        data.category || '',
        data.tag || '',
        data.type || '',
        textKey || ariaKey || testIdKey || selectorKey
      ].join('|');
    }

    return nodes.map((el, index) => {
      const tag = el.tagName.toLowerCase();

      const text =
        el.innerText ||
        el.textContent ||
        el.getAttribute('aria-label') ||
        el.getAttribute('title') ||
        el.getAttribute('value') ||
        '';

      const href = el.getAttribute('href') || '';

      let normalizedHref = '';
      try {
        normalizedHref = href ? new URL(href, window.location.href).href : '';
      } catch {
        normalizedHref = href;
      }

      function buildDomPath(element) {
        const parts = [];
        let current = element;

        while (current && current.nodeType === Node.ELEMENT_NODE && parts.length < 5) {
          let part = current.tagName.toLowerCase();

          if (current.id) {
            part += `#${current.id}`;
            parts.unshift(part);
            break;
          }

          const cls = (current.getAttribute('class') || '')
            .split(/\s+/)
            .filter(Boolean)
            .slice(0, 2)
            .join('.');

          if (cls) part += `.${cls}`;

          parts.unshift(part);
          current = current.parentElement;
        }

        return parts.join(' > ');
      }

      const role = el.getAttribute('role') || '';
      const id = el.getAttribute('id') || '';
      const className = el.getAttribute('class') || '';
      const ariaLabel = el.getAttribute('aria-label') || '';
      const title = el.getAttribute('title') || '';
      const dataTestId = el.getAttribute('data-testid') || '';
      const name = el.getAttribute('name') || '';
      const type = el.getAttribute('type') || '';

      let selector = tag;

      if (id) {
        selector = `#${id}`;
      } else if (dataTestId) {
        selector = `[data-testid="${cssEscapeValue(dataTestId)}"]`;
      } else if (ariaLabel) {
        selector = `[aria-label="${cssEscapeValue(ariaLabel)}"]`;
      } else if (name) {
        selector = `${tag}[name="${cssEscapeValue(name)}"]`;
      } else if (href) {
        selector = `${tag}[href="${cssEscapeValue(href)}"]`;
      } else if (className) {
        const firstClass = className.split(/\s+/).filter(Boolean)[0];
        if (firstClass) selector = `${tag}.${firstClass}`;
      }

      let recommendedLocator = '';

      const cleanVisibleText = String(text || '').replace(/\s+/g, ' ').trim();

      if (dataTestId) {
        recommendedLocator = `page.getByTestId('${dataTestId.replace(/'/g, "\\'")}')`;
      } else if (role && cleanVisibleText) {
        recommendedLocator = `page.getByRole('${role}', { name: '${cleanVisibleText.replace(/'/g, "\\'")}' })`;
      } else if (tag === 'button' && cleanVisibleText) {
        recommendedLocator = `page.getByRole('button', { name: '${cleanVisibleText.replace(/'/g, "\\'")}' })`;
      } else if (tag === 'a' && href) {
        recommendedLocator = `page.locator('a[href="${href.replace(/"/g, '\\"')}"]').first()`;
      } else if (tag === 'a' && cleanVisibleText) {
        recommendedLocator = `page.getByRole('link', { name: '${cleanVisibleText.replace(/'/g, "\\'")}' })`;
      } else if (ariaLabel) {
        recommendedLocator = `page.getByLabel('${ariaLabel.replace(/'/g, "\\'")}')`;
      } else {
        recommendedLocator = `page.locator('${selector.replace(/'/g, "\\'")}')`;
      }

      const category = getCategory(el);

      const actionKey = buildActionKey({
        pageUrl: window.location.href,
        category,
        tag,
        type,
        text: cleanVisibleText,
        href,
        selector,
        ariaLabel,
        dataTestId
      });

      return {
        pageIndex,
        pageUrl: window.location.href,
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
  }, pageIndex);
}

function shouldCrawlUrl(url) {
  try {
    const u = new URL(url);
    const path = u.pathname.toLowerCase();

    if (path.startsWith('/sites/default/files/')) return false;

    const blockedExtensions = [
      '.pdf', '.doc', '.docx', '.xls', '.xlsx',
      '.zip', '.rar', '.png', '.jpg', '.jpeg',
      '.webp', '.svg', '.gif', '.mp4', '.mp3'
    ];

    if (blockedExtensions.some(ext => path.endsWith(ext))) return false;

    return true;
  } catch {
    return false;
  }
}

async function extractLinks(page, currentUrl, startUrl) {
  const hrefs = await page.$$eval('a[href]', anchors =>
    anchors.map(a => a.getAttribute('href')).filter(Boolean)
  );

  const normalized = [];

  for (const href of hrefs) {
    const url = normalizeUrl(href, currentUrl);

    if (!url) continue;

    if (!shouldCrawlUrl(url)) continue;

    if (SAME_DOMAIN_ONLY && !isInternalUrl(url, startUrl)) {
      continue;
    }

    normalized.push(url);
  }

  return [...new Set(normalized)];
}

(async () => {
  ensureDir(OUTPUT_DIR);
  ensureDir(path.join(OUTPUT_DIR, 'pages'));

  const browser = await chromium.launch({
    headless: true,
    args: [
      '--ignore-certificate-errors',
      '--allow-running-insecure-content'
    ]
  });

  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: {
      width: 1440,
      height: 1000
    },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36'
  });

  const page = await context.newPage();

  const queue = [START_URL];
  const visited = new Set();
  const allElements = [];
  const failedPages = [];

  let pageIndex = 0;

  while (queue.length > 0 && visited.size < MAX_PAGES) {
    const currentUrl = queue.shift();

    if (!currentUrl || visited.has(currentUrl)) continue;

    visited.add(currentUrl);
    pageIndex++;

    console.log(`Visitando ${pageIndex}/${MAX_PAGES}: ${currentUrl}`);

    try {
        try {
            await page.goto(currentUrl, {
                waitUntil: 'domcontentloaded',
                timeout: 90000
            });
        } catch (navigationError) {
            console.warn(`Advertencia de navegación en ${currentUrl}: ${navigationError.message}`);
        }

        await page.waitForTimeout(3000);

        const elements = await extractElements(page, pageIndex);

        allElements.push(...elements);

        const pageFile = path.join(
            OUTPUT_DIR,
            'pages',
            safeFileName(currentUrl, pageIndex)
        );

      writeCsv(pageFile, elements);

      const links = await extractLinks(page, currentUrl, START_URL);

      for (const link of links) {
        if (!visited.has(link) && !queue.includes(link)) {
          queue.push(link);
        }
      }
    } catch (error) {
      console.error(`Error visitando ${currentUrl}: ${error.message}`);

      failedPages.push({
        url: currentUrl,
        error: error.message
      });
    }
  }

  function uniqueByAction(rows) {
    const seen = new Set();

    return rows.filter(item => {
      const key = String(
        item.actionKey ||
        [
          item.tag,
          item.type,
          item.text,
          item.normalizedHref || item.href,
          item.selector
        ].join('|')
      ).toLowerCase();

      if (seen.has(key)) return false;

      seen.add(key);
      return true;
    });
  }

  const actionableElements = allElements.filter(x => x.isActionable);

  const actionableUniqueElements = uniqueByAction(actionableElements);

  writeCsv(path.join(OUTPUT_DIR, 'all-elements.csv'), allElements);
  writeJson(path.join(OUTPUT_DIR, 'all-elements.json'), allElements);
  
  writeCsv(path.join(OUTPUT_DIR, 'actionable-elements.csv'), actionableElements);
  writeJson(path.join(OUTPUT_DIR, 'actionable-elements.json'), actionableElements);

  writeCsv(path.join(OUTPUT_DIR, 'actionable-unique-elements.csv'), actionableUniqueElements);
  writeJson(path.join(OUTPUT_DIR, 'actionable-unique-elements.json'), actionableUniqueElements);

  const links = allElements.filter(x => x.category === 'link');
  const buttons = allElements.filter(x => x.category === 'button');
  const inputs = allElements.filter(x => x.category === 'input');
  const onclick = allElements.filter(x => x.category === 'onclick');
  const ariaLabel = allElements.filter(x => x.ariaLabel);
  const dataTestId = allElements.filter(x => x.dataTestId);

  writeCsv(path.join(OUTPUT_DIR, 'links.csv'), links);
  writeCsv(path.join(OUTPUT_DIR, 'buttons.csv'), buttons);
  writeCsv(path.join(OUTPUT_DIR, 'inputs.csv'), inputs);
  writeCsv(path.join(OUTPUT_DIR, 'onclick.csv'), onclick);
  writeCsv(path.join(OUTPUT_DIR, 'aria-label.csv'), ariaLabel);
  writeCsv(path.join(OUTPUT_DIR, 'data-testid.csv'), dataTestId);

  writeJson(path.join(OUTPUT_DIR, 'pages-visited.json'), {
    startUrl: START_URL,
    maxPages: MAX_PAGES,
    visited: Array.from(visited),
    failedPages,
    totalElements: allElements.length,
    totalLinks: links.length,
    totalButtons: buttons.length,
    totalInputs: inputs.length,
    totalActionableElements: actionableElements.length,
    totalActionableUniqueElements: actionableUniqueElements.length,
  });

  console.log('\nFinalizado.');
  console.log(`Páginas visitadas: ${visited.size}`);
  console.log(`Elementos encontrados: ${allElements.length}`);
  console.log(`Links: ${links.length}`);
  console.log(`Buttons: ${buttons.length}`);
  console.log(`Inputs: ${inputs.length}`);
  console.log(`Salida: ${OUTPUT_DIR}`);

  await context.close().catch(() => {});
  await browser.close();

})();