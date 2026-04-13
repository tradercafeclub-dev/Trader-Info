// ═══════════════════════════════════════════════════════════════
//  TCC CONFIG — Shared between index.html and admin.html
//  แก้ไขที่ไฟล์นี้ไฟล์เดียว มีผลทั้งสองหน้าทันที
//  Deploy: วางไฟล์นี้ใน root เดียวกับ index.html และ admin.html
// ═══════════════════════════════════════════════════════════════

// ── API Endpoint + Keys ───────────────────────────────────────
const WORKER_URL = 'https://tradercafeclub.tradercafeclub.workers.dev';
const SYSTEM_WALLET_DEFAULT = { label:'กระเป๋าหลัก', addr:'0xfd1A5bc82603a702a9AF38426FfAC0d6BE5aEeef', qr:'https://i.ibb.co/d0T7YJfy/line-oa-chat-260203-125428.jpg', active:true };
const LS_ADMINS  = 'tcc_admins';
const LS_WALLETS = 'tcc_wallets';
const LS_SESSION = 'tcc_session';

// ══════════════════════════════════════════════════════

// ── NocoDB Config ─────────────────────────────────────────────
const NOCO = {
  base: '', token: '', proj: '',
  tbl:{
    teams:        'teams',
    members:      'members',
    payments:     'payments',
    claimlp:      localStorage.getItem('tcc_claimlp_id')    || 'claimlp',
    claim10:      localStorage.getItem('tcc_claim10_id')     || 'claim10',
    items:        'items',
    cafe:         'cafecards',
    cafeshops:    localStorage.getItem('tcc_cafeshops_id')   || 'cafeshops',
    pagecontent:  localStorage.getItem('tcc_pagecontent_id') || 'pagecontent',
    applications: 'applications'   // ← ไม่ใช่ NocoDB ID แล้ว
  }
};

// ─────────────────────────────────────────────────────────────────
//  CLIENT CACHE v2.4 — Stale-While-Revalidate
//  FRESH  (0-90s)  : คืนทันที ไม่เรียก Worker เลย
//  STALE  (90s-5m) : คืนข้อมูลเก่าทันที + fetch ใหม่ background
//  EXPIRED (>5m)   : fetch ใหม่แบบ blocking (รอผล)
//  ลด Worker calls ~70% เพิ่มเติมจาก Worker cache อีกชั้น
// ─────────────────────────────────────────────────────────────────

// ── Utility ───────────────────────────────────────────────────
const sleep=ms=>new Promise(r=>setTimeout(r,ms));


// ── Cache + API Layer ─────────────────────────────────────────
const _cache={};
const _FRESH_TTL  = 90_000;   // 90 วินาที — คืนทันที
const _STALE_TTL  = 300_000;  // 5 นาที   — ใช้ stale + revalidate bg
const _BG_PENDING = new Set(); // ป้องกัน bg fetch ซ้ำซ้อน

function _cachePut(key,list){ _cache[key]={ data:list, ts:Date.now() }; }
function _cacheAge(key){ const c=_cache[key]; return c ? Date.now()-c.ts : Infinity; }
function _cacheBust(tid){ for(const k of Object.keys(_cache)) if(k.startsWith(tid)) delete _cache[k]; }

async function _nocoFetch(url, retries=3, delay=1200){
  while(retries-->0){
    try{
      const ctrl=new AbortController();
      const timer=setTimeout(()=>ctrl.abort(),15000);
      const r=await fetch(url,{signal:ctrl.signal});
      clearTimeout(timer);
      if(r.status===429){ await sleep(delay); delay*=2; continue; }
      if(!r.ok) throw new Error('HTTP '+r.status);
      const d=await r.json();
      return d.list||d.data||[];
    }catch(e){
      if(e.name==='AbortError'){ if(retries<=0) throw new Error('Connection timeout'); }
      else if(retries<=0) throw e;
      await sleep(delay); delay*=1.5;
    }
  }
  throw new Error('ไม่สามารถโหลดข้อมูลได้');
}

async function nocoGet(tid,params=''){
  const key=tid+params;
  const url=`${WORKER_URL}/api/noco/${tid}?limit=500${params}`;
  const age=_cacheAge(key);

  // FRESH — คืนทันที ✅ (0 network calls)
  if(age < _FRESH_TTL) return _cache[key].data;

  // STALE — คืนเก่าทันที + revalidate background ✅
  if(age < _STALE_TTL){
    if(!_BG_PENDING.has(key)){
      _BG_PENDING.add(key);
      _nocoFetch(url).then(list=>_cachePut(key,list))
        .catch(()=>{}).finally(()=>_BG_PENDING.delete(key));
    }
    return _cache[key].data;
  }

  // EXPIRED — fetch blocking (รอผล)
  const list=await _nocoFetch(url);
  _cachePut(key,list);
  return list;
}

async function nocoPost(tid,body){
  const r=await fetch(`${WORKER_URL}/api/noco/${tid}`,{
    method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify(body)
  });
  if(!r.ok) throw new Error('HTTP '+r.status);
  const result=await r.json();
  _cacheBust(tid); // [v2.4] bust cache หลัง write
  return result;
}


// ── Permission System ─────────────────────────────────────────
//  🔐 PERMISSION SYSTEM
//  แก้ไขเฉพาะ Auth/Permission — ไม่กระทบ UI หรือ Logic อื่น
// ══════════════════════════════════════════════════════
const PERM_MODULES = {
  payment:    { label:'💰 ทำรายการ',       subs:['access','view','create','edit','delete','approve','share','export'] },
  members:    { label:'👥 จัดการสมาชิก',   subs:['access','view','create','edit','delete','approve'] },
  wallet:     { label:'💼 จัดการกระเป๋า',  subs:['access','view','create','edit','delete','setActive'] },
  team:       { label:'🏆 จัดการทีม',      subs:['access','view','create','edit','delete','viewMember'] },
  admin:      { label:'👑 จัดการแอดมิน',   subs:['access','view','create','edit','delete','setPermission','activate','resetPass'] },
  commission: { label:'✅ อนุมัติค่าคอม',  subs:['access','view','approve','reject','export'] },
  claimlp:    { label:'🛡️ Claim LP',       subs:['access','view','approve','reject','edit','delete'] },
  claim10:    { label:'💹 Claim 10%',      subs:['access','view','approve','reject','edit','delete'] },
  content:    { label:'📋 จัดการเนื้อหา', subs:['access','view','create','edit','delete'] },
  cafe:       { label:'☕ จัดการคาเฟ่',   subs:['access','view','create','edit','delete'] },
  database:   { label:'🔧 ฐานข้อมูล',      subs:['access','view','edit','danger'] },
};

// label ภาษาไทยของแต่ละ sub-permission
const PERM_SUB_LABELS = {
  access:'เข้าถึง', view:'ดูข้อมูล', create:'เพิ่ม', edit:'แก้ไข',
  delete:'ลบ', approve:'อนุมัติ', reject:'ปฏิเสธ', export:'Export',
  share:'แชร์', setActive:'ตั้งค่าหลัก', viewMember:'ดูสมาชิก',
  setPermission:'กำหนดสิทธิ์', activate:'เปิด/ปิดบัญชี', resetPass:'Reset รหัส',
  danger:'จัดการ Bulk'
};

// tab ID → permission module mapping
const TAB_PERM_MAP = {
  payment:'payment', members:'members', wallets:'wallet', teams:'team',
  admins:'admin', commapprove:'commission', claimlp:'claimlp',
  claim10:'claim10', content:'content', cafe:'cafe', dbtools:'database'
};

// สร้าง default permissions object (ทุกอย่าง false)
function defaultPermissions(){
  const p = {};
  Object.keys(PERM_MODULES).forEach(mod => {
    p[mod] = {};
    PERM_MODULES[mod].subs.forEach(s => { p[mod][s] = false; });
  });
  return p;
}

// ตรวจสิทธิ์ — ใช้ทั่วระบบแทน if(currentAdmin.root)
function can(module, action){
  if(!currentAdmin) return false;
  if(currentAdmin.root) return true;           // Super Admin ผ่านหมด
  const p = currentAdmin.permissions?.[module];
  if(!p || !p.access) return false;            // ไม่มี access = ผ่านไม่ได้
  if(action === 'access') return p.access === true;
  return p[action] === true;
}

// Rate limit state (in-memory)
let _loginAttempts = 0, _loginLockUntil = 0;


// ── Session Cache + Dashboard Stats ──────────────────────────
// ═══ SESSION CACHE — ข้อมูลไม่หายเมื่อ Refresh ═══
const SS_MEMBERS='tcc_ss_members', SS_TEAMS='tcc_ss_teams', SS_PAYMENTS='tcc_ss_payments';
const SS_TTL = 10 * 60 * 1000; // 10 นาที
function ssSet(k,d){try{sessionStorage.setItem(k,JSON.stringify({d,t:Date.now()}));}catch(e){}}
function ssGet(k){try{const r=sessionStorage.getItem(k);if(!r)return null;const o=JSON.parse(r);if(Date.now()-o.t>SS_TTL){sessionStorage.removeItem(k);return null;}return o.d;}catch(e){return null;}}
function ssClear(k){try{if(k)sessionStorage.removeItem(k);else[SS_MEMBERS,SS_TEAMS,SS_PAYMENTS].forEach(x=>sessionStorage.removeItem(x));}catch(e){}}
function applyDashboardStats(){
  if(MEMBERS.length) setAllById('stat-members',MEMBERS.length);
  if(TEAMS.length)   setAllById('stat-teams',  TEAMS.length);
  if(PAYMENTS.length){
    const total=PAYMENTS.reduce((s,p)=>s+payNum(p,'profit'),0);
    const pending=PAYMENTS.filter(p=>payVal(p,'position')==='Pending').length;
    setAllById('stat-payments',PAYMENTS.length);
    setAllById('stat-pending',pending);
    setAllById('stat-total-profit',fmtUSD(total));
  }
}

// ── Shared Data Arrays (used by both index + admin) ──────────
let MEMBERS=[], TEAMS=[], PAYMENTS=[];
let currentMemberPayments=[], selectedAdminMember=null, tradeRows=[];
let currentMemberPayments=[], selectedAdminMember=null, tradeRows=[];
