const express = require('express');
const crypto  = require('crypto');
const path    = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const API_TOKEN         = process.env.PIPEDRIVE_TOKEN;
const ORG               = process.env.PIPEDRIVE_ORG   || 'boardacademy';
const FILTER_ID         = process.env.FILTER_ID        || '1402112';
const PRODUCT_FIELD_KEY = process.env.PRODUCT_FIELD    || '8bdce76ba66f0fed0280918a4845190c92899ed5';
const META_CSV_URL      = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vSvwO3Ag2f2cbkVgR1pJZp6fANQcbualGKlAG50fmOljuEGKZ1gJBbSAjRdO3SomXUEVQOWnTvlfHRd/pub?gid=1105730510&single=true&output=csv';
const USERS_CSV_URL     = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vSvwO3Ag2f2cbkVgR1pJZp6fANQcbualGKlAG50fmOljuEGKZ1gJBbSAjRdO3SomXUEVQOWnTvlfHRd/pub?gid=160245570&single=true&output=csv';

// ── Usuários locais com restrições ──────────────────────────
// Esses usuários têm acesso restrito definido no código.
// Sobrepõem qualquer linha da planilha com mesmo nome de usuário.
const LOCAL_USERS = {
  'paulo lucio': {
    pass: 'sjc123',
    restricted: true,
    allowedPipelines: ['LIC-SJC'], // só vê pipelines cujo nome contém esses valores
    allowedTabs: ['relatorio'],    // só vê a aba relatório
  }
};

// ── Sessions ────────────────────────────────────────────────
const SESSIONS = new Map();
const SESSION_TTL = 8 * 60 * 60 * 1000;
setInterval(() => { const now = Date.now(); for (const [t, s] of SESSIONS) if (now > s.expiresAt) SESSIONS.delete(t); }, 15 * 60 * 1000);

// ── CSV parser ──────────────────────────────────────────────
async function fetchCSV(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`CSV ${res.status}`);
  const csv = await res.text();
  const lines = csv.trim().split('\n');
  if (lines.length < 2) return [];
  const sep = lines[0].includes('\t') ? '\t' : ',';
  const headers = lines[0].replace(/^\uFEFF/, '').split(sep).map(h => h.trim().replace(/^"|"$/g, '').toLowerCase());
  return lines.slice(1).filter(l => l.trim()).map(line => {
    let vals;
    if (sep === '\t') {
      vals = line.split('\t').map(v => v.trim().replace(/^"|"$/g, ''));
    } else {
      vals = []; let cur = '', inQ = false;
      for (const ch of line) { if (ch === '"') inQ = !inQ; else if (ch === ',' && !inQ) { vals.push(cur.trim()); cur = ''; } else cur += ch; }
      vals.push(cur.trim());
      vals = vals.map(v => v.replace(/^"|"$/g, ''));
    }
    const obj = {};
    headers.forEach((h, i) => obj[h] = (vals[i] || '').trim());
    return obj;
  });
}

// ── Users cache ─────────────────────────────────────────────
let usersCache = null, usersCachedAt = 0;
async function getUsers() {
  if (usersCache && Date.now() - usersCachedAt < 5 * 60 * 1000) return usersCache;
  const rows = await fetchCSV(USERS_CSV_URL);
  const keys = Object.keys(rows[0] || {});
  const findCol = (...t) => keys.find(k => t.some(x => k.toLowerCase().includes(x)));
  const userCol = findCol('usuario', 'user', 'email', 'login', 'nome');
  const passCol = findCol('senha', 'password', 'pass', 'secret');
  if (!userCol || !passCol) throw new Error(`Colunas não encontradas: ${keys.join(', ')}`);
  usersCache = rows.map(r => ({ user: r[userCol]?.toLowerCase().trim(), pass: r[passCol]?.trim() })).filter(u => u.user && u.pass);
  usersCachedAt = Date.now();
  return usersCache;
}

function requireAuth(req, res, next) {
  const token = (req.headers['authorization'] || '').replace('Bearer ', '').trim();
  const s = SESSIONS.get(token);
  if (!s || Date.now() > s.expiresAt) return res.status(401).json({ ok: false, error: 'Não autorizado.' });
  req.user = s.user;
  req.userMeta = s.userMeta || {};
  next();
}

app.post('/api/login', async (req, res) => {
  try {
    const { usuario, senha } = req.body;
    if (!usuario || !senha) return res.status(400).json({ ok: false, error: 'Preencha usuário e senha.' });

    const userKey = usuario.toLowerCase().trim();

    // Verifica usuários locais primeiro
    if (LOCAL_USERS[userKey]) {
      const lu = LOCAL_USERS[userKey];
      if (lu.pass !== senha.trim()) return res.status(401).json({ ok: false, error: 'Usuário ou senha incorretos.' });
      const token = crypto.randomUUID();
      SESSIONS.set(token, { user: userKey, userMeta: { restricted: lu.restricted, allowedPipelines: lu.allowedPipelines, allowedTabs: lu.allowedTabs }, expiresAt: Date.now() + SESSION_TTL });
      return res.json({ ok: true, token, user: userKey, userMeta: { restricted: lu.restricted, allowedPipelines: lu.allowedPipelines, allowedTabs: lu.allowedTabs } });
    }

    // Usuários da planilha (sem restrições)
    const users = await getUsers();
    const match = users.find(u => u.user === userKey && u.pass === senha.trim());
    if (!match) return res.status(401).json({ ok: false, error: 'Usuário ou senha incorretos.' });
    const token = crypto.randomUUID();
    SESSIONS.set(token, { user: match.user, userMeta: {}, expiresAt: Date.now() + SESSION_TTL });
    res.json({ ok: true, token, user: match.user, userMeta: {} });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.post('/api/logout', (req, res) => {
  const t = (req.headers['authorization'] || '').replace('Bearer ', '').trim();
  SESSIONS.delete(t); res.json({ ok: true });
});

// ── Pipedrive ───────────────────────────────────────────────
const BASE = `https://${ORG}.pipedrive.com/api/v1`;
async function pipeGet(endpoint) {
  const sep = endpoint.includes('?') ? '&' : '?';
  const res = await fetch(`${BASE}${endpoint}${sep}api_token=${API_TOKEN}`);
  if (!res.ok) throw new Error(`Pipedrive ${res.status} → ${endpoint}`);
  return res.json();
}

async function fetchAllDeals() {
  const all = []; let start = 0;
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
    const json = await pipeGet('/dealFields');
    const field = (json.data || []).find(f => f.key === PRODUCT_FIELD_KEY);
    if (!field?.options) return {};
    return Object.fromEntries(field.options.map(o => [String(o.id), o.label]));
  } catch { return {}; }
}

async function fetchPipelines() {
  try {
    const json = await pipeGet('/pipelines');
    return (json.data || []).map(p => ({ id: String(p.id), name: p.name }));
  } catch { return []; }
}

async function getStages() {
  try {
    const json = await pipeGet('/stages');
    return Object.fromEntries((json.data || []).map(s => [String(s.id), s.name]));
  } catch { return {}; }
}

// ── Report endpoint ─────────────────────────────────────────
app.get('/api/report', requireAuth, async (req, res) => {
  if (!API_TOKEN) return res.status(500).json({ ok: false, error: 'PIPEDRIVE_TOKEN não configurado.' });
  try {
    const [deals, productLabels, pipelines, meta, stages] = await Promise.all([
      fetchAllDeals(), getProductLabels(), fetchPipelines(),
      fetchCSV(META_CSV_URL).catch(() => []),
      getStages()
    ]);

    // Filtra pipelines permitidos para usuários restritos
    const userMeta = req.userMeta || {};
    const allowedPipelines = userMeta.allowedPipelines || null;

    const filteredPipelines = allowedPipelines
      ? pipelines.filter(p => allowedPipelines.some(a => p.name.toUpperCase().includes(a.toUpperCase())))
      : pipelines;

    const allowedPipelineIds = new Set(filteredPipelines.map(p => p.id));

    const data = {};
    const ensure = (container, ym) => {
      if (!container[ym]) container[ym] = {
        criados: 0, finalizados: 0, ganhos: 0,
        criadosAberto: 0, criadosGanho: 0, criadosPerdido: 0,
        won: 0, revenue: 0, products: {},
        perdidos: 0, lostReasons: {}, lostStages: {},
        closers: {}
      };
      return container[ym];
    };

    for (const deal of deals) {
      if (parseFloat(deal.value || 0) === 0) continue;
      const pipeId = String(deal.pipeline_id || 'unknown');

      // Restrição de pipeline por usuário
      if (allowedPipelines && !allowedPipelineIds.has(pipeId)) continue;

      if (!data[pipeId]) data[pipeId] = {};

      const closerName = deal.user_id?.name || 'Não informado';

      // Por data de criação
      if (deal.add_time) {
        const ym = deal.add_time.substring(0, 7);
        const m = ensure(data[pipeId], ym);
        m.criados++;
        if (deal.status === 'won' || deal.status === 'lost') m.finalizados++;
        if (deal.status === 'won') m.ganhos++;
        if (deal.status === 'open')   m.criadosAberto++;
        if (deal.status === 'won')    m.criadosGanho++;
        if (deal.status === 'lost')   m.criadosPerdido++;

        // Closers — por data de criação
        if (!m.closers[closerName]) m.closers[closerName] = { criados: 0, won: 0, revenue: 0, perdidos: 0, lostReasons: {} };
        m.closers[closerName].criados++;
        if (deal.status === 'lost') m.closers[closerName].perdidos++;
      }

      // Por data de ganho
      if (deal.status === 'won' && deal.won_time) {
        const ym = deal.won_time.substring(0, 7);
        const m = ensure(data[pipeId], ym);
        const val = parseFloat(deal.value || 0);
        m.won++; m.revenue += val;

        const raw = deal[PRODUCT_FIELD_KEY];
        let produto = 'Não informado';
        if (raw !== null && raw !== undefined && raw !== '') produto = productLabels[String(raw)] || String(raw);
        if (!m.products[produto]) m.products[produto] = { count: 0, revenue: 0 };
        m.products[produto].count++; m.products[produto].revenue += val;

        // Closers — receita por data de ganho
        const cymKey = deal.won_time.substring(0, 7);
        const cm = ensure(data[pipeId], cymKey);
        if (!cm.closers[closerName]) cm.closers[closerName] = { criados: 0, won: 0, revenue: 0, perdidos: 0, lostReasons: {} };
        cm.closers[closerName].won++;
        cm.closers[closerName].revenue += val;
      }

      // Por data de perda
      if (deal.status === 'lost' && deal.lost_time) {
        const ym = deal.lost_time.substring(0, 7);
        const m = ensure(data[pipeId], ym);
        m.perdidos++;
        const reason = (deal.lost_reason && deal.lost_reason.trim()) ? deal.lost_reason.trim() : 'Não informado';
        if (!m.lostReasons[reason]) m.lostReasons[reason] = 0;
        m.lostReasons[reason]++;
        const stageId = String(deal.stage_id || '');
        const stage = (stageId && stages[stageId]) ? stages[stageId] : 'Não informado';
        if (!m.lostStages[stage]) m.lostStages[stage] = 0;
        m.lostStages[stage]++;

        // Closer × motivo — dado real, deal a deal
        if (!m.closers[closerName]) m.closers[closerName] = { criados: 0, won: 0, revenue: 0, perdidos: 0, lostReasons: {} };
        m.closers[closerName].perdidos++;
        if (!m.closers[closerName].lostReasons[reason]) m.closers[closerName].lostReasons[reason] = 0;
        m.closers[closerName].lostReasons[reason]++;
      }
    }

    const toArray = (obj) => Object.keys(obj).sort().map(m => ({
      month:          m,
      criados:        obj[m].criados,
      finalizados:    obj[m].finalizados,
      ganhos:         obj[m].ganhos,
      criadosAberto:  obj[m].criadosAberto,
      criadosGanho:   obj[m].criadosGanho,
      criadosPerdido: obj[m].criadosPerdido,
      won:            obj[m].won,
      revenue:        obj[m].revenue,
      avgTicket:      obj[m].won > 0 ? obj[m].revenue / obj[m].won : 0,
      conversion:     obj[m].criados > 0 ? (obj[m].won / obj[m].criados) * 100 : 0,
      products:       obj[m].products,
      perdidos:       obj[m].perdidos,
      lostReasons:    obj[m].lostReasons,
      lostStages:     obj[m].lostStages,
      closers:        obj[m].closers,
    }));

    const byPipeline = {};
    for (const [id, months] of Object.entries(data)) byPipeline[id] = toArray(months);

    res.json({
      ok: true,
      pipelines: filteredPipelines,
      byPipeline,
      meta,
      userMeta: { restricted: userMeta.restricted || false, allowedTabs: userMeta.allowedTabs || null }
    });
  } catch (e) {
    console.error('[/api/report]', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.listen(PORT, () => console.log(`✓ Porta ${PORT}`));
