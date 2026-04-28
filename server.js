const express = require('express');
const path    = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;

const API_TOKEN         = process.env.PIPEDRIVE_TOKEN;
const ORG               = process.env.PIPEDRIVE_ORG   || 'boardacademy';
const FILTER_ID         = process.env.FILTER_ID        || '1402112';
const PRODUCT_FIELD_KEY = process.env.PRODUCT_FIELD    || '8bdce76ba66f0fed0280918a4845190c92899ed5';

app.use(express.static(path.join(__dirname, 'public')));

const BASE = `https://${ORG}.pipedrive.com/api/v1`;

async function pipeGet(endpoint) {
  const sep = endpoint.includes('?') ? '&' : '?';
  const url  = `${BASE}${endpoint}${sep}api_token=${API_TOKEN}`;
  const res  = await fetch(url);
  if (!res.ok) throw new Error(`Pipedrive ${res.status} → ${endpoint}`);
  return res.json();
}

async function fetchAllDeals() {
  const all = [];
  let start  = 0;
  while (true) {
    const json = await pipeGet(`/deals?filter_id=${FILTER_ID}&status=all&limit=500&start=${start}`);
    (json.data || []).forEach(d => all.push(d));
    if (!json.additional_data?.pagination?.more_items_in_collection) break;
    start += 500;
  }
  return all;
}

async function getProductLabels() {
  try {
    const json  = await pipeGet('/dealFields');
    const field = (json.data || []).find(f => f.key === PRODUCT_FIELD_KEY);
    if (!field?.options) return {};
    return Object.fromEntries(field.options.map(o => [String(o.id), o.label]));
  } catch (e) { return {}; }
}

async function fetchPipelines() {
  try {
    const json = await pipeGet('/pipelines');
    return (json.data || []).map(p => ({ id: String(p.id), name: p.name }));
  } catch (e) { return []; }
}

app.get('/api/report', async (req, res) => {
  if (!API_TOKEN) {
    return res.status(500).json({ ok: false, error: 'PIPEDRIVE_TOKEN não configurado.' });
  }
  try {
    const [deals, productLabels, pipelines] = await Promise.all([
      fetchAllDeals(), getProductLabels(), fetchPipelines()
    ]);

    const data = { all: {} };

    const ensure = (container, ym) => {
      if (!container[ym]) container[ym] = {
        criados: 0, finalizados: 0, ganhos: 0,
        won: 0, revenue: 0, products: {}
      };
      return container[ym];
    };

    for (const deal of deals) {
      const pipeId = String(deal.pipeline_id || 'unknown');
      if (!data[pipeId]) data[pipeId] = {};

      // Por data de criação (funil / cohort)
      if (deal.add_time) {
        const ym    = deal.add_time.substring(0, 7);
        const allM  = ensure(data.all, ym);
        const pipeM = ensure(data[pipeId], ym);

        allM.criados++;  pipeM.criados++;

        if (deal.status === 'won' || deal.status === 'lost') {
          allM.finalizados++;  pipeM.finalizados++;
        }
        if (deal.status === 'won') {
          allM.ganhos++;  pipeM.ganhos++;
        }
      }

      // Por data de ganho (receita)
      if (deal.status === 'won' && deal.won_time) {
        const ym    = deal.won_time.substring(0, 7);
        const allM  = ensure(data.all, ym);
        const pipeM = ensure(data[pipeId], ym);
        const val   = parseFloat(deal.value || 0);

        allM.won++;  pipeM.won++;
        allM.revenue += val;  pipeM.revenue += val;

        const raw   = deal[PRODUCT_FIELD_KEY];
        let produto = 'Não informado';
        if (raw !== null && raw !== undefined && raw !== '') {
          produto = productLabels[String(raw)] || String(raw);
        }
        for (const m of [allM, pipeM]) {
          if (!m.products[produto]) m.products[produto] = { count: 0, revenue: 0 };
          m.products[produto].count++;
          m.products[produto].revenue += val;
        }
      }
    }

    const toArray = (obj) =>
      Object.keys(obj).sort().map(m => ({
        month:       m,
        criados:     obj[m].criados,
        finalizados: obj[m].finalizados,
        ganhos:      obj[m].ganhos,
        won:         obj[m].won,
        revenue:     obj[m].revenue,
        avgTicket:   obj[m].won > 0 ? obj[m].revenue / obj[m].won : 0,
        conversion:  obj[m].criados > 0 ? (obj[m].won / obj[m].criados) * 100 : 0,
        products:    obj[m].products,
      }));

    const byPipeline = {};
    for (const [id, months] of Object.entries(data)) {
      byPipeline[id] = toArray(months);
    }

    res.json({ ok: true, pipelines, byPipeline });
  } catch (e) {
    console.error('[/api/report]', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.listen(PORT, () => console.log(`✓ Porta ${PORT}`));
