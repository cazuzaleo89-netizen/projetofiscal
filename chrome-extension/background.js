/**
 * Painel Fiscal — Background Service Worker v2.0
 * Gerencia: sessões, banco de erros, repetição espaçada SM-2,
 * relay de mensagens TEC↔Painel, badge e notificações.
 */

const PANEL_URL_PATTERN = 'https://cazuzaleo89-netizen.github.io/projetofiscal/*';

// ════════════════════════════════════════════════════════
// ESTADO EM MEMÓRIA
// ════════════════════════════════════════════════════════

let panelTabId  = null;
let tecTabId    = null;
let filaCount   = 0;
let activeSession = null;  // sessão corrente (não persistida ainda)

// ════════════════════════════════════════════════════════
// CRONÔMETRO (gerenciado no background para persistir entre navegações)
// ════════════════════════════════════════════════════════

const timer = {
  startTime: null,   // Date.now() quando foi ligado/retomado
  elapsed: 0,        // segundos acumulados (pausa incluída)
  running: false,
};

function timerGetElapsed() {
  if (!timer.running || !timer.startTime) return timer.elapsed;
  return timer.elapsed + Math.floor((Date.now() - timer.startTime) / 1000);
}

function timerStart() {
  if (timer.running) return;
  timer.startTime = Date.now();
  timer.running   = true;
}

function timerPause() {
  if (!timer.running) return;
  timer.elapsed   = timerGetElapsed();
  timer.startTime = null;
  timer.running   = false;
}

function timerReset() {
  timer.startTime = null;
  timer.elapsed   = 0;
  timer.running   = false;
}

function timerSnapshot() {
  return { elapsed: timerGetElapsed(), running: timer.running };
}

// ════════════════════════════════════════════════════════
// ALGORITMO SM-2 (Repetição Espaçada)
// ════════════════════════════════════════════════════════

function sm2Update(item, quality) {
  // quality: 0=apagão total, 3=correto com esforço, 5=perfeito
  let { repetitions = 0, easeFactor = 2.5, interval = 1 } = item;

  if (quality >= 3) {
    if (repetitions === 0)      interval = 1;
    else if (repetitions === 1) interval = 6;
    else                        interval = Math.round(interval * easeFactor);
    repetitions++;
  } else {
    repetitions = 0;
    interval    = 1;
  }

  easeFactor = Math.max(1.3, easeFactor + 0.1 - (5 - quality) * (0.08 + (5 - quality) * 0.02));

  const nextReview = new Date();
  nextReview.setDate(nextReview.getDate() + interval);

  return {
    repetitions,
    easeFactor: parseFloat(easeFactor.toFixed(2)),
    interval,
    nextReview: nextReview.toISOString().split('T')[0],
  };
}

// ════════════════════════════════════════════════════════
// STORAGE — LEITURA / ESCRITA
// ════════════════════════════════════════════════════════

async function getStorage(keys) {
  return new Promise(resolve => chrome.storage.local.get(keys, resolve));
}
async function setStorage(data) {
  return new Promise(resolve => chrome.storage.local.set(data, resolve));
}

function todayKey() {
  return new Date().toISOString().split('T')[0]; // YYYY-MM-DD
}

// ── Estatísticas globais ──────────────────────────────────────────────────────

async function loadStats() {
  const { globalStats } = await getStorage({ globalStats: { totalResolved: 0, totalAcertos: 0, totalErros: 0, streak: 0, lastStudyDate: '', dailyGoal: 30 } });
  return globalStats;
}

async function updateGlobalStats(acertos, erros) {
  const stats = await loadStats();
  stats.totalResolved += acertos + erros;
  stats.totalAcertos  += acertos;
  stats.totalErros    += erros;

  const today = todayKey();
  if (stats.lastStudyDate !== today) {
    const yesterday = new Date(); yesterday.setDate(yesterday.getDate() - 1);
    const yKey = yesterday.toISOString().split('T')[0];
    stats.streak = stats.lastStudyDate === yKey ? stats.streak + 1 : 1;
    stats.lastStudyDate = today;
  }

  await setStorage({ globalStats: stats });
  return stats;
}

// ── Stats de hoje ─────────────────────────────────────────────────────────────

async function updateTodayStats(delta) {
  const key = 'today_' + todayKey();
  const stored = await getStorage({ [key]: { date: todayKey(), resolved: 0, acertos: 0, erros: 0 } });
  const today = stored[key];
  today.resolved += (delta.acertos || 0) + (delta.erros || 0);
  today.acertos  += delta.acertos || 0;
  today.erros    += delta.erros   || 0;
  await setStorage({ [key]: today });
  return today;
}

async function getTodayStats() {
  const key = 'today_' + todayKey();
  const stored = await getStorage({ [key]: { date: todayKey(), resolved: 0, acertos: 0, erros: 0 } });
  return stored[key];
}

// ── Banco de questões erradas ─────────────────────────────────────────────────

async function loadWrongBank() {
  const { wrongBank } = await getStorage({ wrongBank: {} });
  return wrongBank;
}

async function addToWrongBank(payload) {
  if (!payload.qid) return;
  const bank = await loadWrongBank();
  const today = todayKey();

  if (bank[payload.qid]) {
    bank[payload.qid].errorCount  = (bank[payload.qid].errorCount || 1) + 1;
    bank[payload.qid].lastError   = today;
    bank[payload.qid].nextReview  = today;   // volta para revisão imediata ao errar de novo
    // Atualiza metadados se vieram desta vez
    if (payload.materia)     bank[payload.qid].materia     = payload.materia;
    if (payload.assunto)     bank[payload.qid].assunto     = payload.assunto;
    if (payload.desc)        bank[payload.qid].desc        = payload.desc;
    if (payload.dificuldade) bank[payload.qid].dificuldade = payload.dificuldade;
  } else {
    bank[payload.qid] = {
      qid:         payload.qid,
      url:         payload.url         || '',
      materia:     payload.materia     || '',
      assunto:     payload.assunto     || '',
      desc:        payload.desc        || 'Questão #' + payload.qid,
      dificuldade: payload.dificuldade || '',
      errorCount:  1,
      firstError:  today,
      lastError:   today,
      nextReview:  today,   // aparece IMEDIATAMENTE na fila de revisão
      interval:    1,
      repetitions: 0,
      easeFactor:  2.5,
    };
  }

  await setStorage({ wrongBank: bank });
  return bank;
}

async function reviewWrongQuestion(qid, quality) {
  const bank = await loadWrongBank();
  if (!bank[qid]) return;
  const updated = sm2Update(bank[qid], quality);
  Object.assign(bank[qid], updated);

  if (quality >= 4 && bank[qid].repetitions >= 3) {
    // Questão dominada — remove do banco de erros
    delete bank[qid];
  }

  await setStorage({ wrongBank: bank });
  return bank;
}

async function getDueReviews() {
  const bank = await loadWrongBank();
  const today = todayKey();
  return Object.values(bank)
    .filter(q => q.nextReview <= today)
    .sort((a, b) => {
      // Prioridade: mais erros primeiro, depois mais antiga
      if (b.errorCount !== a.errorCount) return b.errorCount - a.errorCount;
      return a.nextReview.localeCompare(b.nextReview);
    });
}

// ── Histórico de sessões ──────────────────────────────────────────────────────

async function saveSessions(session) {
  if (!session) return;
  const { sessions = [] } = await getStorage({ sessions: [] });
  sessions.unshift(session); // mais recente primeiro
  if (sessions.length > 100) sessions.length = 100; // limite
  await setStorage({ sessions });
}

async function getSessions(limit = 20) {
  const { sessions = [] } = await getStorage({ sessions: [] });
  return sessions.slice(0, limit);
}

// ── Stats por matéria ─────────────────────────────────────────────────────────

async function updateSubjectStats(materia, acertos, erros) {
  if (!materia) return;
  const { subjectStats = {} } = await getStorage({ subjectStats: {} });
  if (!subjectStats[materia]) subjectStats[materia] = { materia, acertos: 0, erros: 0, total: 0 };
  subjectStats[materia].acertos += acertos;
  subjectStats[materia].erros   += erros;
  subjectStats[materia].total   += acertos + erros;
  await setStorage({ subjectStats });
}

async function getSubjectStats() {
  const { subjectStats = {} } = await getStorage({ subjectStats: {} });
  return Object.values(subjectStats).sort((a, b) => b.total - a.total);
}

// ── Configurações ─────────────────────────────────────────────────────────────

async function getSettings() {
  const { settings } = await getStorage({ settings: { dailyGoal: 30, notifications: true, reviewAlgo: 'sm2' } });
  return settings;
}

// ════════════════════════════════════════════════════════
// BADGE
// ════════════════════════════════════════════════════════

function updateBadge(count) {
  filaCount = count || 0;
  if (filaCount > 0) {
    chrome.action.setBadgeText({ text: String(filaCount) });
    chrome.action.setBadgeBackgroundColor({ color: '#ef4444' });
  } else {
    chrome.action.setBadgeText({ text: '' });
  }
}

// ════════════════════════════════════════════════════════
// NOTIFICAÇÕES
// ════════════════════════════════════════════════════════

function showNotification(title, message, id) {
  chrome.notifications.create(id || 'pf-' + Date.now(), {
    type: 'basic', iconUrl: 'icons/icon48.png',
    title: title || 'Painel Fiscal',
    message: message || '', priority: 1,
  });
}

async function checkDailyGoal(todayStats) {
  const settings = await getSettings();
  const goal = settings.dailyGoal || 30;
  if (todayStats.resolved === goal) {
    showNotification('🎯 Meta atingida!', `Você resolveu ${goal} questões hoje. Parabéns!`, 'pf-goal');
  }
}

// ════════════════════════════════════════════════════════
// RELAY TEC ↔ PAINEL
// ════════════════════════════════════════════════════════

async function findPanelTab() {
  const tabs = await chrome.tabs.query({ url: PANEL_URL_PATTERN });
  return tabs.length ? tabs[0] : null;
}
async function findTecTab() {
  const tabs = await chrome.tabs.query({ url: '*://www.tecconcursos.com.br/*' });
  return tabs.length ? tabs[0] : null;
}

async function relayToPanel(payload) {
  const tab = await findPanelTab();
  if (!tab) return;
  panelTabId = tab.id;
  try {
    await chrome.tabs.sendMessage(panelTabId, { type: 'FROM_TEC', payload });
  } catch {
    try {
      await chrome.scripting.executeScript({
        target: { tabId: panelTabId },
        func: p => window.dispatchEvent(new MessageEvent('message', { data: p })),
        args: [payload],
      });
    } catch { /* */ }
  }
}

async function relayToTec(payload) {
  const tab = tecTabId ? { id: tecTabId } : await findTecTab();
  if (!tab) return;
  tecTabId = tab.id;
  try {
    await chrome.tabs.sendMessage(tecTabId, { type: 'FROM_PANEL', payload });
  } catch {
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tecTabId },
        func: p => window.dispatchEvent(new MessageEvent('message', { data: p })),
        args: [payload],
      });
    } catch { /* */ }
  }
}

// ════════════════════════════════════════════════════════
// HANDLERS DE MENSAGEM
// ════════════════════════════════════════════════════════

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return;

  (async () => {
    switch (msg.type) {

      // ── Ciclo de vida do content script ────────────────────────────────────
      case 'CONTENT_READY':
        tecTabId = sender.tab ? sender.tab.id : null;
        break;

      // ── Questão correta ────────────────────────────────────────────────────
      case 'QUESTION_CORRECT': {
        const payload = msg.payload || {};
        const today = await updateTodayStats({ acertos: 1 });
        if (payload.materia) await updateSubjectStats(payload.materia, 1, 0);
        await checkDailyGoal(today);
        // Atualiza sessão ativa
        if (activeSession) {
          activeSession.acertos = (activeSession.acertos || 0) + 1;
          activeSession.questions = activeSession.questions || [];
          activeSession.questions.push({ ...payload, result: 'correct' });
        }
        break;
      }

      // ── Questão errada ─────────────────────────────────────────────────────
      case 'QUESTION_WRONG': {
        const payload = msg.payload || {};
        const today = await updateTodayStats({ erros: 1 });
        if (payload.materia) await updateSubjectStats(payload.materia, 0, 1);
        await addToWrongBank(payload);
        // Badge = total de revisões devidas (nextReview <= hoje inclui a que acabou de errar)
        const due = await getDueReviews();
        updateBadge(due.length);
        if (activeSession) {
          activeSession.erros = (activeSession.erros || 0) + 1;
          activeSession.questions = activeSession.questions || [];
          activeSession.questions.push({ ...payload, result: 'wrong' });
        }
        break;
      }

      // ── Início de sessão ───────────────────────────────────────────────────
      case 'SESSION_START': {
        const payload = msg.payload || {};
        activeSession = {
          id:        Date.now().toString(),
          date:      todayKey(),
          startTime: Date.now(),
          caderno:   payload.caderno  || '',
          materia:   payload.materia  || '',
          totalQ:    payload.totalQ   || 0,
          acertos:   0,
          erros:     0,
          questions: [],
        };
        // Auto-inicia cronômetro ao começar sessão
        if (!timer.running) timerStart();
        break;
      }

      // ── Fim de sessão (caderno concluído) ──────────────────────────────────
      case 'SESSION_END': {
        const payload = msg.payload || {};
        if (activeSession) {
          activeSession.endTime  = Date.now();
          activeSession.elapsed  = timerGetElapsed();
          if (payload.stats) {
            activeSession.acertos = payload.stats.correct || activeSession.acertos;
            activeSession.erros   = payload.stats.wrong   || activeSession.erros;
          }
          await saveSessions({ ...activeSession });
          await updateGlobalStats(activeSession.acertos, activeSession.erros);
          timerReset();
          activeSession = null;
        }
        break;
      }

      // ── Cronômetro: controles ──────────────────────────────────────────────
      case 'TIMER_START':
        timerStart();
        sendResponse(timerSnapshot());
        return;

      case 'TIMER_PAUSE':
        timerPause();
        sendResponse(timerSnapshot());
        return;

      case 'TIMER_RESET':
        timerReset();
        sendResponse(timerSnapshot());
        return;

      case 'TIMER_GET':
        sendResponse(timerSnapshot());
        return;

      // ── Badge ──────────────────────────────────────────────────────────────
      case 'UPDATE_BADGE':
        updateBadge(msg.filaCount || 0);
        break;

      // ── Relay TEC → Painel ─────────────────────────────────────────────────
      case 'RELAY_TO_PANEL':
        await relayToPanel(msg.payload);
        break;

      // ── Relay Painel → TEC ─────────────────────────────────────────────────
      case 'RELAY_TO_TEC':
        await relayToTec(msg.payload);
        break;

      // ── Notificação desktop ────────────────────────────────────────────────
      case 'SHOW_NOTIFICATION':
        showNotification(msg.title, msg.message, msg.id);
        break;

      // ── Popup: solicita dados completos ────────────────────────────────────
      case 'GET_POPUP_DATA': {
        const [todayStats, globalStats, wrongBank, sessions, subjectStats, settings, dueReviews] = await Promise.all([
          getTodayStats(),
          loadStats(),
          loadWrongBank(),
          getSessions(20),
          getSubjectStats(),
          getSettings(),
          getDueReviews(),
        ]);
        sendResponse({
          todayStats,
          globalStats,
          wrongBankSize: Object.keys(wrongBank).length,
          sessions,
          subjectStats,
          settings,
          dueReviews,
          filaCount,
          panelTabId,
          tecTabId,
          activeSession,
          timer: timerSnapshot(),
        });
        return;
      }

      // ── Popup: marca questão como revisada ────────────────────────────────
      case 'REVIEW_QUESTION': {
        await reviewWrongQuestion(msg.qid, msg.quality || 4);
        const due = await getDueReviews();
        updateBadge(due.length);
        sendResponse({ ok: true, dueReviews: due });
        return;
      }

      // ── Popup: exporta banco de erros ─────────────────────────────────────
      case 'EXPORT_WRONG': {
        const bank = await loadWrongBank();
        sendResponse({ bank: Object.values(bank) });
        return;
      }

      // ── Popup: salva configurações ────────────────────────────────────────
      case 'SAVE_SETTINGS':
        await setStorage({ settings: msg.settings });
        sendResponse({ ok: true });
        return;

      // ── Status geral ──────────────────────────────────────────────────────
      case 'GET_STATUS':
        sendResponse({ filaCount, panelTabId, tecTabId });
        return;

      // ── Fila para o content script ────────────────────────────────────────
      case 'GET_FILA': {
        const due = await getDueReviews();
        updateBadge(due.length);
        break;
      }
    }
  })();

  return true; // mantém canal aberto para sendResponse assíncrono
});

// ════════════════════════════════════════════════════════
// EVENTOS DE ABAS
// ════════════════════════════════════════════════════════

chrome.tabs.onRemoved.addListener(tabId => {
  if (tabId === tecTabId)   tecTabId   = null;
  if (tabId === panelTabId) panelTabId = null;
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete' || !tab.url) return;
  if (tab.url.includes('tecconcursos.com.br'))               tecTabId   = tabId;
  if (tab.url.includes('cazuzaleo89-netizen.github.io'))      panelTabId = tabId;
});

// ════════════════════════════════════════════════════════
// APÓS INSTALAR: injeta content.js em abas TEC abertas
// ════════════════════════════════════════════════════════

chrome.runtime.onInstalled.addListener(async () => {
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    if (tab.url && tab.url.includes('tecconcursos.com.br') && tab.id) {
      try {
        await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
        tecTabId = tab.id;
      } catch { /* */ }
    }
  }

  // Alarme diário para lembrete de revisão
  chrome.alarms.create('daily-review-check', { periodInMinutes: 60 });
});

// ════════════════════════════════════════════════════════
// ALARME DIÁRIO
// ════════════════════════════════════════════════════════

chrome.alarms.onAlarm.addListener(async alarm => {
  if (alarm.name !== 'daily-review-check') return;
  const due = await getDueReviews();
  updateBadge(due.length);
  if (due.length > 0) {
    const settings = await getSettings();
    if (settings.notifications !== false) {
      showNotification('📋 Revisões pendentes', `Você tem ${due.length} questão${due.length > 1 ? 'ões' : ''} para revisar hoje.`, 'pf-daily');
    }
  }
});

// ── Clique na notificação → foca aba TEC ──────────────────────────────────────
chrome.notifications.onClicked.addListener(async () => {
  const tab = tecTabId ? { id: tecTabId } : await findTecTab();
  if (!tab) return;
  chrome.tabs.update(tab.id, { active: true });
  const win = await chrome.windows.get(tab.windowId).catch(() => null);
  if (win) chrome.windows.update(win.id, { focused: true });
});
