import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
import { CONFIG } from './config.js';

const tg = window.Telegram?.WebApp;
if (tg) {
  tg.ready();
  tg.expand();
  try { tg.setHeaderColor('#ffffff'); tg.setBackgroundColor('#f6f8f5'); } catch (_) {}
}

const supabase = createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
});

const map = L.map('map', { zoomControl: true }).setView(CONFIG.DEFAULT_CENTER, CONFIG.DEFAULT_ZOOM);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '&copy; OpenStreetMap contributors'
}).addTo(map);

let reports = [];
let selectedType = null;
let currentPosition = null;
let userMarker = null;
const reportMarkers = new Map();

const symbols = {incidente:'💥', coda:'🚙', strada_chiusa:'⛔', lavori:'🚧', ostacolo:'⚠️'};
const labels = {incidente:'Incidente', coda:'Coda', strada_chiusa:'Strada chiusa', lavori:'Lavori', ostacolo:'Ostacolo'};

function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(window.__toastTimer);
  window.__toastTimer = setTimeout(()=>el.classList.add('hidden'), 3000);
}

function minutesAgo(iso) {
  const m = Math.max(0, Math.round((Date.now()-new Date(iso).getTime())/60000));
  if (m < 1) return 'adesso';
  if (m < 60) return `${m} min fa`;
  const h = Math.round(m/60);
  return `${h} h fa`;
}

function markerIcon(type) {
  return L.divIcon({
    html:`<div class="incident-marker">${symbols[type]||'⚠️'}</div>`,
    className:'', iconSize:[30,30], iconAnchor:[15,15]
  });
}

function escapeHtml(s){
  return String(s ?? '').replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
}

function renderReports() {
  for (const marker of reportMarkers.values()) map.removeLayer(marker);
  reportMarkers.clear();

  reports.filter(r=>r.attiva !== false).forEach(r => {
    const marker = L.marker([r.latitudine,r.longitudine],{icon:markerIcon(r.tipo)}).addTo(map);
    marker.bindPopup(`
      <div class="popup-title">${symbols[r.tipo]||'⚠️'} ${labels[r.tipo]||r.tipo}</div>
      <div class="popup-meta">${minutesAgo(r.created_at)} · ${r.conferme||0} conferme</div>
      <div>${escapeHtml(r.descrizione||'Nessuna nota')}</div><br>
      <button class="confirm-btn" data-confirm="${r.id}">Confermo</button>
      <button class="confirm-btn" data-gone="${r.id}" style="margin-left:6px">Non c'è più</button>
    `);
    marker.on('popupopen', () => {
      setTimeout(() => {
        document.querySelector(`[data-confirm="${CSS.escape(r.id)}"]`)?.addEventListener('click',()=>confirmReport(r.id,'confermo'));
        document.querySelector(`[data-gone="${CSS.escape(r.id)}"]`)?.addEventListener('click',()=>confirmReport(r.id,'non_presente'));
      },0);
    });
    reportMarkers.set(r.id, marker);
  });
}

function telegramUser() {
  const u = tg?.initDataUnsafe?.user;
  if (!u) return { id: null, username: null };
  return { id: Number(u.id), username: u.username || null };
}

async function loadReports(showToast=false) {
  const since = new Date(Date.now() - 6*60*60*1000).toISOString();
  const { data, error } = await supabase
    .from('segnalazioni')
    .select('*')
    .eq('attiva', true)
    .gte('created_at', since)
    .order('created_at', { ascending: false });

  if (error) {
    console.error(error);
    if (showToast) toast(`Errore database: ${error.message}`);
    return;
  }
  reports = data || [];
  renderReports();
  if (showToast) toast(`${reports.length} segnalazioni attive`);
}

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
    ()=>resolve(null), {enableHighAccuracy:true,timeout:9000,maximumAge:15000}
  ));
}

async function locate(center=true) {
  const loc = await getTelegramLocation() || await getBrowserLocation();
  if (!loc) { toast('Posizione non disponibile. Abilita la posizione per Telegram.'); return null; }
  currentPosition = {lat:loc.latitude,lng:loc.longitude};
  if (userMarker) map.removeLayer(userMarker);
  userMarker = L.circleMarker([currentPosition.lat,currentPosition.lng],{
    radius:8,weight:4,color:'#fff',fillColor:'#2E8B57',fillOpacity:1
  }).addTo(map).bindPopup('La tua posizione');
  if (center) map.setView([currentPosition.lat,currentPosition.lng],15);
  return currentPosition;
}

function openSheet(){
  document.getElementById('reportSheet').classList.remove('hidden');
  document.getElementById('reportSheet').setAttribute('aria-hidden','false');
}
function closeSheet(){
  document.getElementById('reportSheet').classList.add('hidden');
  document.getElementById('reportSheet').setAttribute('aria-hidden','true');
  selectedType=null;
  document.querySelectorAll('.report-type').forEach(x=>x.classList.remove('selected'));
  document.getElementById('submitReport').disabled=true;
}

async function submitReport(){
  const pos = currentPosition || await locate(false);
  if (!pos || !selectedType) return;

  const user = telegramUser();
  const payload = {
    tipo: selectedType,
    latitudine: pos.lat,
    longitudine: pos.lng,
    descrizione: document.getElementById('note').value.trim() || null,
    telegram_user_id: user.id,
    telegram_username: user.username,
    conferme: 1,
    attiva: true
  };

  const btn = document.getElementById('submitReport');
  btn.disabled = true;
  const { data, error } = await supabase.from('segnalazioni').insert(payload).select().single();
  if (error) {
    console.error(error);
    btn.disabled = false;
    toast(`Errore salvataggio: ${error.message}`);
    return;
  }

  if (user.id) {
    await supabase.from('conferme').upsert({
      segnalazione_id: data.id,
      telegram_user_id: user.id,
      stato: 'confermo'
    }, { onConflict: 'segnalazione_id,telegram_user_id' });
  }

  closeSheet();
  document.getElementById('note').value='';
  map.setView([pos.lat,pos.lng],15);
  await loadReports();
  toast('Segnalazione pubblicata online');
  if (tg?.HapticFeedback) tg.HapticFeedback.notificationOccurred('success');
}

async function confirmReport(id, stato){
  const user = telegramUser();
  if (!user.id) {
    toast('Apri ValsuGo dentro Telegram per confermare.');
    return;
  }

  const { error: upsertError } = await supabase.from('conferme').upsert({
    segnalazione_id: id,
    telegram_user_id: user.id,
    stato
  }, { onConflict: 'segnalazione_id,telegram_user_id' });

  if (upsertError) {
    console.error(upsertError);
    toast(`Errore conferma: ${upsertError.message}`);
    return;
  }

  const { data: votes, error: voteError } = await supabase
    .from('conferme')
    .select('stato')
    .eq('segnalazione_id', id);

  if (voteError) {
    console.error(voteError);
    toast('Conferma registrata, aggiornamento conteggio in corso.');
    return;
  }

  const conferme = votes.filter(v=>v.stato==='confermo').length;
  const nonPresente = votes.filter(v=>v.stato==='non_presente').length;
  const attiva = !(nonPresente >= 3 && nonPresente > conferme);

  await supabase.from('segnalazioni').update({
    conferme,
    non_presente: nonPresente,
    attiva
  }).eq('id', id);

  await loadReports();
  toast(stato==='confermo' ? 'Segnalazione confermata' : 'Indicazione registrata');
  if (tg?.HapticFeedback) tg.HapticFeedback.impactOccurred('light');
}

function compareRoute(){
  const d=document.getElementById('destination').selectedOptions[0].textContent;
  const active=reports.filter(r=>Date.now()-new Date(r.created_at).getTime()<90*60000);
  const severe=active.filter(r=>['incidente','strada_chiusa','coda'].includes(r.tipo)).length;
  const advice=document.getElementById('routeAdvice');
  if(severe===0) advice.textContent=`Verso ${d}: nessuna criticità importante segnalata negli ultimi 90 minuti.`;
  else advice.innerHTML=`Verso ${d}: <strong>${severe} criticità recenti</strong>. Il routing alternativo automatico sarà il prossimo modulo.`;
}

// Realtime: ogni modifica delle due tabelle ricarica i marker.
supabase.channel('valsugo-live')
  .on('postgres_changes', {event:'*', schema:'public', table:'segnalazioni'}, ()=>loadReports())
  .on('postgres_changes', {event:'*', schema:'public', table:'conferme'}, ()=>loadReports())
  .subscribe(status => console.log('Realtime:', status));

document.getElementById('reportBtn').addEventListener('click',openSheet);
document.getElementById('cancelReport').addEventListener('click',closeSheet);
document.getElementById('submitReport').addEventListener('click',submitReport);
document.getElementById('locateBtn').addEventListener('click',()=>locate(true));
document.getElementById('routeBtn').addEventListener('click',compareRoute);
document.querySelectorAll('.report-type').forEach(btn=>btn.addEventListener('click',()=>{
  selectedType=btn.dataset.type === 'chiusa' ? 'strada_chiusa' : btn.dataset.type;
  document.querySelectorAll('.report-type').forEach(x=>x.classList.toggle('selected',x===btn));
  document.getElementById('submitReport').disabled=false;
}));
document.getElementById('alertsBtn').addEventListener('click',()=>{
  if (!reports.length) { toast('Nessuna segnalazione attiva'); return; }
  map.fitBounds(L.latLngBounds(reports.map(r=>[r.latitudine,r.longitudine])),{padding:[35,35]});
  toast(`${reports.length} segnalazioni visibili`);
});
document.getElementById('aboutBtn').addEventListener('click',()=>{
  const u=tg?.initDataUnsafe?.user;
  toast(u?`Ciao ${u.first_name}! ValsuGo V1.1 online`:'ValsuGo V1.1 – aprila dentro Telegram');
});

loadReports(true);
locate(false);
setTimeout(()=>map.invalidateSize(),200);
