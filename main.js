import { Actor } from 'apify';
import { PlaywrightCrawler, log } from 'crawlee';
import { createHash } from 'node:crypto';

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const productDan = String(input.productDan ?? '1445499');
const selectedMarkets = new Set(input.marketCodes ?? ['CZ', 'DE', 'AT', 'PL', 'SK', 'HU', 'SI', 'HR', 'RO', 'BG', 'RS', 'BA', 'IT', 'MK']);
const maxStoresPerSearch = input.maxStoresPerSearch ?? 60;
const maxOutputRows = input.maxOutputRows ?? 5000;

const MARKETS = [
  { code: 'CZ', base: 'https://www.dm.cz', cities: ['Praha', 'Brno', 'Ostrava', 'Plzeň', 'Liberec', 'Olomouc', 'České Budějovice', 'Hradec Králové'] },
  { code: 'DE', base: 'https://www.dm.de', cities: ['10115 Berlin', '20095 Hamburg', '80331 München', '50667 Köln', '60311 Frankfurt am Main', '70173 Stuttgart', '04109 Leipzig', '44135 Dortmund', '28195 Bremen', '90402 Nürnberg'] },
  { code: 'AT', base: 'https://www.dm.at', cities: ['Wien', 'Graz', 'Linz', 'Salzburg', 'Innsbruck'] },
  { code: 'PL', base: 'https://www.dm.pl', cities: ['Warszawa', 'Kraków', 'Wrocław', 'Poznań', 'Gdańsk', 'Łódź', 'Katowice', 'Szczecin', 'Lublin'] },
  { code: 'SK', base: 'https://www.mojadm.sk', cities: ['Bratislava', 'Košice', 'Žilina', 'Banská Bystrica', 'Nitra'] },
  { code: 'HU', base: 'https://www.dm.hu', cities: ['Budapest', 'Debrecen', 'Szeged', 'Pécs', 'Győr'] },
  { code: 'SI', base: 'https://www.dm.si', cities: ['Ljubljana', 'Maribor', 'Koper', 'Celje'] },
  { code: 'HR', base: 'https://www.dm.hr', cities: ['Zagreb', 'Split', 'Rijeka', 'Osijek', 'Zadar'] },
  { code: 'RO', base: 'https://www.dm.ro', cities: ['București', 'Cluj-Napoca', 'Timișoara', 'Iași', 'Brașov'] },
  { code: 'BG', base: 'https://www.dm-drogeriemarkt.bg', cities: ['София', 'Пловдив', 'Варна', 'Бургас'] },
  { code: 'RS', base: 'https://www.dm.rs', cities: ['Beograd', 'Novi Sad', 'Niš', 'Kragujevac'] },
  { code: 'BA', base: 'https://www.dm-drogeriemarkt.ba', cities: ['Sarajevo', 'Banja Luka', 'Mostar', 'Tuzla'] },
  { code: 'IT', base: 'https://www.dm-drogeriemarkt.it', cities: ['Milano', 'Roma', 'Torino', 'Bologna', 'Verona'] },
  { code: 'MK', base: 'https://www.dm.mk', cities: ['Скопје', 'Битола', 'Куманово'] },
].filter((market) => selectedMarkets.has(market.code));

const ORIGIN_HEADING = /vyroben|původ|pôvod|hergestellt|herkunft|miejsce pochodzenia|származ|proizved|podrijet|poreklo|origine|originei|произвед|потекло|произход/i;
const CANADA = /\b(?:kanada|kanadě|kanadzie|canada|canadá|канад[аеи])\b/i;
const AVAILABILITY_BUTTON = /dostupnost|verfügbarkeit|dostępność|dostupnosť|elérhetőség|disponibil|raspoloživ|razpoložljiv|наличност|достапност/i;
const COOKIE_REJECT = /zamítnout|odmítnout|ablehnen|odrzuć|odmietnuť|elutasít|rifiuta|respinge|odbij|zavrni|отказ|одбиј/i;
const clean = (value = '') => value.replace(/\s+/g, ' ').trim();
const idFor = (market, address) => createHash('sha1').update(`${productDan}|${market}|${address}`).digest('hex').slice(0, 16);

const discovered = new Map();
try {
  const searchRun = await Actor.call('apify/google-search-scraper', {
    queries: MARKETS.map((market) => `site:${new URL(market.base).hostname} ${productDan} dmBio`).join('\n'),
    countryCode: 'de',
    languageCode: 'en',
    maxPagesPerQuery: 1,
    resultsPerPage: 10,
    mobileResults: false,
  });
  const searchDataset = await Actor.openDataset(searchRun.defaultDatasetId);
  const { items } = await searchDataset.getData({ limit: 200 });
  for (const result of items.flatMap((item) => item.organicResults ?? [])) {
    if (!result.url || !result.url.includes(`/p/d/${productDan}/`)) continue;
    const host = new URL(result.url).hostname.replace(/^www\./, '');
    const market = MARKETS.find((item) => new URL(item.base).hostname.replace(/^www\./, '') === host);
    if (market && !discovered.has(market.code)) discovered.set(market.code, result.url);
  }
} catch (error) {
  log.warning(`Product discovery failed; direct dm URLs will be used: ${error.message}`);
}

const requests = MARKETS.map((market) => ({
  url: discovered.get(market.code) ?? `${market.base}/p/d/${productDan}`,
  uniqueKey: market.code,
  userData: { market },
}));

let outputRows = 0;
const crawler = new PlaywrightCrawler({
  maxConcurrency: 3,
  maxRequestRetries: 1,
  requestHandlerTimeoutSecs: 300,
  navigationTimeoutSecs: 60,
  async requestHandler({ request, page }) {
    const { market } = request.userData;
    await page.waitForLoadState('domcontentloaded');

    await page.waitForTimeout(1500);
    const cookieButtons = page.getByRole('button', { name: COOKIE_REJECT });
    if (await cookieButtons.count()) await cookieButtons.first().click({ force: true }).catch(() => {});
    await page.locator('#usercentrics-root').waitFor({ state: 'detached', timeout: 5000 }).catch(() => {});

    const pageText = clean(await page.locator('body').innerText());
    if (!pageText.includes(productDan)) return;

    const origin = await page.locator('[data-dmid$="-content"]').evaluateAll((items) => items.map((item) => ({
      heading: (item.getAttribute('data-dmid') ?? '').replace(/-content$/, ''),
      value: item.textContent?.replace(/\s+/g, ' ').trim() ?? '',
    })));
    const originEvidence = origin.find((item) => ORIGIN_HEADING.test(item.heading) && CANADA.test(item.value));
    if (!originEvidence) return;

    const title = clean(await page.locator('h1').first().innerText());
    const gtinMatch = pageText.match(/GTIN\s*:?\s*(\d{8,14})/i);
    const availabilityButton = page.locator('button[data-dmid="store-availability-checkAnother-link"]')
      .filter({ hasText: AVAILABILITY_BUTTON }).first();
    if (!(await availabilityButton.count())) return;
    await availabilityButton.click({ force: true });

    const dialog = page.locator('[role="dialog"]').last();
    await dialog.waitFor({ state: 'visible', timeout: 15000 });
    const searchInput = dialog.locator('[data-dmid="search-input"]').first();
    const collected = new Map();

    for (const cityQuery of market.cities) {
      if (outputRows + collected.size >= maxOutputRows) break;
      await searchInput.fill(cityQuery);
      await searchInput.press('Enter');
      await dialog.locator('[data-dmid="store-teaser"]').first().waitFor({ state: 'visible', timeout: 12000 }).catch(() => {});
      await page.waitForTimeout(800);

      const stores = await dialog.locator('[data-dmid="store-teaser"]').evaluateAll((cards, limit) => cards.slice(0, limit).map((card) => {
        const text = (selector) => card.querySelector(selector)?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
        const city = card.querySelector('[data-dmid="store-teaser-city"]');
        const postcode = city?.querySelector('span[aria-hidden="true"]')?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
        const cityName = Array.from(city?.childNodes ?? []).filter((node) => node.nodeType === 3).map((node) => node.textContent).join(' ').replace(/\s+/g, ' ').trim();
        const availability = text('[data-dmid="availability-hint-text-container"]');
        const quantityMatch = availability.match(/(\d+)/);
        const quantity = quantityMatch ? Number(quantityMatch[1]) : null;
        return {
          available: Boolean(card.querySelector('[data-dmid="store-available-icon"]')),
          quantity,
          availability,
          street: text('[data-dmid="store-teaser-street"]'),
          additional: text('[data-dmid="store-teaser-street-additional"]'),
          postcode,
          city: cityName,
        };
      }), maxStoresPerSearch);

      for (const store of stores) {
        if (!store.available || !store.street || !store.postcode) continue;
        const address = clean([store.street, store.additional, `${store.postcode} ${store.city}`, market.code].filter(Boolean).join(', '));
        if (collected.has(address)) continue;
        collected.set(address, { ...store, address, cityQuery });
      }

      const checkedAt = new Date();
      const expiresAt = new Date(checkedAt.getTime() + 7 * 24 * 60 * 60 * 1000);
      const rows = [...collected.values()]
        .filter((store) => !store.pushed)
        .slice(0, Math.max(0, maxOutputRows - outputRows))
        .map((store) => ({
          candidate_id: `DM-${market.code}-${idFor(market.code, store.address)}`,
          product_dan: productDan,
          gtin: gtinMatch?.[1] ?? null,
          title,
          merchant: 'dm',
          country_code: market.code,
          category_id: 'food_grocery',
          decision: 'PUBLIC_ELIGIBLE',
          public_eligible: true,
          origin_status: 'VERIFIED_MADE_IN_CANADA_CLAIM',
          origin_evidence: `${originEvidence.heading}: ${originEvidence.value}`,
          availability_status: 'IN_STOCK_AT_PHYSICAL_STORE',
          inventory_quantity: store.quantity,
          branch_address: store.address,
          product_url: request.loadedUrl ?? request.url,
          branch_evidence_url: request.loadedUrl ?? request.url,
          checked_at: checkedAt.toISOString(),
          inventory_expires_at: expiresAt.toISOString(),
          latitude: null,
          longitude: null,
          map_ready: false,
        }));

      if (rows.length) {
        await Actor.pushData(rows);
        for (const row of rows) collected.get(row.branch_address).pushed = true;
        outputRows += rows.length;
      }
    }
  },
  failedRequestHandler({ request }) {
    log.warning(`Skipped ${request.userData.market.code}: ${request.url}`);
  },
});

await crawler.run(requests);
await Actor.exit();
