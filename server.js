const express = require('express');
const path    = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;

const API_TOKEN         = process.env.PIPEDRIVE_TOKEN;
const ORG               = process.env.PIPEDRIVE_ORG   || 'boardacademy';
const FILTER_ID         = process.env.FILTER_ID        || '1402112';
const PRODUCT_FIELD_KEY = process.env.PRODUCT_FIELD    || '8bdce76ba66f0fed0280918a4845190c92899ed5';

app.use(express.static(path.join(__dirname, 'public')));

// ─── Pipedrive helpers ──────────────────────────────────────
const BASE = `https://${ORG}.pipedrive.com/api/v1`;

async function pipeGet(endpoint) {
  const sep = endpoint.includes('?') ? '&' : '?';
  const url = `${BASE}${endpoint}${sep}api_token=${API_TOKEN}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Pipedrive ${res.status} → ${endpoint}`);
  return res.json();
}

async function fetchAllDeals() {
  const all = [];
  let start = 0;
  const limit = 500;
  while (true) {
    const json = await pipeGet(
      `/deals?filter_id=${FILTER_ID}&status=all&limit=${limit}&start=${start}`
    );
    (json.data || []).forEach(d => all.push(d));
    if (!json.additional_data?.pagination?.more_items_in_collection) break;
    start += limit;
  }
  return all;
}

async function getProductLabels() {
  try {
    const json = await pipeGet('/dealFields');
    const field = (json.data || []).find(f => f.key === PRODUCT_FIELD_KEY);
    if (!field?.options) return {};
    return Object.fromEntries(field.options.map(o => [String(o.id), o.label]));
  } catch (e) {
    console.warn('[getProductLabels]', e.message);
    return {};
  }
}

// ─── Report endpoint ────────────────────────────────────────
app.get('/api/report', async (req, res) => {
  if (!API_TOKEN) {
    return res.status(500).json({ ok: false, error: 'PIPEDRIVE_TOKEN não configurado no Render.' });
  }
  try {
    const [deals, productLabels] = await Promise.all([fetchAllDeals(), getProductLabels()]);

    const byMonth = {};
    const ensure  = ym => {
      if (!byMonth[ym]) byMonth[ym] = { leads: 0, won: 0, revenue: 0, products: {} };
      return byMonth[ym];
    };

    for (const deal of deals) {
      // Leads criados (add_time)
      if (deal.add_time) {
        ensure(deal.add_time.substring(0, 7)).leads++;
      }

      // Deals ganhos
      if (deal.status === 'won' && deal.won_time) {
        const ym  = deal.won_time.substring(0, 7);
        const m   = ensure(ym);
        const val = parseFloat(deal.value || 0);
        m.won++;
        m.revenue += val;

        // Produto
        const raw = deal[PRODUCT_FIELD_KEY];
        let produto = 'Não informado';
        if (raw !== null && raw !== undefined && raw !== '') {
          produto = productLabels[String(raw)] || String(raw);
        }
        if (!m.products[produto]) m.products[produto] = { count: 0, revenue: 0 };
        m.products[produto].count++;
        m.products[produto].revenue += val;
      }
    }

    const data = Object.keys(byMonth)
      .sort()
      .map(m => ({
        month:      m,
        leads:      byMonth[m].leads,
        won:        byMonth[m].won,
        revenue:    byMonth[m].revenue,
        avgTicket:  byMonth[m].won > 0 ? byMonth[m].revenue / byMonth[m].won : 0,
        conversion: byMonth[m].leads > 0 ? (byMonth[m].won / byMonth[m].leads) * 100 : 0,
        products:   byMonth[m].products,
      }));

    res.json({ ok: true, data });
  } catch (e) {
    console.error('[/api/report]', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.listen(PORT, () => console.log(`✓ Servidor rodando na porta ${PORT}`));
