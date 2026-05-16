document.addEventListener('DOMContentLoaded', () => {

const PANEL_URL = 'https://cazuzaleo89-netizen.github.io/projetofiscal/';
const TEC_ORIGIN = 'tecconcursos.com.br';

// ── Dados carregados ────────────────────────────────────────────────────────
let appData = null;
let cfgSettings = { dailyGoal: 30, notifications: true, autoReveal: true };
let popTimerRunning = false;
let popTimerElapsed = 0;
let popTimerLocal = null;

// ── Cronômetro no popup ─────────────────────────────────────────────────────
function fmtTimer(secs) {
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  const pad = n => String(n).padStart(2, '0');
  return h > 0 ? `${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

function popTimerTick() {
  if (popTimerRunning) popTimerElapsed++;
  const val = document.getElementById('pop-timer-val');
  const dot = document.getElementById('pop-timer-dot');
  const tog = document.getElementById('pop-timer-tog');
  if (val) val.textContent = fmtTimer(popTimerElapsed);
  if (dot) { dot.style.background = popTimerRunning ? '#22c55e' : '#374151'; dot.style.boxShadow = popTimerRunning ? '0 0 6px #22c55e' : 'none'; }
  if (tog) tog.textContent = popTimerRunning ? '⏸' : '▶';
}

function initPopTimer(timerData) {
  if (!timerData) return;
  popTimerElapsed = timerData.elapsed || 0;
  popTimerRunning = !!timerData.running;
  if (popTimerLocal) clearInterval(popTimerLocal);
  popTimerLocal = setInterval(popTimerTick, 1000);
  popTimerTick();
}

function popTimerToggle() {
  const action = popTimerRunning ? 'TIMER_PAUSE' : 'TIMER_START';
  chrome.runtime.sendMessage({ type: action }, resp => {
    if (resp) { popTimerElapsed = resp.elapsed || 0; popTimerRunning = !!resp.running; popTimerTick(); }
  });
  popTimerRunning = !popTimerRunning;
  popTimerTick();
}

function popTimerReset() {
  if (!confirm('Zerar cronômetro?')) return;
  chrome.runtime.sendMessage({ type: 'TIMER_RESET' }, resp => {
    popTimerElapsed = 0; popTimerRunning = false; popTimerTick();
  });
}

// ── Abas ────────────────────────────────────────────────────────────────────
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById('panel-' + tab.dataset.tab).classList.add('active');
    if (tab.dataset.tab === 'revisao' && appData) renderRevisao(appData);
    if (tab.dataset.tab === 'historico' && appData) renderHistorico(appData);
  });
});

// ── Utilitários ─────────────────────────────────────────────────────────────
async function findTab(origin) {
  try {
    const all = await Promise.race([
      chrome.tabs.query({}),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 1000)),
    ]);
    return all.find(t => t.url && t.url.includes(origin)) || null;
  } catch { return null; }
}

async function pingContent(tabId) {
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve(null), 700);
    try {
      chrome.tabs.sendMessage(tabId, { type: 'PING' }, resp => {
        clearTimeout(timer);
        resolve(resp || null);
      });
    } catch { clearTimeout(timer); resolve(null); }
  });
}

function fmt(n) { return (n || 0).toString(); }
function pct(a, t) { return t > 0 ? Math.round(a / t * 100) : 0; }

function fmtDate(isoDate) {
  if (!isoDate) return '—';
  const [y, m, d] = isoDate.split('-');
  return `${d}/${m}/${y}`;
}

function fmtElapsed(secs) {
  if (!secs) return '—';
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function accColor(rate) {
  if (rate >= 70) return '#22c55e';
  if (rate >= 50) return '#f59e0b';
  return '#ef4444';
}

// ── Renderização: Hoje ──────────────────────────────────────────────────────
function renderHoje(data) {
  const today = data.todayStats || {};
  const global = data.globalStats || {};
  const goal = (data.settings || {}).dailyGoal || 30;

  // Streak
  document.getElementById('streak-badge').textContent = `🔥 ${global.streak || 0}d`;

  // Meta
  const resolved = today.resolved || 0;
  const goalPct = Math.min(100, Math.round(resolved / goal * 100));
  document.getElementById('goal-progress').textContent = `${resolved} / ${goal}`;
  document.getElementById('goal-fill').style.width = goalPct + '%';

  // Stats grid
  document.getElementById('d-resolved').textContent = fmt(resolved);
  document.getElementById('d-acertos').textContent  = fmt(today.acertos);
  document.getElementById('d-erros').textContent    = fmt(today.erros);

  // Taxa
  const taxa = pct(today.acertos || 0, resolved);
  const arc = document.getElementById('ring-arc');
  const circumf = 138.2;
  arc.style.strokeDashoffset = circumf - (circumf * taxa / 100);
  arc.style.stroke = accColor(taxa);
  document.getElementById('ring-pct').style.color = accColor(taxa);
  document.getElementById('ring-pct').textContent = resolved > 0 ? taxa + '%' : '—';
  document.getElementById('ring-sub').textContent = resolved > 0
    ? `${today.acertos || 0} acertos · ${today.erros || 0} erros hoje`
    : 'Resolva questões no TEC para começar a rastrear.';

  // Matérias
  const subjects = data.subjectStats || [];
  const subjList = document.getElementById('subj-list');
  if (!subjects.length) {
    subjList.innerHTML = '<div style="font-size:11px;color:#374151;text-align:center;padding:12px 0;">Nenhuma matéria registrada ainda.</div>';
  } else {
    const maxTotal = Math.max(...subjects.map(s => s.total));
    subjList.innerHTML = subjects.slice(0, 7).map(s => {
      const p = pct(s.acertos, s.total);
      return `<div class="subj-row">
        <span class="subj-name">${s.materia}</span>
        <div class="subj-bar"><div class="subj-bar-fill" style="width:${Math.round(s.total/maxTotal*100)}%;background:${accColor(p)};"></div></div>
        <span class="subj-pct" style="color:${accColor(p)}">${p}%</span>
      </div>`;
    }).join('');
  }
}

// ── Renderização: Revisão ───────────────────────────────────────────────────
function qCardHtml(q, sessionMode) {
  const today = new Date().toISOString().split('T')[0];
  const isDue  = !q.nextReview || q.nextReview <= today;
  const errBadge  = q.errorCount ? `<span class="badge err">✕ ${q.errorCount}x</span>` : '';
  const dateBadge = sessionMode
    ? `<span class="badge due-now">🔴 Esta sessão</span>`
    : isDue
      ? `<span class="badge due-now">⏰ Revisar hoje</span>`
      : `<span class="badge future">📅 ${fmtDate(q.nextReview)}</span>`;
  const difBadge = q.dificuldade ? `<span class="badge dif">${q.dificuldade}</span>` : '';
  const desc = (q.desc || 'Questão #' + q.qid).slice(0, 55);
  const url  = (q.url || '').replace(/'/g, "\\'");

  return `<div class="qcard ${isDue || sessionMode ? 'due' : ''}">
    <div class="qcard-top">
      <div class="qcard-icon wrong">✕</div>
      <div class="qcard-meta">
        <div class="qcard-mat">${q.materia || 'Matéria'}</div>
        <div class="qcard-desc" title="${q.desc || ''}">${desc}</div>
      </div>
    </div>
    <div class="qcard-badges">${errBadge}${dateBadge}${difBadge}</div>
    <div class="qcard-btns">
      <button class="qbtn review" data-action="open-question" data-url="${url}">📖 Abrir</button>
      <button class="qbtn acertei" data-action="mark-review" data-qid="${q.qid}" data-quality="4">✓ Acertei</button>
      <button class="qbtn errei" data-action="mark-review" data-qid="${q.qid}" data-quality="1">✕ Errei</button>
    </div>
  </div>`;
}

// ── Huberman helpers ─────────────────────────────────────────────────────────
function fmtRemaining(secs) {
  if (secs <= 0) return 'REVISAR AGORA';
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return m > 0 ? `${m}m ${String(s).padStart(2,'0')}s` : `${s}s`;
}

function renderHubSection(hubItems) {
  if (!hubItems || !hubItems.length) return '';

  const cards = hubItems.map(h => {
    const isDue  = h.isDue;
    const remaining = h.remaining || 0;
    const isCustom  = h.customMins != null;

    // Indicadores de fase
    const dots = [1, 2, 3].map(p => {
      let cls = 'hub-dot';
      if (p < h.phase)    cls += ' done';
      else if (p === h.phase) cls += isCustom ? ' custom' : ' active';
      return `<div class="${cls}"></div>`;
    }).join('');

    const phaseLabel = isCustom
      ? `Custom ${h.customMins}min`
      : `Fase ${h.phase} de 3 · ${[5,9,11][h.phase-1]}min`;

    const countdown = isDue
      ? `<span class="hub-countdown ready" data-hub-cd="${h.qid}">⚡ REVISAR AGORA</span>`
      : `<span class="hub-countdown waiting" data-hub-cd="${h.qid}">⏱ ${fmtRemaining(remaining)}</span>`;

    const url = (h.url || '').replace(/'/g, "\\'");
    const qid = h.qid;

    return `<div class="hub-card ${isDue ? 'due-now' : ''}">
      <div class="hub-phases">
        ${dots}
        <span class="hub-phase-lbl">${phaseLabel}</span>
      </div>
      ${h.materia ? `<div class="hub-mat">${h.materia}</div>` : ''}
      <div class="hub-desc" title="${h.desc || ''}">${(h.desc || 'Questão #' + qid).slice(0,52)}</div>
      ${countdown}
      <div class="hub-btns">
        <button class="hub-btn open" data-action="hub-open" data-url="${url}">📖 Abrir</button>
        <button class="hub-btn ok"   data-action="hub-correct" data-qid="${qid}">✓ Acertei</button>
        <button class="hub-btn fail" data-action="hub-wrong" data-qid="${qid}">✕ Errei</button>
        <button class="hub-btn dis"  data-action="hub-dismiss" data-qid="${qid}">–</button>
      </div>
    </div>`;
  }).join('');

  return `<div class="hub-section">
    <div class="hub-title">🧠 MÉTODO HUBERMAN — REVISÃO ATIVA</div>
    ${cards}
    <div class="hub-custom">
      <span class="hub-custom-lbl">Agendar em:</span>
      <input class="hub-custom-inp" type="number" id="hub-custom-mins" min="1" max="120" placeholder="min" value="15">
      <button class="hub-custom-btn" data-action="hub-add-custom">+ Agendar</button>
    </div>
  </div>`;
}

function renderRevisao(data) {
  const due     = data.dueReviews || [];
  const session = data.activeSession;

  // Erros da sessão atual (não duplicar com o banco de revisão)
  const dueQids = new Set(due.map(q => q.qid));
  const sessionErrors = session && session.questions
    ? session.questions.filter(q => q.result === 'wrong' && q.qid && !dueQids.has(q.qid))
    : [];

  const hubItems = data.hubQueue || [];
  const total = hubItems.length + due.length + sessionErrors.length;
  document.getElementById('due-count').textContent = total;

  if (total === 0) {
    document.getElementById('rev-list').innerHTML = `
      <div class="rev-empty">
        <div class="icon">🎉</div>
        <p>Nenhuma revisão pendente!<br>Continue resolvendo questões.</p>
      </div>`;
    return;
  }

  let html = '';

  // 1. Seção Huberman (prioridade máxima)
  html += renderHubSection(hubItems);

  // 2. Seção "Esta Sessão" — erros recentes
  if (sessionErrors.length > 0) {
    html += `<div style="font-size:10px;color:#ef4444;font-weight:700;letter-spacing:.8px;margin-bottom:7px;">🔴 DESTA SESSÃO</div>`;
    html += sessionErrors.map(q => qCardHtml(q, true)).join('');
  }

  // 3. Seção SM-2 agendadas
  if (due.length > 0) {
    if (hubItems.length > 0 || sessionErrors.length > 0) {
      html += `<div style="font-size:10px;color:#475569;font-weight:700;letter-spacing:.8px;margin:10px 0 7px;">📅 AGENDADAS (SM-2)</div>`;
    }
    html += due.map(q => qCardHtml(q, false)).join('');
  }

  document.getElementById('rev-list').innerHTML = html;
}

// ── Renderização: Histórico ─────────────────────────────────────────────────
function renderHistorico(data) {
  const sessions = data.sessions || [];
  if (!sessions.length) {
    document.getElementById('hist-list').innerHTML = `
      <div class="hist-empty">
        <div style="font-size:28px;margin-bottom:8px;">📋</div>
        <div style="font-size:12px;color:#64748b;">Nenhuma sessão registrada ainda.<br>Conclua um caderno no TEC para registrar.</div>
      </div>`;
    return;
  }

  document.getElementById('hist-list').innerHTML = sessions.map(s => {
    const taxa = pct(s.acertos || 0, (s.acertos || 0) + (s.erros || 0));
    const color = accColor(taxa);
    return `<div class="scard">
      <div class="scard-top">
        <span class="scard-date">📅 ${fmtDate(s.date)}</span>
        <span class="scard-acc" style="color:${color}">${taxa}%</span>
      </div>
      <div class="scard-name">${s.caderno || s.materia || 'Sessão TEC'}</div>
      <div class="scard-stats">
        <span class="sstat p">Total <span>${(s.acertos || 0) + (s.erros || 0)}</span></span>
        <span class="sstat g">Acertos <span>${s.acertos || 0}</span></span>
        <span class="sstat r">Erros <span>${s.erros || 0}</span></span>
        <span class="sstat">⏱ <span>${fmtElapsed(s.elapsed)}</span></span>
      </div>
    </div>`;
  }).join('');
}

// ── Renderização: Config ────────────────────────────────────────────────────
function renderConfig(data) {
  cfgSettings = data.settings || cfgSettings;
  document.getElementById('cfg-goal').value = cfgSettings.dailyGoal || 30;
  setToggle('notifications', cfgSettings.notifications !== false);
  setToggle('autoReveal', cfgSettings.autoReveal !== false);
}

function setToggle(id, on) {
  const el = document.getElementById('tog-' + id);
  if (el) el.className = 'toggle-sw' + (on ? ' on' : '');
}

function toggleSetting(id) {
  cfgSettings[id] = !cfgSettings[id];
  setToggle(id, cfgSettings[id]);
}

// ── Status bar ──────────────────────────────────────────────────────────────
async function updateStatusBar() {
  const dot = document.getElementById('s-dot');
  const txt = document.getElementById('s-txt');
  if (!dot || !txt) return;

  try {
    let tecTab = null;
    let pingData = null;

    tecTab = await findTab(TEC_ORIGIN); // already has internal try/catch + timeout
    if (tecTab) {
      try { pingData = await pingContent(tecTab.id); } catch { /* */ }
    }

    if (!tecTab) {
      dot.className = 's-dot warn';
      txt.textContent = 'TEC não está aberto — clique em TEC para abrir';
    } else if (!pingData) {
      dot.className = 's-dot warn';
      txt.innerHTML = '<strong>TEC detectado</strong> — recarregue a aba do TEC';
    } else {
      dot.className = 's-dot on';
      const { localAce = 0, localErr = 0 } = pingData.stats || {};
      const total = localAce + localErr;
      txt.innerHTML = total > 0
        ? `<strong>⚡ Ativo</strong> · ✓${localAce} ✕${localErr}`
        : `<strong>⚡ Monitor ativo</strong> — abra um caderno`;
    }
  } catch {
    dot.className = 's-dot warn';
    txt.textContent = 'Erro ao verificar conexão';
  }
}

// ── Load completo ───────────────────────────────────────────────────────────
async function loadAll() {
  try {
    appData = await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('timeout')), 2000);
      chrome.runtime.sendMessage({ type: 'GET_POPUP_DATA' }, r => {
        clearTimeout(t);
        if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
        else resolve(r || {});
      });
    });
  } catch {
    appData = { todayStats: {}, globalStats: {}, sessions: [], subjectStats: [], dueReviews: [], settings: {} };
  }

  try { renderHoje(appData); }     catch(e) { console.error('renderHoje', e); }
  try { renderRevisao(appData); }  catch(e) { console.error('renderRevisao', e); }
  try { renderHistorico(appData); }catch(e) { console.error('renderHistorico', e); }
  try { renderConfig(appData); }   catch(e) { console.error('renderConfig', e); }
  try { initPopTimer(appData.timer); } catch(e) { console.error('initPopTimer', e); }
  updateStatusBar(); // dispara async sem bloquear o resto do loadAll

  // Badge de revisões (banco + sessão atual)
  const due2    = (appData.dueReviews || []);
  const sess2   = appData.activeSession;
  const dueQids2 = new Set(due2.map(q => q.qid));
  const sessErr2 = sess2 && sess2.questions
    ? sess2.questions.filter(q => q.result === 'wrong' && q.qid && !dueQids2.has(q.qid))
    : [];
  const totalRev2 = due2.length + sessErr2.length;
  const revTabEl = document.querySelector('[data-tab="revisao"]');
  if (revTabEl) revTabEl.textContent = totalRev2 > 0 ? `REVISÃO (${totalRev2})` : 'REVISÃO';
}

// ── Ações ────────────────────────────────────────────────────────────────────
function openPanel() {
  findTab('cazuzaleo89-netizen.github.io').then(tab => {
    if (tab) chrome.tabs.update(tab.id, { active: true });
    else chrome.tabs.create({ url: PANEL_URL });
    window.close();
  });
}

function openTec() {
  findTab(TEC_ORIGIN).then(tab => {
    if (tab) chrome.tabs.update(tab.id, { active: true });
    else chrome.tabs.create({ url: 'https://www.tecconcursos.com.br' });
    window.close();
  });
}

function openQuestion(url) {
  if (!url) return;
  chrome.tabs.create({ url });
  window.close();
}

async function markReview(qid, quality) {
  if (!qid) return;
  await new Promise(resolve => {
    chrome.runtime.sendMessage({ type: 'REVIEW_QUESTION', qid, quality }, resolve);
  });
  await loadAll();
  // Volta pra aba revisão
  document.querySelector('[data-tab="revisao"]').click();
}

function saveConfig() {
  cfgSettings.dailyGoal = parseInt(document.getElementById('cfg-goal').value) || 30;
  chrome.runtime.sendMessage({ type: 'SAVE_SETTINGS', settings: cfgSettings }, () => {
    const btn = document.querySelector('.cfg-btn.primary');
    const orig = btn.textContent;
    btn.textContent = '✓ Salvo!';
    setTimeout(() => { btn.textContent = orig; }, 1500);
  });
}

async function exportWrong() {
  const r = await new Promise(resolve => chrome.runtime.sendMessage({ type: 'EXPORT_WRONG' }, resolve));
  if (!r || !r.bank) return;
  const blob = new Blob([JSON.stringify(r.bank, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = 'painel-fiscal-erros.json'; a.click();
  URL.revokeObjectURL(url);
}

async function exportCSV() {
  const r = await new Promise(resolve => chrome.runtime.sendMessage({ type: 'EXPORT_WRONG' }, resolve));
  if (!r || !r.bank) return;
  const header = 'QID,Matéria,Assunto,Erros,Última Erro,Próxima Revisão,URL';
  const rows = r.bank.map(q =>
    [q.qid, q.materia, q.assunto, q.errorCount, q.lastError, q.nextReview, q.url]
      .map(v => `"${(v || '').toString().replace(/"/g, '""')}"`)
      .join(',')
  );
  const csv = [header, ...rows].join('\n');
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = 'painel-fiscal-erros.csv'; a.click();
  URL.revokeObjectURL(url);
}

// ── Ações Huberman ────────────────────────────────────────────────────────────
function hubOpen(url) {
  if (!url) return;
  chrome.tabs.create({ url });
  window.close();
}

async function hubCorrect(qid) {
  await new Promise(resolve => chrome.runtime.sendMessage({ type: 'HUBERMAN_CORRECT', qid }, resolve));
  await softRefresh(true);
  document.querySelector('[data-tab="revisao"]').click();
}

async function hubWrong(qid) {
  await new Promise(resolve => chrome.runtime.sendMessage({ type: 'HUBERMAN_WRONG', qid }, resolve));
  await softRefresh(true);
  document.querySelector('[data-tab="revisao"]').click();
}

async function hubDismiss(qid) {
  await new Promise(resolve => chrome.runtime.sendMessage({ type: 'HUBERMAN_DISMISS', qid }, resolve));
  await softRefresh(true);
}

async function hubAddCustom() {
  const mins = parseInt(document.getElementById('hub-custom-mins').value) || 15;
  const data = appData || {};
  const hub  = (data.hubQueue || [])[0];
  if (!hub) { alert('Nenhuma questão Huberman na fila para agendar.'); return; }
  await new Promise(resolve => chrome.runtime.sendMessage({ type: 'HUBERMAN_CUSTOM', qid: hub.qid, mins }, resolve));
  await softRefresh(true);
}

function resetStats() {
  if (!confirm('⚠ Isso apagará TODOS os dados locais (sessões, erros, stats). Tem certeza?')) return;
  chrome.storage.local.clear(() => {
    loadAll();
    const btn = document.querySelector('.cfg-btn.danger');
    btn.textContent = '✓ Dados removidos';
    setTimeout(() => { btn.textContent = '🗑 Resetar estatísticas'; }, 2000);
  });
}

// ── Atualização em tempo real ────────────────────────────────────────────────
let _refreshBusy = false; // mutex: evita chamadas concorrentes do intervalo

// force=true: chamadas de ações do usuário sempre executam (ignora mutex)
async function softRefresh(force = false) {
  if (_refreshBusy && !force) return;
  if (!force) _refreshBusy = true;
  try {
    let fresh;
    try {
      fresh = await new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('timeout')), 1500);
        chrome.runtime.sendMessage({ type: 'GET_POPUP_DATA' }, r => {
          clearTimeout(t);
          if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
          else resolve(r || {});
        });
      });
    } catch { return; }

    appData = fresh;

    // Atualiza stats de hoje sem re-renderizar tudo
    const today = fresh.todayStats || {};
    const resolved = today.resolved || 0;
    const acertos  = today.acertos  || 0;
    const erros    = today.erros    || 0;
    const goal     = (fresh.settings || {}).dailyGoal || 30;
    const goalPct  = Math.min(100, Math.round(resolved / goal * 100));
    const taxa     = pct(acertos, resolved);

    setEl('d-resolved', fmt(resolved));
    setEl('d-acertos',  fmt(acertos));
    setEl('d-erros',    fmt(erros));
    setEl('goal-progress', `${resolved} / ${goal}`);
    setEl('ring-pct', resolved > 0 ? taxa + '%' : '—');
    setEl('ring-sub', resolved > 0
      ? `${acertos} acertos · ${erros} erros hoje`
      : 'Resolva questões no TEC para começar a rastrear.');

    const fill = document.getElementById('goal-fill');
    if (fill) fill.style.width = goalPct + '%';

    const arc = document.getElementById('ring-arc');
    if (arc) {
      arc.style.strokeDashoffset = 138.2 - (138.2 * taxa / 100);
      arc.style.stroke = accColor(taxa);
    }
    const ringPct = document.getElementById('ring-pct');
    if (ringPct) ringPct.style.color = accColor(taxa);

    // Atualiza streak
    const global = fresh.globalStats || {};
    setEl('streak-badge', `🔥 ${global.streak || 0}d`);

    // Conta revisões (Huberman + banco + sessão)
    const due = fresh.dueReviews || [];
    const hub = fresh.hubQueue   || [];
    const session = fresh.activeSession;
    const dueQids = new Set(due.map(q => q.qid));
    const sessionErr = session && session.questions
      ? session.questions.filter(q => q.result === 'wrong' && q.qid && !dueQids.has(q.qid))
      : [];
    const totalRev = hub.length + due.length + sessionErr.length;

    const revTab = document.querySelector('[data-tab="revisao"]');
    if (revTab) revTab.textContent = totalRev > 0 ? `REVISÃO (${totalRev})` : 'REVISÃO';

    // Atualiza só os contadores Huberman (sem reconstruir DOM)
    updateHubCountdowns(fresh.hubQueue || []);
  } finally {
    _refreshBusy = false;
  }
}

// Atualiza apenas os textos de contagem regressiva já existentes no DOM
// sem tocar nos botões — evita o congelamento por reconstrução de DOM
function updateHubCountdowns(hubItems) {
  hubItems.forEach(h => {
    const cd = document.querySelector(`[data-hub-cd="${h.qid}"]`);
    if (!cd) return;
    if (h.isDue) {
      cd.className = 'hub-countdown ready';
      cd.textContent = '⚡ REVISAR AGORA';
      const card = cd.closest('.hub-card');
      if (card && !card.classList.contains('due-now')) card.classList.add('due-now');
    } else {
      cd.className = 'hub-countdown waiting';
      cd.textContent = `⏱ ${fmtRemaining(h.remaining)}`;
    }
  });
}

function setEl(id, txt) {
  const el = document.getElementById(id);
  if (el && el.textContent !== txt) el.textContent = txt;
}

// ── Event listeners for static buttons ──────────────────────────────────────
document.getElementById('btn-tec').addEventListener('click', openTec);
document.getElementById('btn-panel').addEventListener('click', openPanel);
document.getElementById('pop-timer-tog').addEventListener('click', popTimerToggle);
document.getElementById('pop-timer-reset').addEventListener('click', popTimerReset);
document.getElementById('cfg-notifications').addEventListener('click', () => toggleSetting('notifications'));
document.getElementById('cfg-autoReveal').addEventListener('click', () => toggleSetting('autoReveal'));
document.getElementById('cfg-save').addEventListener('click', saveConfig);
document.getElementById('cfg-export-json').addEventListener('click', exportWrong);
document.getElementById('cfg-export-csv').addEventListener('click', exportCSV);
document.getElementById('cfg-reset').addEventListener('click', resetStats);

// ── Event delegation for dynamic buttons (hub cards and qcards) ──────────────
document.addEventListener('click', e => {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  const action = btn.dataset.action;
  const qid = btn.dataset.qid;
  const url = btn.dataset.url;
  const quality = btn.dataset.quality;
  switch (action) {
    case 'open-question': openQuestion(url); break;
    case 'mark-review': markReview(qid, parseInt(quality)); break;
    case 'hub-open': hubOpen(url); break;
    case 'hub-correct': hubCorrect(qid); break;
    case 'hub-wrong': hubWrong(qid); break;
    case 'hub-dismiss': hubDismiss(qid); break;
    case 'hub-add-custom': hubAddCustom(); break;
  }
});

// ── Inicializa ───────────────────────────────────────────────────────────────
loadAll();

// softRefresh: atualiza dados/stats (rápido, mutex garante 1 instância por vez)
const _refreshInterval = setInterval(softRefresh, 3000);

// updateStatusBar: usa chrome.tabs.query (mais lento, intervalo separado e maior)
const _statusInterval  = setInterval(updateStatusBar, 10000);

window.addEventListener('unload', () => {
  clearInterval(_refreshInterval);
  clearInterval(_statusInterval);
});

}); // end DOMContentLoaded
