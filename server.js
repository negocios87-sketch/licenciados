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

// ── Sessions ────────────────────────────────────────────────
const SESSIONS = new Map();
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
setInterval(() => { const now=Date.now(); for(const[t,s]of SESSIONS) if(now>s.expiresAt) SESSIONS.delete(t); }, 15*60*1000);

// ── CSV parser ──────────────────────────────────────────────
async function fetchCSV(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`CSV ${res.status}`);
  const csv = await res.text();
  const lines = csv.trim().split('\n');
  if (lines.length < 2) return [];
  const headers = lines[0].replace(/^\uFEFF/,'').split(',').map(h=>h.trim().replace(/^"|"$/g,'').toLowerCase());
  return lines.slice(1).filter(l=>l.trim()).map(line=>{
    const vals=[]; let cur='',inQ=false;
    for(const ch of line){ if(ch==='"') inQ=!inQ; else if(ch===','&&!inQ){vals.push(cur.trim());cur='';}else cur+=ch; }
    vals.push(cur.trim());
    const obj={};
    headers.forEach((h,i)=>obj[h]=(vals[i]||'').replace(/^"|"$/g,'').trim());
    return obj;
  });
}

// ── Users cache ─────────────────────────────────────────────
let usersCache=null, usersCachedAt=0;
async function getUsers() {
  if(usersCache&&Date.now()-usersCachedAt<5*60*1000) return usersCache;
  const rows=await fetchCSV(USERS_CSV_URL);
  const keys=Object.keys(rows[0]||{});
  const findCol=(...t)=>keys.find(k=>t.some(x=>k.toLowerCase().includes(x)));
  const userCol=findCol('usuario','user','email','login','nome');
  const passCol=findCol('senha','password','pass','secret');
  if(!userCol||!passCol) throw new Error(`Colunas não encontradas: ${keys.join(', ')}`);
  usersCache=rows.map(r=>({user:r[userCol]?.toLowerCase().trim(),pass:r[passCol]?.trim()})).filter(u=>u.user&&u.pass);
  usersCachedAt=Date.now();
  return usersCache;
}

function requireAuth(req,res,next){
  const token=(req.headers['authorization']||'').replace('Bearer ','').trim();
  const s=SESSIONS.get(token);
  if(!s||Date.now()>s.expiresAt) return res.status(401).json({ok:false,error:'Não autorizado.'});
  req.user=s.user; next();
}

app.post('/api/login',async(req,res)=>{
  try{
    const{usuario,senha}=req.body;
    if(!usuario||!senha) return res.status(400).json({ok:false,error:'Preencha usuário e senha.'});
    const users=await getUsers();
    const match=users.find(u=>u.user===usuario.toLowerCase().trim()&&u.pass===senha.trim());
    if(!match) return res.status(401).json({ok:false,error:'Usuário ou senha incorretos.'});
    const token=crypto.randomUUID();
    SESSIONS.set(token,{user:match.user,expiresAt:Date.now()+SESSION_TTL_MS});
    res.json({ok:true,token,user:match.user});
  }catch(e){res.status(500).json({ok:false,error:e.message});}
});

app.post('/api/logout',(req,res)=>{
  const t=(req.headers['authorization']||'').replace('Bearer ','').trim();
  SESSIONS.delete(t); res.json({ok:true});
});

// ── Pipedrive ───────────────────────────────────────────────
const BASE=`https://${ORG}.pipedrive.com/api/v1`;
async function pipeGet(endpoint){
  const sep=endpoint.includes('?')?'&':'?';
  const res=await fetch(`${BASE}${endpoint}${sep}api_token=${API_TOKEN}`);
  if(!res.ok) throw new Error(`Pipedrive ${res.status} → ${endpoint}`);
  return res.json();
}

async function fetchAllDeals(){
  const all=[]; let start=0;
  while(true){
    const json=await pipeGet(`/deals?filter_id=${FILTER_ID}&status=all&limit=500&start=${start}`);
    (json.data||[]).forEach(d=>all.push(d));
    if(!json.additional_data?.pagination?.more_items_in_collection) break;
    start+=500;
  }
  return all;
}

async function getProductLabels(){
  try{
    const json=await pipeGet('/dealFields');
    const field=(json.data||[]).find(f=>f.key===PRODUCT_FIELD_KEY);
    if(!field?.options) return {};
    return Object.fromEntries(field.options.map(o=>[String(o.id),o.label]));
  }catch{return {};}
}

async function fetchPipelines(){
  try{
    const json=await pipeGet('/pipelines');
    return (json.data||[]).map(p=>({id:String(p.id),name:p.name}));
  }catch{return [];}
}

async function getLostReasons(){
  try{
    const json=await pipeGet('/lostReasons');
    return Object.fromEntries((json.data||[]).map(r=>[String(r.id),r.name]));
  }catch{return {};}
}

async function getStages(){
  try{
    const json=await pipeGet('/stages');
    return Object.fromEntries((json.data||[]).map(s=>[String(s.id),s.name]));
  }catch{return {};}
}

// ── Report ──────────────────────────────────────────────────
app.get('/api/report',requireAuth,async(req,res)=>{
  if(!API_TOKEN) return res.status(500).json({ok:false,error:'PIPEDRIVE_TOKEN não configurado.'});
  try{
    const [deals,productLabels,pipelines,meta,lostReasons,stages]=await Promise.all([
      fetchAllDeals(),getProductLabels(),fetchPipelines(),
      fetchCSV(META_CSV_URL).catch(()=>[]),
      getLostReasons(),getStages()
    ]);

    const data={};
    const ensure=(container,ym)=>{
      if(!container[ym]) container[ym]={criados:0,finalizados:0,ganhos:0,won:0,revenue:0,products:{},perdidos:0,lostReasons:{},lostStages:{}};
      return container[ym];
    };

    for(const deal of deals){
      if(parseFloat(deal.value||0)===0) continue;
      const pipeId=String(deal.pipeline_id||'unknown');
      if(!data[pipeId]) data[pipeId]={};

      // Criados (data de criação)
      if(deal.add_time){
        const ym=deal.add_time.substring(0,7);
        const m=ensure(data[pipeId],ym);
        m.criados++;
        if(deal.status==='won'||deal.status==='lost') m.finalizados++;
        if(deal.status==='won') m.ganhos++;
      }

      // Ganhos (data de ganho)
      if(deal.status==='won'&&deal.won_time){
        const ym=deal.won_time.substring(0,7);
        const m=ensure(data[pipeId],ym);
        const val=parseFloat(deal.value||0);
        m.won++; m.revenue+=val;
        const raw=deal[PRODUCT_FIELD_KEY];
        let produto='Não informado';
        if(raw!==null&&raw!==undefined&&raw!=='') produto=productLabels[String(raw)]||String(raw);
        if(!m.products[produto]) m.products[produto]={count:0,revenue:0};
        m.products[produto].count++; m.products[produto].revenue+=val;
      }

      // Perdidos (data de perda)
      if(deal.status==='lost'&&deal.lost_time){
        const ym=deal.lost_time.substring(0,7);
        const m=ensure(data[pipeId],ym);
        m.perdidos++;

        // Motivo de perda
        const reasonId=String(deal.lost_reason_id||'');
        const reason=reasonId&&lostReasons[reasonId]?lostReasons[reasonId]:'Não informado';
        if(!m.lostReasons[reason]) m.lostReasons[reason]=0;
        m.lostReasons[reason]++;

        // Etapa de perda (estágio atual quando perdeu)
        const stageId=String(deal.stage_id||'');
        const stage=stageId&&stages[stageId]?stages[stageId]:'Não informado';
        if(!m.lostStages[stage]) m.lostStages[stage]=0;
        m.lostStages[stage]++;
      }
    }

    const toArray=(obj)=>Object.keys(obj).sort().map(m=>({
      month:m,
      criados:obj[m].criados, finalizados:obj[m].finalizados, ganhos:obj[m].ganhos,
      won:obj[m].won, revenue:obj[m].revenue,
      avgTicket:obj[m].won>0?obj[m].revenue/obj[m].won:0,
      conversion:obj[m].criados>0?(obj[m].won/obj[m].criados)*100:0,
      products:obj[m].products,
      perdidos:obj[m].perdidos,
      lostReasons:obj[m].lostReasons,
      lostStages:obj[m].lostStages,
    }));

    const byPipeline={};
    for(const[id,months]of Object.entries(data)) byPipeline[id]=toArray(months);

    res.json({ok:true,pipelines,byPipeline,meta,lostReasons,stages});
  }catch(e){
    console.error('[/api/report]',e);
    res.status(500).json({ok:false,error:e.message});
  }
});

app.listen(PORT,()=>console.log(`✓ Porta ${PORT}`));
