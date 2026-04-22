// ======================================================================
// Coordenação EAC — lógica do app
// ======================================================================
import { db, auth, ensureAuth } from './firebase-config.js';
import {
  collection, doc, getDoc, setDoc, updateDoc, deleteDoc,
  addDoc, onSnapshot, serverTimestamp, Timestamp
} from 'https://www.gstatic.com/firebasejs/12.12.1/firebase-firestore.js';

// ---------- Usuários fixos da coordenação -------------------------------
const USERS = [
  { id: 'wagner',   name: 'Tio Wagner',   role: 'tio'   },
  { id: 'barbara',  name: 'Tia Bárbara',  role: 'tio'   },
  { id: 'cristian', name: 'Tio Cristian', role: 'tio'   },
  { id: 'izabel',   name: 'Tia Izabel',   role: 'tio'   },
  { id: 'anajulia', name: 'Ana Júlia',    role: 'jovem' },
  { id: 'malu',     name: 'Malu',         role: 'jovem' },
  { id: 'pedro',    name: 'Pedro',        role: 'jovem' },
  { id: 'matheus',  name: 'Matheus',      role: 'jovem' },
];

// Paleta de cores para avatares (consistente por id)
const AVATAR_COLORS = [
  ['#FCE4D6','#8B3A1E'], ['#E4EEDF','#2D5A2D'], ['#E8E0F0','#4B3470'],
  ['#FFE8CC','#8B4513'], ['#DFEBF5','#1E4C73'], ['#F5DDDD','#8B2E2E'],
  ['#EEE5D4','#5C4822'], ['#D9E8E3','#1F5950'],
];

// ---------- Estado ------------------------------------------------------
let currentUser = null;        // { id, name, role }
let demandas = [];             // cache local das demandas
let unsubDemandas = null;      // onSnapshot unsubscriber
let activeFilter = 'todas';    // 'todas' | 'aguardam' | 'minhas' | 'encerradas'
let selectedLoginUserId = null;
let renderedCardIds = new Set(); // ids que já estão no DOM (para não reanimar)

// ---------- Helpers -----------------------------------------------------
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

const getInitials = (name) =>
  name.split(' ').filter(w => !['Tio','Tia','de','da','do'].includes(w))
    .slice(0, 2).map(w => w[0]).join('').toUpperCase();

const getUserById = (id) => USERS.find(u => u.id === id);

const colorsFor = (id) => {
  const idx = USERS.findIndex(u => u.id === id);
  return AVATAR_COLORS[idx >= 0 ? idx : 0];
};

const avatarHTML = (userId, size = 28) => {
  const u = getUserById(userId);
  if (!u) return '';
  const [bg, fg] = colorsFor(userId);
  return `<span class="avatar" style="width:${size}px;height:${size}px;font-size:${size*0.38}px;background:${bg};color:${fg}" title="${u.name}">${getInitials(u.name)}</span>`;
};

async function hashPin(pin) {
  const buf = new TextEncoder().encode('eac_v1::' + pin);
  const hashBuf = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(hashBuf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function showToast(msg, ms = 2600) {
  const el = $('#toast');
  el.textContent = msg;
  el.style.opacity = '1';
  el.style.transform = 'translate(-50%, 0)';
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => {
    el.style.opacity = '0';
  }, ms);
}

function escapeHTML(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

// ---------- Urgência baseada no prazo -----------------------------------
// verde  : mais de 72h
// amarelo: entre 24h e 72h
// vermelho: menos de 24h OU vencido (ainda aberta)
function computeUrgency(prazoMs, now = Date.now()) {
  if (prazoMs < now) return 'vermelho';
  const diff = prazoMs - now;
  const h = diff / (1000 * 60 * 60);
  if (h <= 24) return 'vermelho';
  if (h <= 72) return 'amarelo';
  return 'verde';
}

function isEncerrada(d) {
  const prazoMs = d.prazo?.toMillis?.() ?? 0;
  return prazoMs < Date.now();
}

function formatTimeRemaining(prazoMs) {
  const now = Date.now();
  const diff = prazoMs - now;
  const abs = Math.abs(diff);
  const mins = Math.floor(abs / 60000);
  const hours = Math.floor(mins / 60);
  const days = Math.floor(hours / 24);
  const vencido = diff < 0;

  let text;
  if (days >= 1)      text = `${days} dia${days > 1 ? 's' : ''}`;
  else if (hours >= 1) text = `${hours}h`;
  else                text = `${Math.max(mins,1)} min`;

  return vencido ? `vencida há ${text}` : `${text} restante${days>1?'s':''}`;
}

function formatDateTime(ts) {
  const d = new Date(ts);
  return d.toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' }) +
    ' · ' + d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}

// ======================================================================
// INICIALIZAÇÃO
// ======================================================================
async function init() {
  $('#year').textContent = new Date().getFullYear();

  try {
    await ensureAuth();
  } catch (err) {
    console.error('Erro no sign-in anônimo:', err);
    alert('Não foi possível conectar ao Firebase. Verifique o firebase-config.js e se Authentication > Anonymous está ativo.');
    return;
  }

  const saved = localStorage.getItem('eac_user');
  if (saved) {
    try {
      currentUser = JSON.parse(saved);
      if (getUserById(currentUser.id)) {
        enterApp();
        return;
      }
    } catch {}
    localStorage.removeItem('eac_user');
  }
  showLogin();
}

// ======================================================================
// LOGIN
// ======================================================================
function showLogin() {
  $('#loading-screen').classList.add('hidden');
  $('#app-screen').classList.add('hidden');
  $('#login-screen').classList.remove('hidden');
  $('#login-step-name').classList.remove('hidden');
  $('#login-step-pin').classList.add('hidden');
  renderUsersGrid();
}

function renderUsersGrid() {
  const tios = USERS.filter(u => u.role === 'tio');
  const jovens = USERS.filter(u => u.role === 'jovem');
  const section = (title, list) => `
    <div class="col-span-2 text-[10px] font-semibold text-muted uppercase tracking-[0.18em] mt-3 first:mt-0 px-1">${title}</div>
    ${list.map(u => `
      <button class="user-pill" data-user="${u.id}">
        ${avatarHTML(u.id, 32)}
        <span class="flex-1 min-w-0">
          <span class="block font-medium text-[15px] truncate">${escapeHTML(u.name)}</span>
        </span>
      </button>
    `).join('')}
  `;
  $('#users-grid').innerHTML = section('Tios', tios) + section('Jovens', jovens);
  $$('#users-grid [data-user]').forEach(btn => {
    btn.addEventListener('click', () => selectLoginUser(btn.dataset.user));
  });
}

async function selectLoginUser(userId) {
  const user = getUserById(userId);
  if (!user) return;
  selectedLoginUserId = userId;
  $('#selected-name').textContent = user.name;
  $('#login-step-name').classList.add('hidden');
  $('#login-step-pin').classList.remove('hidden');
  $('#pin-hint').textContent = '';
  $$('.pin-box').forEach(b => b.value = '');

  // Verifica se esse usuário já tem PIN configurado
  const snap = await getDoc(doc(db, 'users', userId));
  if (!snap.exists() || !snap.data().pinHash) {
    $('#pin-label').innerHTML = 'Primeira vez. <strong>Crie seu PIN de 4 dígitos.</strong>';
    $('#pin-hint').textContent = 'Use algo que você lembre. Ele fica só no seu login.';
  } else {
    $('#pin-label').textContent = 'Digite seu PIN de 4 dígitos';
  }

  setTimeout(() => $('.pin-box[data-pin="0"]').focus(), 120);
}

function wireLoginInputs() {
  $('#back-to-names').addEventListener('click', () => {
    selectedLoginUserId = null;
    $('#login-step-pin').classList.add('hidden');
    $('#login-step-name').classList.remove('hidden');
  });

  $$('.pin-box').forEach((input, idx, arr) => {
    input.addEventListener('input', (e) => {
      const v = e.target.value.replace(/\D/g, '').slice(0, 1);
      e.target.value = v;
      if (v && idx < arr.length - 1) arr[idx + 1].focus();
      const pin = [...arr].map(i => i.value).join('');
      $('#pin-submit').disabled = pin.length !== 4;
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Backspace' && !e.target.value && idx > 0) arr[idx - 1].focus();
      if (e.key === 'Enter' && !$('#pin-submit').disabled) handlePinSubmit();
    });
  });

  $('#pin-submit').addEventListener('click', handlePinSubmit);
}

async function handlePinSubmit() {
  const pin = [...$$('.pin-box')].map(i => i.value).join('');
  if (pin.length !== 4) return;
  const btn = $('#pin-submit');
  btn.disabled = true;
  btn.textContent = 'Entrando...';

  try {
    const userRef = doc(db, 'users', selectedLoginUserId);
    const snap = await getDoc(userRef);
    const hashed = await hashPin(pin);

    if (!snap.exists() || !snap.data().pinHash) {
      // primeira vez — define PIN
      const user = getUserById(selectedLoginUserId);
      await setDoc(userRef, { name: user.name, role: user.role, pinHash: hashed });
      currentUser = { id: user.id, name: user.name, role: user.role };
      localStorage.setItem('eac_user', JSON.stringify(currentUser));
      enterApp();
      showToast('PIN criado. Bem-vindo(a)!');
    } else if (snap.data().pinHash === hashed) {
      const user = getUserById(selectedLoginUserId);
      currentUser = { id: user.id, name: user.name, role: user.role };
      localStorage.setItem('eac_user', JSON.stringify(currentUser));
      enterApp();
    } else {
      $('#pin-hint').innerHTML = '<span class="text-vermelho font-medium">PIN incorreto. Tenta de novo.</span>';
      $$('.pin-box').forEach(i => i.value = '');
      $('.pin-box[data-pin="0"]').focus();
      btn.textContent = 'Entrar';
      btn.disabled = false;
    }
  } catch (err) {
    console.error(err);
    $('#pin-hint').innerHTML = '<span class="text-vermelho">Erro de conexão. Tenta de novo.</span>';
    btn.textContent = 'Entrar';
    btn.disabled = false;
  }
}

function logout() {
  localStorage.removeItem('eac_user');
  if (unsubDemandas) { unsubDemandas(); unsubDemandas = null; }
  currentUser = null;
  showLogin();
}

// ======================================================================
// APP
// ======================================================================
function enterApp() {
  $('#loading-screen').classList.add('hidden');
  $('#login-screen').classList.add('hidden');
  $('#app-screen').classList.remove('hidden');

  const [bg, fg] = colorsFor(currentUser.id);
  const avatarEl = $('#user-avatar');
  avatarEl.textContent = getInitials(currentUser.name);
  avatarEl.style.background = bg;
  avatarEl.style.color = fg;

  $('#user-menu-btn').onclick = () => openUserMenu();
  $('#new-demand-btn').onclick = () => openDemandaForm();
  $('#filter-toggle').onclick = () => {
    const bar = $('#filter-bar');
    bar.classList.toggle('hidden');
  };
  $$('#filter-bar [data-filter]').forEach(btn => {
    btn.onclick = () => {
      activeFilter = btn.dataset.filter;
      $$('#filter-bar [data-filter]').forEach(b => b.classList.toggle('active', b.dataset.filter === activeFilter));
      renderFeed();
    };
  });
  $('#filter-bar [data-filter="todas"]').classList.add('active');

  subscribeDemandas();

  // auto-refresh de tempo restante a cada minuto
  clearInterval(enterApp._tick);
  enterApp._tick = setInterval(() => renderFeed(), 60_000);
}

function openUserMenu() {
  openModal(`
    <div class="bg-paper rounded-3xl p-5 max-w-sm w-full mx-auto anim-scale-in">
      <div class="flex items-center gap-3 mb-5">
        ${avatarHTML(currentUser.id, 48)}
        <div>
          <p class="font-display text-lg font-600 leading-tight">${escapeHTML(currentUser.name)}</p>
          <p class="text-xs text-muted">${currentUser.role === 'tio' ? 'Tio(a) coordenador(a)' : 'Jovem coordenador(a)'}</p>
        </div>
      </div>
      <button id="change-pin-btn" class="w-full text-left px-4 py-3 rounded-xl hover:bg-cream transition-colors text-sm flex items-center gap-3">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
        Trocar meu PIN
      </button>
      <button id="logout-btn" class="w-full text-left px-4 py-3 rounded-xl hover:bg-vermelho-bg transition-colors text-sm flex items-center gap-3 text-vermelho">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/></svg>
        Sair
      </button>
      <button class="modal-close w-full mt-3 py-3 rounded-xl border border-border text-sm font-medium">Fechar</button>
    </div>
  `);
  $('#logout-btn').onclick = () => { closeModal(); logout(); };
  $('#change-pin-btn').onclick = () => { closeModal(); openChangePin(); };
}

function openChangePin() {
  openModal(`
    <div class="bg-paper rounded-3xl p-6 max-w-sm w-full mx-auto anim-scale-in">
      <p class="text-xs font-semibold text-muted uppercase tracking-widest mb-1">Trocar PIN</p>
      <h3 class="font-display text-2xl font-600 mb-5">Novo PIN de 4 dígitos</h3>
      <div class="mb-3">
        <label class="text-xs text-muted">PIN atual</label>
        <input id="pin-cur" type="tel" inputmode="numeric" maxlength="4" class="w-full mt-1 px-4 py-3 rounded-xl border border-border bg-cream text-center text-xl font-display focus:border-ink" />
      </div>
      <div class="mb-5">
        <label class="text-xs text-muted">Novo PIN</label>
        <input id="pin-new" type="tel" inputmode="numeric" maxlength="4" class="w-full mt-1 px-4 py-3 rounded-xl border border-border bg-cream text-center text-xl font-display focus:border-ink" />
      </div>
      <p id="pin-change-msg" class="text-xs text-vermelho mb-2 min-h-[16px]"></p>
      <div class="flex gap-2">
        <button class="modal-close flex-1 py-3 rounded-xl border border-border text-sm font-medium">Cancelar</button>
        <button id="pin-change-save" class="flex-1 py-3 rounded-xl bg-ink text-cream text-sm font-medium">Salvar</button>
      </div>
    </div>
  `);
  $('#pin-change-save').onclick = async () => {
    const cur = $('#pin-cur').value;
    const nw = $('#pin-new').value;
    if (cur.length !== 4 || nw.length !== 4) {
      $('#pin-change-msg').textContent = 'Ambos devem ter 4 dígitos.';
      return;
    }
    const userRef = doc(db, 'users', currentUser.id);
    const snap = await getDoc(userRef);
    if (snap.data()?.pinHash !== await hashPin(cur)) {
      $('#pin-change-msg').textContent = 'PIN atual incorreto.';
      return;
    }
    await updateDoc(userRef, { pinHash: await hashPin(nw) });
    closeModal();
    showToast('PIN atualizado.');
  };
}

// ======================================================================
// FEED — onSnapshot
// ======================================================================
function subscribeDemandas() {
  if (unsubDemandas) unsubDemandas();
  unsubDemandas = onSnapshot(collection(db, 'demandas'), (snap) => {
    demandas = [];
    snap.forEach(docSnap => demandas.push({ id: docSnap.id, ...docSnap.data() }));
    renderFeed();
  }, (err) => {
    console.error(err);
    showToast('Erro ao carregar demandas.');
  });
}

function filterDemandas() {
  const uid = currentUser.id;
  return demandas.filter(d => {
    const encerrada = isEncerrada(d);
    if (activeFilter === 'encerradas') return encerrada;
    if (encerrada) return false;
    if (activeFilter === 'aguardam')  return !d.votos?.[uid];
    if (activeFilter === 'minhas')    return d.criadoPorId === uid;
    return true;
  });
}

function sortDemandas(list) {
  const rank = { vermelho: 0, amarelo: 1, verde: 2 };
  return list.slice().sort((a, b) => {
    const ae = isEncerrada(a), be = isEncerrada(b);
    if (ae !== be) return ae ? 1 : -1;
    if (!ae) {
      const ua = computeUrgency(a.prazo?.toMillis() ?? 0);
      const ub = computeUrgency(b.prazo?.toMillis() ?? 0);
      if (rank[ua] !== rank[ub]) return rank[ua] - rank[ub];
    }
    return (a.prazo?.toMillis() ?? 0) - (b.prazo?.toMillis() ?? 0);
  });
}

function renderFeed() {
  const list = sortDemandas(filterDemandas());
  const feed = $('#feed');
  const empty = $('#feed-empty');

  if (list.length === 0) {
    feed.innerHTML = '';
    empty.classList.remove('hidden');
    renderedCardIds = new Set();
  } else {
    empty.classList.add('hidden');
    feed.innerHTML = list.map((d, i) => renderCard(d, i)).join('');
    feed.querySelectorAll('[data-card]').forEach(el => {
      el.addEventListener('click', () => openDemandaDetail(el.dataset.card));
    });
    renderedCardIds = new Set(list.map(d => d.id));
  }

  // banner de pendências
  const pendentes = demandas.filter(d => !isEncerrada(d) && !d.votos?.[currentUser.id]);
  const banner = $('#status-banner');
  if (pendentes.length > 0 && activeFilter !== 'aguardam') {
    banner.classList.remove('hidden');
    banner.innerHTML = `
      <button class="w-full text-left bg-paper border border-border rounded-2xl p-4 flex items-center gap-3 anim-fade-in hover:border-ink transition-colors">
        <span class="w-10 h-10 rounded-full bg-vermelho-bg flex items-center justify-center flex-shrink-0">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#C4341C" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 9v4M12 17h.01M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z"/></svg>
        </span>
        <span class="flex-1">
          <span class="block text-sm font-semibold text-ink">${pendentes.length} ${pendentes.length === 1 ? 'demanda aguarda' : 'demandas aguardam'} seu voto</span>
          <span class="block text-xs text-muted">toque para ver só essas</span>
        </span>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#7A736D" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>
      </button>
    `;
    banner.querySelector('button').onclick = () => {
      activeFilter = 'aguardam';
      $('#filter-bar').classList.remove('hidden');
      $$('#filter-bar [data-filter]').forEach(b => b.classList.toggle('active', b.dataset.filter === 'aguardam'));
      renderFeed();
    };
  } else {
    banner.classList.add('hidden');
  }
}

function renderCard(d, i) {
  const prazoMs = d.prazo?.toMillis?.() ?? 0;
  const encerrada = isEncerrada(d);
  const urg = encerrada ? 'encerrada' : computeUrgency(prazoMs);
  const totalVotos = Object.keys(d.votos || {}).length;
  const faltam = USERS.length - totalVotos;
  const jaVotou = !!d.votos?.[currentUser.id];

  const tagConfig = {
    verde:    { bg: 'bg-verde-bg',    text: 'text-verde',    label: 'Com tempo' },
    amarelo:  { bg: 'bg-amarelo-bg',  text: 'text-amarelo',  label: 'Atenção' },
    vermelho: { bg: 'bg-vermelho-bg', text: 'text-vermelho', label: 'Urgente' },
    encerrada:{ bg: 'bg-border',      text: 'text-muted',    label: 'Encerrada' },
  }[urg];

  const votadosIds = Object.keys(d.votos || {});
  const avatarStack = votadosIds.slice(0, 4).map((uid, idx) =>
    `<span style="margin-left:${idx === 0 ? 0 : -10}px;position:relative;z-index:${10-idx}">${avatarHTML(uid, 24)}</span>`
  ).join('');

  // preview do vencedor, se encerrada
  let winner = '';
  if (encerrada && d.opcoes?.length) {
    const counts = {};
    Object.values(d.votos || {}).forEach(opt => counts[opt] = (counts[opt] || 0) + 1);
    const sorted = d.opcoes.map(o => ({ ...o, c: counts[o.id] || 0 })).sort((a,b) => b.c - a.c);
    const top = sorted[0];
    if (top && top.c > 0) {
      winner = `
        <div class="mt-3 pt-3 border-t border-border/70 flex items-center gap-2 text-sm">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#16794A" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m9 12 2 2 4-4"/><circle cx="12" cy="12" r="10"/></svg>
          <span class="text-muted">Decisão:</span>
          <span class="font-medium text-ink">${escapeHTML(top.texto)}</span>
          <span class="text-muted text-xs">· ${top.c} voto${top.c>1?'s':''}</span>
        </div>`;
    } else {
      winner = `<div class="mt-3 pt-3 border-t border-border/70 text-sm text-muted italic">Encerrada sem votos.</div>`;
    }
  }

  return `
    <article data-card="${d.id}" class="bg-paper rounded-2xl border border-border shadow-card p-4 cursor-pointer active:scale-[0.995] transition-transform ${urg === 'vermelho' && !encerrada ? 'pulse-red' : ''} ${renderedCardIds.has(d.id) ? '' : 'anim-fade-up'}" style="${renderedCardIds.has(d.id) ? '' : `animation-delay:${Math.min(i, 8) * 40}ms`}">
      <div class="flex items-start justify-between gap-3 mb-2.5">
        <span class="urgency-tag inline-flex items-center gap-1.5 ${tagConfig.bg} ${tagConfig.text} px-2.5 py-1 rounded-full text-[11px] font-semibold uppercase">
          <span class="w-1.5 h-1.5 rounded-full ${tagConfig.text.replace('text-','bg-')}"></span>
          ${tagConfig.label}
        </span>
        <span class="text-[11px] text-muted font-medium whitespace-nowrap">${encerrada ? 'Prazo: ' + formatDateTime(prazoMs) : formatTimeRemaining(prazoMs)}</span>
      </div>

      <h3 class="font-display text-[19px] leading-snug font-600 text-ink mb-1">${escapeHTML(d.titulo)}</h3>
      ${d.descricao ? `<p class="text-sm text-muted line-clamp-2 leading-relaxed">${escapeHTML(d.descricao)}</p>` : ''}

      <div class="mt-3 flex items-center gap-3 text-xs">
        <div class="flex items-center">${avatarStack}${totalVotos > 4 ? `<span class="ml-[-10px] avatar" style="background:#E7E0D4;color:#7A736D;width:24px;height:24px;font-size:9px">+${totalVotos-4}</span>` : ''}</div>
        <span class="text-muted">
          ${totalVotos === USERS.length ? 'todos votaram' :
            faltam === 0 ? 'todos votaram' :
            `${totalVotos}/${USERS.length} votaram`}
        </span>
        ${!encerrada && !jaVotou ? '<span class="ml-auto text-brand text-xs font-semibold uppercase tracking-wider">votar</span>' : ''}
        ${!encerrada && jaVotou ? '<span class="ml-auto text-verde text-xs font-semibold uppercase tracking-wider">✓ você votou</span>' : ''}
      </div>
      ${winner}
    </article>
  `;
}

// ======================================================================
// DETAIL SHEET (votação + info)
// ======================================================================
function openDemandaDetail(id) {
  const d = demandas.find(x => x.id === id);
  if (!d) return;

  const prazoMs = d.prazo?.toMillis?.() ?? 0;
  const encerrada = isEncerrada(d);
  const urg = encerrada ? 'encerrada' : computeUrgency(prazoMs);
  const tagConfig = {
    verde:    { bg: 'bg-verde-bg',    text: 'text-verde',    label: 'Com tempo' },
    amarelo:  { bg: 'bg-amarelo-bg',  text: 'text-amarelo',  label: 'Atenção' },
    vermelho: { bg: 'bg-vermelho-bg', text: 'text-vermelho', label: 'Urgente' },
    encerrada:{ bg: 'bg-border',      text: 'text-muted',    label: 'Encerrada' },
  }[urg];

  const votos = d.votos || {};
  const counts = {};
  d.opcoes.forEach(o => counts[o.id] = 0);
  Object.values(votos).forEach(optId => { if (counts[optId] !== undefined) counts[optId]++; });
  const totalVotos = Object.keys(votos).length;
  const meuVoto = votos[currentUser.id] || null;
  const ehCriador = d.criadoPorId === currentUser.id;

  const naoVotaram = USERS.filter(u => !votos[u.id]);
  const vencedorId = Object.keys(counts).sort((a,b) => counts[b] - counts[a])[0];

  openSheet(`
    <div class="flex items-center justify-between mb-4 px-5 pt-5">
      <span class="urgency-tag inline-flex items-center gap-1.5 ${tagConfig.bg} ${tagConfig.text} px-2.5 py-1 rounded-full text-[11px] font-semibold uppercase">
        <span class="w-1.5 h-1.5 rounded-full ${tagConfig.text.replace('text-','bg-')}"></span>${tagConfig.label}
      </span>
      <button class="modal-close w-9 h-9 rounded-full flex items-center justify-center hover:bg-cream">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg>
      </button>
    </div>

    <div class="px-5 pb-5 border-b border-border">
      <h2 class="font-display text-2xl font-600 leading-tight mb-2">${escapeHTML(d.titulo)}</h2>
      ${d.descricao ? `<p class="text-sm text-ink/80 leading-relaxed whitespace-pre-wrap">${escapeHTML(d.descricao)}</p>` : ''}
      <div class="mt-3 flex items-center gap-2 text-xs text-muted">
        ${avatarHTML(d.criadoPorId, 20)}
        <span>por <span class="font-medium text-ink/80">${escapeHTML(d.criadoPorNome)}</span></span>
        <span class="text-border">·</span>
        <span>Prazo: ${formatDateTime(prazoMs)}</span>
      </div>
    </div>

    <div class="px-5 py-5">
      <p class="text-xs font-semibold text-muted uppercase tracking-widest mb-3">
        ${encerrada ? 'Resultado' : 'Opções'}
      </p>
      <div class="space-y-2">
        ${d.opcoes.map(opt => {
          const c = counts[opt.id] || 0;
          const pct = totalVotos > 0 ? Math.round((c / totalVotos) * 100) : 0;
          const sel = meuVoto === opt.id;
          const isWinner = encerrada && c > 0 && opt.id === vencedorId;
          const avatars = Object.entries(votos).filter(([_, v]) => v === opt.id).map(([uid]) => avatarHTML(uid, 22)).join('');
          return `
            <button class="vote-option w-full text-left relative overflow-hidden rounded-2xl border-[1.5px] ${sel ? 'border-ink bg-ink/[0.04]' : 'border-border bg-paper'} ${isWinner ? '!border-verde bg-verde-bg/40' : ''} p-4 ${encerrada ? 'cursor-default' : 'hover:border-ink/60'} transition-all" ${encerrada ? 'disabled' : ''} data-opt="${opt.id}">
              <span class="absolute inset-y-0 left-0 ${isWinner ? 'bg-verde/10' : sel ? 'bg-ink/[0.05]' : 'bg-border/40'} transition-all" style="width:${pct}%"></span>
              <span class="relative flex items-center justify-between gap-3">
                <span class="flex items-center gap-2 min-w-0 flex-1">
                  ${sel ? '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#1A1614" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" class="flex-shrink-0"><path d="m9 12 2 2 4-4"/><circle cx="12" cy="12" r="10"/></svg>' : isWinner ? '<span class="flex-shrink-0 text-verde font-display text-sm font-700">✓</span>' : ''}
                  <span class="font-medium text-[15px] truncate">${escapeHTML(opt.texto)}</span>
                </span>
                <span class="flex items-center gap-2 flex-shrink-0">
                  <span class="flex">${avatars}</span>
                  <span class="text-sm font-semibold tabular-nums ${isWinner ? 'text-verde' : 'text-ink'}">${c}</span>
                </span>
              </span>
            </button>
          `;
        }).join('')}
      </div>

      <div class="mt-5 pt-5 border-t border-border">
        <p class="text-xs font-semibold text-muted uppercase tracking-widest mb-3">
          ${totalVotos === USERS.length ? 'Todos votaram' : `Aguardando ${naoVotaram.length}`}
        </p>
        <div class="flex flex-wrap gap-1.5">
          ${naoVotaram.length === 0
            ? '<span class="text-sm text-verde">✓ coordenação inteira deu retorno</span>'
            : naoVotaram.map(u => `
              <span class="inline-flex items-center gap-1.5 bg-cream border border-border rounded-full pl-0.5 pr-2.5 py-0.5">
                ${avatarHTML(u.id, 22)}
                <span class="text-xs font-medium text-ink/80">${escapeHTML(u.name)}</span>
              </span>
            `).join('')
          }
        </div>
      </div>

      ${ehCriador ? `
        <div class="mt-6 pt-5 border-t border-border flex gap-2">
          <button id="edit-btn" class="flex-1 py-3 rounded-xl border border-border text-sm font-medium hover:bg-cream transition-colors flex items-center justify-center gap-2">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5Z"/></svg>
            Editar
          </button>
          <button id="delete-btn" class="flex-1 py-3 rounded-xl border border-vermelho/30 text-vermelho text-sm font-medium hover:bg-vermelho-bg transition-colors flex items-center justify-center gap-2">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
            Excluir
          </button>
        </div>
      ` : ''}
    </div>
  `);

  if (!encerrada) {
    $$('.vote-option').forEach(btn => {
      btn.onclick = async () => {
        const optId = btn.dataset.opt;
        await voteOn(d.id, optId);
      };
    });
  }
  if (ehCriador) {
    $('#edit-btn').onclick = () => { closeModal(); openDemandaForm(d); };
    $('#delete-btn').onclick = () => {
      closeModal();
      confirmAction('Excluir essa demanda?', 'Isso não pode ser desfeito. Todos os votos serão perdidos.', async () => {
        await deleteDoc(doc(db, 'demandas', d.id));
        showToast('Demanda excluída.');
      }, 'Excluir');
    };
  }
}

async function voteOn(demandaId, optionId) {
  // Atualização otimista local — re-renderiza o sheet na hora com o voto novo.
  const d = demandas.find(x => x.id === demandaId);
  if (d) {
    d.votos = { ...(d.votos || {}), [currentUser.id]: optionId };
    closeModal();
    openDemandaDetail(demandaId);
    renderFeed();
  }
  showToast('Voto registrado.');
  try {
    await updateDoc(doc(db, 'demandas', demandaId), {
      [`votos.${currentUser.id}`]: optionId
    });
  } catch (err) {
    console.error(err);
    showToast('Erro ao salvar voto.');
  }
}

// ======================================================================
// FORM: criar ou editar demanda
// ======================================================================
function openDemandaForm(existing = null) {
  const edit = !!existing;
  const defaultPrazo = (() => {
    const d = new Date();
    d.setDate(d.getDate() + 3);
    d.setHours(20, 0, 0, 0);
    return d.toISOString().slice(0, 16);
  })();

  const prazoStr = edit
    ? new Date(existing.prazo.toMillis()).toISOString().slice(0, 16)
    : defaultPrazo;

  const opcoesIniciais = edit
    ? existing.opcoes
    : [{ id: 'opt_1', texto: '' }, { id: 'opt_2', texto: '' }];

  openSheet(`
    <div class="flex items-center justify-between px-5 pt-5 mb-4">
      <div>
        <p class="text-[10px] font-semibold text-muted uppercase tracking-[0.18em]">${edit ? 'Editar' : 'Nova'}</p>
        <h2 class="font-display text-2xl font-600">${edit ? 'Ajustar demanda' : 'Cadastrar demanda'}</h2>
      </div>
      <button class="modal-close w-9 h-9 rounded-full flex items-center justify-center hover:bg-cream">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg>
      </button>
    </div>

    <form id="demanda-form" class="px-5 pb-5 space-y-4">
      <div>
        <label class="text-xs font-semibold text-muted uppercase tracking-widest">Título</label>
        <input id="f-titulo" type="text" maxlength="120" required placeholder="Sobre o quê é?" value="${edit ? escapeHTML(existing.titulo) : ''}" class="w-full mt-1.5 px-4 py-3 rounded-xl border border-border bg-paper focus:border-ink text-[16px]" />
      </div>
      <div>
        <label class="text-xs font-semibold text-muted uppercase tracking-widest">Contexto <span class="text-muted/60 font-normal normal-case tracking-normal">(opcional)</span></label>
        <textarea id="f-desc" rows="3" maxlength="800" placeholder="Ajude o grupo a entender rápido..." class="w-full mt-1.5 px-4 py-3 rounded-xl border border-border bg-paper focus:border-ink text-[15px] resize-none">${edit ? escapeHTML(existing.descricao || '') : ''}</textarea>
      </div>
      <div>
        <label class="text-xs font-semibold text-muted uppercase tracking-widest">Prazo</label>
        <input id="f-prazo" type="datetime-local" required value="${prazoStr}" class="w-full mt-1.5 px-4 py-3 rounded-xl border border-border bg-paper focus:border-ink text-[16px]" />
        <p class="text-xs text-muted mt-1.5">A demanda encerra sozinha nesse momento.</p>
      </div>

      <div>
        <label class="text-xs font-semibold text-muted uppercase tracking-widest">Opções de voto</label>
        <div id="opcoes-list" class="mt-2 space-y-2"></div>
        <button type="button" id="add-opt-btn" class="mt-2.5 text-sm text-brand font-semibold flex items-center gap-1.5 hover:text-ink transition-colors">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14"/></svg>
          Adicionar opção
        </button>
      </div>

      ${edit && Object.keys(existing.votos || {}).length > 0 ? `
        <div class="bg-amarelo-bg/70 border border-amarelo/30 rounded-xl p-3 text-xs text-amarelo leading-relaxed">
          <strong>Atenção:</strong> se você alterar as <em>opções</em>, os votos já dados serão zerados.
        </div>
      ` : ''}

      <button type="submit" class="w-full bg-ink text-cream font-medium py-4 rounded-2xl text-sm tracking-wide active:scale-[0.99] transition-transform">
        ${edit ? 'Salvar alterações' : 'Cadastrar demanda'}
      </button>
    </form>
  `);

  const state = { opcoes: opcoesIniciais.map(o => ({ ...o })) };
  renderOpcoes();

  $('#add-opt-btn').onclick = () => {
    if (state.opcoes.length >= 8) {
      showToast('Máximo 8 opções.'); return;
    }
    state.opcoes.push({ id: 'opt_' + Date.now() + '_' + Math.random().toString(36).slice(2,6), texto: '' });
    renderOpcoes();
  };

  $('#demanda-form').onsubmit = async (e) => {
    e.preventDefault();
    const titulo = $('#f-titulo').value.trim();
    const descricao = $('#f-desc').value.trim();
    const prazoInput = $('#f-prazo').value;
    const opcoesValidas = state.opcoes.map(o => ({ id: o.id, texto: o.texto.trim() })).filter(o => o.texto);
    if (!titulo) return showToast('Informe um título.');
    if (!prazoInput) return showToast('Informe um prazo.');
    if (opcoesValidas.length < 2) return showToast('Pelo menos 2 opções com texto.');
    const prazoDate = new Date(prazoInput);
    if (isNaN(prazoDate)) return showToast('Prazo inválido.');

    const submit = e.target.querySelector('button[type="submit"]');
    submit.disabled = true;
    submit.textContent = 'Salvando...';

    try {
      if (edit) {
        const optsChanged = JSON.stringify(existing.opcoes) !== JSON.stringify(opcoesValidas);
        const patch = {
          titulo, descricao,
          prazo: Timestamp.fromDate(prazoDate),
          opcoes: opcoesValidas,
        };
        if (optsChanged) patch.votos = {};
        await updateDoc(doc(db, 'demandas', existing.id), patch);
        closeModal();
        showToast('Alterações salvas.');
      } else {
        await addDoc(collection(db, 'demandas'), {
          titulo, descricao,
          criadoPorId: currentUser.id,
          criadoPorNome: currentUser.name,
          criadoEm: serverTimestamp(),
          prazo: Timestamp.fromDate(prazoDate),
          opcoes: opcoesValidas,
          votos: {},
        });
        closeModal();
        showToast('Demanda cadastrada.');
      }
    } catch (err) {
      console.error(err);
      submit.disabled = false;
      submit.textContent = edit ? 'Salvar alterações' : 'Cadastrar demanda';
      showToast('Erro ao salvar.');
    }
  };

  function renderOpcoes() {
    $('#opcoes-list').innerHTML = state.opcoes.map((o, idx) => `
      <div class="flex items-center gap-2" data-opt-row="${idx}">
        <span class="w-7 h-7 rounded-lg bg-cream border border-border flex items-center justify-center text-xs font-semibold font-display text-muted flex-shrink-0">${idx+1}</span>
        <input type="text" maxlength="80" placeholder="Ex: Aprovar / Adiar / Rejeitar" value="${escapeHTML(o.texto)}" class="flex-1 px-3 py-2.5 rounded-xl border border-border bg-paper focus:border-ink text-[15px]" data-opt-input="${idx}" />
        ${state.opcoes.length > 2 ? `
          <button type="button" class="w-9 h-9 rounded-lg hover:bg-vermelho-bg text-muted hover:text-vermelho flex items-center justify-center transition-colors flex-shrink-0" data-opt-remove="${idx}">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg>
          </button>
        ` : ''}
      </div>
    `).join('');
    $$('#opcoes-list [data-opt-input]').forEach(inp => {
      inp.oninput = (e) => { state.opcoes[+inp.dataset.optInput].texto = e.target.value; };
    });
    $$('#opcoes-list [data-opt-remove]').forEach(btn => {
      btn.onclick = () => {
        state.opcoes.splice(+btn.dataset.optRemove, 1);
        renderOpcoes();
      };
    });
  }
}

// ======================================================================
// CONFIRMAR AÇÃO
// ======================================================================
function confirmAction(title, message, onConfirm, confirmLabel = 'Confirmar') {
  openModal(`
    <div class="bg-paper rounded-3xl p-6 max-w-sm w-full mx-auto anim-scale-in">
      <h3 class="font-display text-xl font-600 mb-1">${escapeHTML(title)}</h3>
      <p class="text-sm text-muted leading-relaxed mb-5">${escapeHTML(message)}</p>
      <div class="flex gap-2">
        <button class="modal-close flex-1 py-3 rounded-xl border border-border text-sm font-medium">Cancelar</button>
        <button id="confirm-ok" class="flex-1 py-3 rounded-xl bg-vermelho text-cream text-sm font-medium">${escapeHTML(confirmLabel)}</button>
      </div>
    </div>
  `);
  $('#confirm-ok').onclick = async () => { closeModal(); await onConfirm(); };
}

// ======================================================================
// MODAL / SHEET
// ======================================================================
function openModal(innerHTML) {
  const root = $('#modal-root');
  root.classList.remove('hidden');
  root.innerHTML = `
    <div class="absolute inset-0 bg-ink/40 anim-fade-in" data-backdrop></div>
    <div class="absolute inset-0 flex items-center justify-center p-4 overflow-y-auto">
      ${innerHTML}
    </div>
  `;
  root.querySelectorAll('[data-backdrop], .modal-close').forEach(el =>
    el.addEventListener('click', closeModal));
}

function openSheet(innerHTML) {
  const root = $('#modal-root');
  root.classList.remove('hidden');
  root.innerHTML = `
    <div class="absolute inset-0 bg-ink/40 anim-fade-in" data-backdrop></div>
    <div class="absolute inset-x-0 bottom-0 md:top-0 md:flex md:items-center md:justify-center md:p-4 overflow-y-auto max-h-screen">
      <div class="bg-paper rounded-t-3xl md:rounded-3xl w-full md:max-w-xl max-h-[92vh] overflow-y-auto anim-slide-up md:anim-scale-in safe-bottom">
        ${innerHTML}
      </div>
    </div>
  `;
  root.querySelectorAll('[data-backdrop], .modal-close').forEach(el =>
    el.addEventListener('click', closeModal));
}

function closeModal() {
  const root = $('#modal-root');
  root.classList.add('hidden');
  root.innerHTML = '';
}

// ======================================================================
// BOOT
// ======================================================================
wireLoginInputs();
init();
