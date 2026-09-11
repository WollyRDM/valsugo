import { CONFIG } from './config.js';

const tg = window.Telegram?.WebApp;
if (tg) {
  tg.ready();
  tg.expand();
  try { tg.setHeaderColor('#ffffff'); tg.setBackgroundColor('#f6f8f5'); } catch (_) {}
}

const map = L.map('map', { zoomControl: true }).setView(CONFIG.DEFAULT_CENTER, CONFIG.DEFAULT_ZOOM);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '&copy; OpenStreetMap contributors'
}).addTo(map);

const demoReports = [
  {id:'demo-1', type:'coda', lat:46.0362, lng:11.2486, note:'Traffico rallentato verso Trento', confirmations:7, created_at:new Date(Date.now()-8*60000).toISOString()},
  {id:'demo-2', type:'lavori', lat:46.0074, lng:11.3118, note:'Cantiere, carreggiata ridotta', confirmations:3, created_at:new Date(Date.now()-21*60000).toISOString()}
];

let reports = [...demoReports];
let selectedType = null;
let currentPosition = null;
let userMarker = null;
const reportMarkers = new Map();

const symbols = {incidente:'💥', coda:'🚙', chiusa:'⛔', lavori:'🚧', ostacolo:'⚠️'};
const labels = {incidente:'Incidente', coda:'Coda', chiusa:'Strada chiusa', lavori:'Lavori', ostacolo:'Ostacolo'};

function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg; el.classList.remove('hidden');
  clearTimeout(window.__toastTimer); window.__toastTimer = setTimeout(()=>el.classList.add('hidden'), 2600);
}

function minutesAgo(iso) {
  const m = Math.max(0, Math.round((Date.now()-new Date(iso).getTime())/60000));
  return m < 1 ? 'adesso' : `${m} min fa`;
}

function markerIcon(type) {
  return L.divIcon({html:`<div class="incident-marker">${symbols[type]||'⚠️'}</div>`, className:'', iconSize:[30,30], iconAnchor:[15,15]});
}

function renderReports() {
  for (const marker of reportMarkers.values()) map.removeLayer(marker);
  reportMarkers.clear();
  reports.forEach(r => {
    const marker = L.marker([r.lat,r.lng],{icon:markerIcon(r.type)}).addTo(map);
    marker.bindPopup(`<div class="popup-title">${symbols[r.type]} ${labels[r.type]}</div><div class="popup-meta">${minutesAgo(r.created_at)} · ${r.confirmations||0} conferme</div><div>${escapeHtml(r.note||'Nessuna nota')}</div><br><button class="confirm-btn" data-confirm="${r.id}">Confermo</button>`);
    marker.on('popupopen', () => {
      setTimeout(() => document.querySelector(`[data-confirm="${CSS.escape(r.id)}"]`)?.addEventListener('click',()=>confirmReport(r.id)),0);
    });
    reportMarkers.set(r.id, marker);
  });
}

function escapeHtml(s){return String(s).replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));}

async function getTelegramLocation() {
  if (!tg?.LocationManager) return null;
  return new Promise(resolve => {
    try {
      tg.LocationManager.init(() => {
        tg.LocationManager.getLocation(loc => resolve(loc || null));
      });
    } catch (_) { resolve(null); }
  });
}

async function getBrowserLocation() {
  if (!navigator.geolocation) return null;
  return new Promise(resolve => navigator.geolocation.getCurrentPosition(
    p=>resolve({latitude:p.coords.latitude,longitude:p.coords.longitude,accuracy:p.coords.accuracy}),
    ()=>resolve(null), {enableHighAccuracy:true,timeout:9000,maximumAge:20000}
  ));
}

async function locate(center=true) {
  const loc = await getTelegramLocation() || await getBrowserLocation();
  if (!loc) { toast('Posizione non disponibile. Abilita il GPS per Telegram.'); return null; }
  currentPosition = {lat:loc.latitude,lng:loc.longitude};
  if (userMarker) map.removeLayer(userMarker);
  userMarker = L.circleMarker([currentPosition.lat,currentPosition.lng],{radius:8,weight:4,color:'#fff',fillColor:'#2E8B57',fillOpacity:1}).addTo(map).bindPopup('La tua posizione');
  if (center) map.setView([currentPosition.lat,currentPosition.lng],15);
  return currentPosition;
}

function openSheet(){document.getElementById('reportSheet').classList.remove('hidden');document.getElementById('reportSheet').setAttribute('aria-hidden','false');}
function closeSheet(){document.getElementById('reportSheet').classList.add('hidden');document.getElementById('reportSheet').setAttribute('aria-hidden','true');selectedType=null;document.querySelectorAll('.report-type').forEach(x=>x.classList.remove('selected'));document.getElementById('submitReport').disabled=true;}

async function submitReport(){
  const pos = currentPosition || await locate(false);
  if (!pos) return;
  const report = {id:`local-${Date.now()}`,type:selectedType,lat:pos.lat,lng:pos.lng,note:document.getElementById('note').value.trim(),confirmations:1,created_at:new Date().toISOString()};
  reports.unshift(report); renderReports(); closeSheet(); document.getElementById('note').value='';
  map.setView([pos.lat,pos.lng],15); toast('Segnalazione pubblicata nel prototipo');
  if (tg?.HapticFeedback) tg.HapticFeedback.notificationOccurred('success');
  // Hook Supabase: sostituire con insert reale dopo configurazione backend.
}

function confirmReport(id){
  const r=reports.find(x=>x.id===id); if(!r)return; r.confirmations=(r.confirmations||0)+1; renderReports(); toast('Segnalazione confermata');
  if (tg?.HapticFeedback) tg.HapticFeedback.impactOccurred('light');
}

function compareRoute(){
  const d=document.getElementById('destination').selectedOptions[0].textContent;
  const active=reports.filter(r=>Date.now()-new Date(r.created_at).getTime()<90*60000);
  const severe=active.filter(r=>['incidente','chiusa','coda'].includes(r.type)).length;
  const advice=document.getElementById('routeAdvice');
  if(severe===0) advice.textContent=`Verso ${d}: nessuna criticità importante segnalata.`;
  else advice.innerHTML=`Verso ${d}: <strong>${severe} criticità attive</strong>. V1 mostra le segnalazioni; il routing alternativo arriva nella V2.`;
}

document.getElementById('reportBtn').addEventListener('click',openSheet);
document.getElementById('cancelReport').addEventListener('click',closeSheet);
document.getElementById('submitReport').addEventListener('click',submitReport);
document.getElementById('locateBtn').addEventListener('click',()=>locate(true));
document.getElementById('routeBtn').addEventListener('click',compareRoute);
document.querySelectorAll('.report-type').forEach(btn=>btn.addEventListener('click',()=>{
  selectedType=btn.dataset.type; document.querySelectorAll('.report-type').forEach(x=>x.classList.toggle('selected',x===btn)); document.getElementById('submitReport').disabled=false;
}));
document.getElementById('alertsBtn').addEventListener('click',()=>{map.fitBounds(L.latLngBounds(reports.map(r=>[r.lat,r.lng])),{padding:[35,35]});toast(`${reports.length} segnalazioni visibili`);});
document.getElementById('aboutBtn').addEventListener('click',()=>{const u=tg?.initDataUnsafe?.user;toast(u?`Ciao ${u.first_name}! ValsuGo Telegram V1`:'ValsuGo Telegram V1 – modalità browser');});

renderReports();
setTimeout(()=>map.invalidateSize(),200);
