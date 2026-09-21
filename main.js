import { Actor } from 'apify';

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const productDan = String(input.productDan ?? '1445499');
const maxOutputRows = Math.max(1, Number(input.maxOutputRows ?? 300));
const requestedMarkets = input.marketCodes ?? ['DE'];

if (!requestedMarkets.includes('DE')) {
    console.log('This pilot currently supports DE only.');
    await Actor.exit();
}

const productUrl = `https://www.dm.de/p/d/${productDan}/dmbio-ahornsirup-grad-a`;
const storeApi = 'https://store-data-service.services.dmtech.com/stores/bbox';
const availabilityApi = 'https://products.dm.de/availability/api/v2/tiles';

const areas = [
    [52.65, 13.05, 52.30, 13.80],
    [53.75, 9.65, 53.35, 10.35],
    [48.35, 11.25, 47.90, 11.95],
    [51.20, 6.50, 50.70, 7.35],
    [50.35, 8.25, 49.85, 9.10],
    [48.95, 8.75, 48.55, 9.45],
    [51.55, 12.10, 51.15, 12.70],
    [51.75, 6.80, 51.25, 7.85],
    [53.30, 8.45, 52.85, 9.20],
    [49.70, 10.75, 49.25, 11.35],
];

async function getDmVersion() {
    try {
        const response = await fetch('https://www.dm.de/scripts/head.js');
        const source = await response.text();
        return source.match(/composerVersion\s*:\s*["']([^"']+)/)?.[1]
            ?? source.match(/"composerVersion"\s*:\s*"([^"]+)/)?.[1]
            ?? '2026.921.78094-1';
    } catch {
        return '2026.921.78094-1';
    }
}

async function getJson(url, headers = {}) {
    const response = await fetch(url, {
        headers: {
            accept: 'application/json',
            'user-agent': 'Mozilla/5.0 CanadaNearMe/0.6',
            ...headers,
        },
    });
    if (!response.ok) throw new Error(`${response.status} ${url}`);
    return response.json();
}

const dmVersion = await getDmVersion();
const storesById = new Map();

for (const box of areas) {
    try {
        const data = await getJson(`${storeApi}/${box.join(',')}`);
        for (const store of data.stores ?? data.content ?? []) {
            if (store.storeId) storesById.set(store.storeId, store);
        }
    } catch (error) {
        console.log(`Store area skipped: ${error.message}`);
    }
}

const stores = [...storesById.values()].slice(0, maxOutputRows);
let found = 0;

async function checkStore(store) {
    const url = `${availabilityApi}/DE/${productDan}?pickupStoreId=${encodeURIComponent(store.storeId)}`;
    try {
        const data = await getJson(url, { 'x-dm-version': dmVersion });
        const product = data[productDan];
        const row = product?.rows?.find((item) => /dm-Markt/i.test(item.text ?? ''));
        const quantity = Number((row?.text ?? '').match(/\((\d+)\)/)?.[1] ?? 0);
        if (!row || row.icon !== 'GREEN' || quantity < 1) return null;

        const address = store.address ?? {};
        const location = store.location ?? {};
        const checkedAt = new Date();
        const expiresAt = new Date(checkedAt.getTime() + 7 * 24 * 60 * 60 * 1000);

        return {
            candidate_id: `dm-de-${productDan}-${store.storeId}`,
            product_id: productDan,
            product_name: 'dmBio Ahornsirup Grad A, 250 ml',
            brand: 'dmBio',
            category: 'Food & Grocery',
            made_in_country: 'CA',
            origin_evidence_text: 'Hergestellt in: Kanada',
            origin_evidence_url: productUrl,
            retailer: 'dm-drogerie markt',
            store_id: store.storeId,
            store_number: store.storeNumber ?? null,
            store_name: `dm ${address.city ?? ''}`.trim(),
            address: [address.street, address.streetAdditional].filter(Boolean).join(' '),
            postal_code: address.zip ?? null,
            city: address.city ?? null,
            country_code: 'DE',
            latitude: location.lat ?? null,
            longitude: location.lon ?? null,
            availability_status: 'in_stock',
            availability_quantity: quantity,
            availability_evidence_text: row.text,
            availability_evidence_url: url,
            product_url: productUrl,
            physical_store_only: true,
            map_ready: Boolean(location.lat && location.lon),
            checked_at: checkedAt.toISOString(),
            expires_at: expiresAt.toISOString(),
        };
    } catch (error) {
        console.log(`Store ${store.storeId} skipped: ${error.message}`);
        return null;
    }
}

for (let index = 0; index < stores.length; index += 8) {
    const batch = stores.slice(index, index + 8);
    const rows = (await Promise.all(batch.map(checkStore))).filter(Boolean);
    if (rows.length) {
        await Actor.pushData(rows);
        found += rows.length;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
}

console.log(`Checked ${stores.length} stores; available in ${found}.`);
await Actor.exit();
