/**
 * Painel Fiscal — Background Service Worker (MV3)
 * Relata mensagens entre content script (TEC) e painel (GitHub Pages).
 * Gerencia badge de revisões pendentes e notificações desktop.
 */

const PANEL_URL_PATTERN = 'https://cazuzaleo89-netizen.github.io/projetofiscal/*';
const PANEL_ORIGIN = 'https://cazuzaleo89-netizen.github.io';

// ── Estado em memória ────────────────────────────────────────────────────────
let panelTabId = null;
let tecTabId = null;
let filaCount = 0;

// ── Encontra tab do painel ───────────────────────────────────────────────────

async function findPanelTab() {
  const tabs = await chrome.tabs.query({ url: PANEL_URL_PATTERN });
  return tabs.length ? tabs[0] : null;
}

async function findTecTab() {
  const tabs = await chrome.tabs.query({ url: '*://www.tecconcursos.com.br/*' });
  return tabs.length ? tabs[0] : null;
}

// ── Badge ─────────────────────────────────────────────────────────────────────

function updateBadge(count) {
  filaCount = count;
  if (count > 0) {
    chrome.action.setBadgeText({ text: String(count) });
    chrome.action.setBadgeBackgroundColor({ color: '#ef4444' });
  } else {
    chrome.action.setBadgeText({ text: '' });
  }
}

// ── Notificação desktop ───────────────────────────────────────────────────────

function showNotification(title, message, id) {
  chrome.notifications.create(id || 'pf-notify', {
    type: 'basic',
    iconUrl: 'icons/icon48.png',
    title: title || 'Painel Fiscal',
    message: message || '',
    priority: 1
  });
}

// ── Mensagens do content script ───────────────────────────────────────────────

chrome.runtime.onMessage.addListener(async (msg, sender, sendResponse) => {
  if (!msg || !msg.type) return;

  switch (msg.type) {

    case 'CONTENT_READY':
      // Content script inicializou em aba TEC
      tecTabId = sender.tab ? sender.tab.id : null;
      break;

    case 'UPDATE_BADGE':
      updateBadge(msg.filaCount || 0);
      break;

    // Content script pede relay de mensagem para o painel
    case 'RELAY_TO_PANEL': {
      const panelTab = await findPanelTab();
      if (panelTab) {
        panelTabId = panelTab.id;
        try {
          await chrome.tabs.sendMessage(panelTabId, { type: 'FROM_TEC', payload: msg.payload });
        } catch (x) {
          // painel pode não ter content script — usa scripting.executeScript para postMessage
          try {
            await chrome.scripting.executeScript({
              target: { tabId: panelTabId },
              func: (payload) => { window.dispatchEvent(new MessageEvent('message', { data: payload })); },
              args: [msg.payload]
            });
          } catch (e) { /* */ }
        }
      }
      break;
    }

    // Painel pede relay de mensagem para aba TEC
    case 'RELAY_TO_TEC': {
      const tecTab = tecTabId ? { id: tecTabId } : await findTecTab();
      if (tecTab) {
        tecTabId = tecTab.id;
        try {
          await chrome.tabs.sendMessage(tecTabId, { type: 'FROM_PANEL', payload: msg.payload });
        } catch (x) {
          try {
            await chrome.scripting.executeScript({
              target: { tabId: tecTabId },
              func: (payload) => { window.dispatchEvent(new MessageEvent('message', { data: payload })); },
              args: [msg.payload]
            });
          } catch (e) { /* */ }
        }
      }
      break;
    }

    case 'SHOW_NOTIFICATION':
      showNotification(msg.title, msg.message, msg.id);
      break;

    case 'GET_STATUS':
      sendResponse({ filaCount, panelTabId, tecTabId });
      return true; // async response
  }
});

// ── Clique na notificação: foca aba TEC ──────────────────────────────────────

chrome.notifications.onClicked.addListener(async (notifId) => {
  const tecTab = tecTabId ? { id: tecTabId } : await findTecTab();
  if (tecTab) {
    chrome.tabs.update(tecTab.id, { active: true });
    const win = await chrome.windows.get(tecTab.windowId);
    chrome.windows.update(win.id, { focused: true });
  }
});

// ── Rastreia quando aba TEC fecha ─────────────────────────────────────────────

chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === tecTabId) tecTabId = null;
  if (tabId === panelTabId) panelTabId = null;
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && tab.url && tab.url.includes('tecconcursos.com.br')) {
    tecTabId = tabId;
  }
  if (changeInfo.status === 'complete' && tab.url && tab.url.includes('cazuzaleo89-netizen.github.io')) {
    panelTabId = tabId;
  }
});
