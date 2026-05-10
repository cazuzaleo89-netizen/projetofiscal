/**
 * Painel Fiscal — Monitor TEC (Content Script)
 * Roda automaticamente em www.tecconcursos.com.br
 * Substitui o bookmarklet ⚡ — sem clique necessário.
 */

(function () {
  'use strict';

  // Evita dupla injeção caso a extensão seja atualizada
  if (window._pfExt) return;
  window._pfExt = true;

  const PANEL_URL = 'https://cazuzaleo89-netizen.github.io/projetofiscal/';

  // ── Estado local ──────────────────────────────────────────────────────────
  let _pfw = null;      // referência à aba/janela do painel
  let A = 0, E = 0;
  let _lastUrl = '';
  let _pfEndSent = false;
  let _pfMin = false;
  let _pfHiddenSince = 0;
  let _pfFila = [];
  let _pfStats = { elapsed: 0, acertos: 0, erros: 0, resolved: 0, running: false, paused: false, discName: '' };
  let el = null; // widget badge

  // ── Comunicação com painel ────────────────────────────────────────────────

  function findPanelWindow() {
    // Tenta via opener (usuário abriu TEC a partir do painel)
    if (window.opener && !window.opener.closed) return window.opener;
    // Tenta via nome de janela (bookmarklet legacy compat)
    try { const w = window.open('', '_pfPanel'); if (w && !w.closed && w !== window) return w; } catch (x) { /* */ }
    return null;
  }

  function send(result, qi) {
    const msg = { type: 'TEC_QUESTION', result };
    if (qi) Object.assign(msg, qi);
    // Tenta via janela salva
    if (_pfw && !_pfw.closed) {
      try { _pfw.postMessage(msg, '*'); return true; } catch (x) { /* */ }
    }
    // Refaz busca
    _pfw = findPanelWindow();
    if (_pfw && !_pfw.closed) {
      try { _pfw.postMessage(msg, '*'); return true; } catch (x) { /* */ }
    }
    // Fallback: background relay via extension messaging
    try { chrome.runtime.sendMessage({ type: 'RELAY_TO_PANEL', payload: msg }); return true; } catch (x) { /* */ }
    return false;
  }

  function sendRaw(msg) {
    if (_pfw && !_pfw.closed) {
      try { _pfw.postMessage(msg, '*'); return true; } catch (x) { /* */ }
    }
    _pfw = findPanelWindow();
    if (_pfw && !_pfw.closed) {
      try { _pfw.postMessage(msg, '*'); return true; } catch (x) { /* */ }
    }
    try { chrome.runtime.sendMessage({ type: 'RELAY_TO_PANEL', payload: msg }); return true; } catch (x) { /* */ }
    return false;
  }

  // ── Parsers ───────────────────────────────────────────────────────────────

  function parse() {
    const tx = document.body.innerText || '';
    let m = tx.match(/(\d+)\s+Acertos?\s+e\s+(\d+)\s+Erros?/i);
    if (!m) m = tx.match(/Acertos?[:\s]+(\d+)[^\d]+Erros?[:\s]+(\d+)/i);
    return m ? { a: parseInt(m[1]), e: parseInt(m[2]) } : null;
  }

  function getInfo() {
    const info = { url: '', desc: '', materia: '', assunto: '', qid: '', myTotal: 0, myErrors: 0 };
    const tx = document.body.innerText || '';

    // qid
    let urlPM = window.location.pathname.match(/\/questoes\/(\d{5,9})(?:\/|$)/);
    if (urlPM) { info.qid = urlPM[1]; info.url = 'https://www.tecconcursos.com.br/questoes/' + urlPM[1]; }
    if (!info.qid) {
      const links = document.querySelectorAll("a[href*='/questoes/']");
      for (let i = 0; i < links.length; i++) {
        const lm = links[i].href.match(/\/questoes\/(\d{5,9})/);
        if (lm) { info.qid = lm[1]; info.url = 'https://www.tecconcursos.com.br/questoes/' + lm[1]; break; }
      }
    }
    if (!info.qid) { const idM = tx.match(/#(\d{5,9})\b/); if (idM) { info.qid = idM[1]; info.url = 'https://www.tecconcursos.com.br/questoes/' + idM[1]; } }
    if (!info.qid) { const qnM = tx.match(/Quest[aã]o[\s#]+(\d{5,9})\b/i); if (qnM) { info.qid = qnM[1]; info.url = 'https://www.tecconcursos.com.br/questoes/' + qnM[1]; } }
    if (!info.url) info.url = window.location.href;

    // matéria / assunto
    const matM = tx.match(/Mat[eé]ria:\s*([^\n\r×]+)/i);
    if (matM) info.materia = matM[1].replace(/\s*[××].*$/, '').trim();
    const assM = tx.match(/Assunto:\s*([^\n\r×]+)/i);
    if (assM) info.assunto = assM[1].replace(/\s*[××].*$/, '').trim();

    const parts = [];
    if (info.materia) parts.push(info.materia);
    if (info.assunto) parts.push(info.assunto);
    info.desc = parts.join(' — ') || (info.qid ? 'Questão #' + info.qid : 'Questão');

    // Meu Desempenho
    const myResM = tx.match(/Total de resolu[çc][õo]es[:\s]+(\d+)/i);
    info.myTotal = myResM ? parseInt(myResM[1]) : 0;
    const myErrNumM = tx.match(/(\d+)\s*(?:erros?\b|[x×]\s*errou)/i) || tx.match(/errou[\s:]+(\d+)/i);
    if (myErrNumM) {
      info.myErrors = parseInt(myErrNumM[1]);
    } else {
      const myErrArr = tx.match(/\bErrou\b/gi);
      info.myErrors = myErrArr ? myErrArr.length : 0;
    }
    return info;
  }

  function sendSession() {
    const tx = document.body.innerText || '';
    const totM = tx.match(/Quest[aã]o\s+\d+\s+de\s+(\d+)/i);
    const total = totM ? parseInt(totM[1]) : 0;
    const matM = tx.match(/Mat[eé]ria:\s*([^\n\r×]+)/i);
    const materia = matM ? matM[1].replace(/\s*[××].*$/, '').trim() : '';
    const assM = tx.match(/Assunto:\s*([^\n\r×]+)/i);
    const assunto = assM ? assM[1].replace(/\s*[××].*$/, '').trim() : '';
    const caderno = document.title.replace(/\s*[|·\-]\s*TecConcursos.*$/i, '').trim() || materia;
    const sp = new URLSearchParams(window.location.search);
    send('session_info', { total, materia, assunto, caderno, cadernoBase: sp.get('cadernoBase') || '', idPasta: sp.get('idPasta') || '' });
  }

  function scanHistory() {
    const tx = document.body.innerText || '';
    if (!window.location.pathname.match(/\/questoes\/(\d{5,9})(?:\/|$)/)) return;
    const myResM = tx.match(/Total de resolu[çc][õo]es[:\s]+(\d+)/i);
    const myTotal = myResM ? parseInt(myResM[1]) : 0;
    let myErrors = 0;
    const myErrArr = tx.match(/\bErrou\b/gi);
    myErrors = myErrArr ? myErrArr.length : 0;
    const myErrNumM = tx.match(/(\d+)\s*(?:erros?\b|[x×]\s*errou)/i) || tx.match(/errou[\s:]+(\d+)/i);
    if (myErrNumM) { const ne = parseInt(myErrNumM[1]); if (ne > myErrors) myErrors = ne; }
    if (myErrors <= 0) return;
    const qi = getInfo();
    if (!qi.qid) return;
    qi.myErrors = myErrors; qi.myTotal = myTotal;
    send('wrong_import', qi);
  }

  function checkCadernoEnd() {
    if (_pfEndSent) return;
    const tx = document.body.innerText || '';
    const qm = tx.match(/Quest[aã]o\s+(\d+)\s+de\s+(\d+)/i);
    if (!qm) return;
    const n = parseInt(qm[1]), t = parseInt(qm[2]);
    if (n === t && t > 0) {
      const s = parse();
      const done = s ? (s.a + s.e) : 0;
      if (done >= t) {
        _pfEndSent = true;
        setTimeout(() => {
          sendRaw({ type: 'TEC_CADERNO_END', stats: { total: t, correct: s ? s.a : 0, wrong: s ? s.e : 0, elapsed: _pfStats.elapsed || 0 } });
        }, 2500);
      }
    }
  }

  function check() {
    const cu = window.location.href;
    if (cu !== _lastUrl) {
      _lastUrl = cu;
      _pfEndSent = false;
      setTimeout(scanHistory, 1200);
      setTimeout(checkCadernoEnd, 1500);
    }
    const s = parse();
    if (!s) return;
    const da = s.a - A, de = s.e - E;
    if (da > 0) { for (let i = 0; i < da; i++) send('correct', null); A = s.a; }
    if (da > 0 || de > 0) setTimeout(checkCadernoEnd, 800);
    if (de > 0) {
      const _de = de; E = s.e;
      const _qi0 = getInfo();
      send('wrong_fast', _qi0);
      setTimeout(() => {
        const qi = getInfo();
        if (_qi0.qid && (!qi.qid || qi.qid !== _qi0.qid)) {
          qi.url = _qi0.url; qi.qid = _qi0.qid;
          qi.desc = _qi0.desc || qi.desc; qi.materia = _qi0.materia || qi.materia; qi.assunto = _qi0.assunto || qi.assunto;
        }
        for (let i = 0; i < _de; i++) send('wrong', qi);
        if (!qi.myErrors) {
          const _u = qi.url, _q = qi.qid;
          setTimeout(() => {
            const q2 = getInfo();
            q2.url = _u; q2.qid = _q;
            if (q2.myErrors > 0) send('wrong_update', q2);
          }, 2500);
        }
      }, 500);
    }
  }

  // ── Widget ────────────────────────────────────────────────────────────────

  let _pfExpanded = false; // hover expande, saída recolhe

  function pfFmt(s) {
    if (!s || s < 0) s = 0;
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sc = s % 60;
    if (h > 0) return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(sc).padStart(2,'0')}`;
    return `${String(m).padStart(2,'0')}:${String(sc).padStart(2,'0')}`;
  }

  function pfRenderWidget() {
    if (!el) return;

    // Modo ícone puro (minimizado)
    if (_pfMin) {
      el.style.cssText = el.style.cssText.replace(/padding:[^;]+;/, '');
      el.style.padding = '7px 10px';
      el.style.borderRadius = '20px';
      const fila = _pfFila.length > 0 ? `<span style="position:absolute;top:-4px;right:-4px;background:#ef4444;color:#fff;border-radius:8px;padding:0 5px;font-size:10px;font-weight:800;">${_pfFila.length}</span>` : '';
      el.style.position = 'fixed';
      el.innerHTML = `<span style="position:relative;display:inline-block;font-size:15px;">⚡${fila}</span>`;
      return;
    }

    const s = _pfStats;
    const pct = (s.acertos + s.erros) > 0 ? Math.round(s.acertos / (s.acertos + s.erros) * 100) : 0;
    const cor = pct >= 70 ? '#10b981' : pct >= 50 ? '#f0a500' : '#ef4444';
    const icon = s.paused ? '⏸' : (s.running ? '▶' : '⚡');

    if (!_pfExpanded) {
      // ── COMPACTO: pílula pequena com ícone + timer ──
      const dot = _pfFila.length > 0 ? `<span style="width:7px;height:7px;border-radius:50%;background:#ef4444;display:inline-block;margin-left:4px;box-shadow:0 0 5px #ef4444;"></span>` : '';
      el.style.padding = '5px 11px';
      el.style.borderRadius = '20px';
      el.style.fontSize = '11px';
      el.innerHTML = `<span style="display:flex;align-items:center;gap:5px;font-family:monospace;font-weight:700;letter-spacing:.5px;">${icon} ${pfFmt(s.elapsed)}${dot}</span>`;
    } else {
      // ── EXPANDIDO (hover): mostra stats completos ──
      const filaBadge = _pfFila.length > 0
        ? `<span style="background:#ef4444;border-radius:10px;padding:1px 6px;font-size:10px;">📋${_pfFila.length}</span>`
        : '';
      const statsHtml = (s.acertos + s.erros) > 0
        ? `<span style="opacity:.6;margin:0 2px;">|</span><span style="color:#10b981;">✓${s.acertos}</span><span style="color:#ef4444;">✗${s.erros}</span><span style="color:${cor};font-weight:800;">${pct}%</span>`
        : '';
      el.style.padding = '7px 13px';
      el.style.borderRadius = '14px';
      el.style.fontSize = '12px';
      el.innerHTML = `<div style="display:flex;align-items:center;gap:7px;font-weight:700;">
        <span>${icon}</span>
        <span style="font-family:monospace;">${pfFmt(s.elapsed)}</span>
        ${statsHtml}${filaBadge}
        <span id="_pfMinBtn" style="opacity:.5;cursor:pointer;font-size:13px;margin-left:2px;">−</span>
      </div>`;
      const minBtn = document.getElementById('_pfMinBtn');
      if (minBtn) minBtn.onclick = (ev) => { ev.stopPropagation(); _pfMin = true; _pfExpanded = false; pfRenderWidget(); };
    }
  }

  function createWidget(connected) {
    if (document.getElementById('_pfBadge')) return;
    el = document.createElement('div');
    el.id = '_pfBadge';
    el.style.cssText = 'position:fixed;bottom:14px;right:14px;color:#fff;border-radius:20px;font-weight:700;z-index:2147483647;cursor:pointer;box-shadow:0 2px 12px rgba(0,0,0,.45);font-family:sans-serif;user-select:none;transition:all .25s ease;';
    el.style.background = connected ? 'linear-gradient(135deg,#10b981,#0ea5e9)' : 'linear-gradient(135deg,#f59e0b,#ef4444)';
    el.title = 'Painel Fiscal Monitor — passe o mouse para ver stats | clique para abrir painel | duplo clique para desativar';
    if (connected) {
      pfRenderWidget();
    } else {
      el.style.padding = '6px 12px';
      el.style.fontSize = '11px';
      el.innerHTML = '⚠ Painel não encontrado';
    }
    // Hover: expande para mostrar stats
    el.addEventListener('mouseenter', () => {
      if (_pfMin) return;
      _pfExpanded = true;
      pfRenderWidget();
    });
    el.addEventListener('mouseleave', () => {
      if (_pfMin) return;
      _pfExpanded = false;
      pfRenderWidget();
    });
    el.ondblclick = function () {
      if (confirm('Desativar monitor e remover widget?')) {
        obs.disconnect();
        el.remove();
        el = null;
        const fb = document.getElementById('_pfFilaBanner');
        if (fb) fb.remove();
        window._pfExt = false;
      }
    };
    el.onclick = function (ev) {
      if (ev.target.id === '_pfMinBtn') return;
      if (!_pfMin && _pfExpanded) {
        // Clique enquanto expandido: abre painel
        if (!_pfw || _pfw.closed) {
          _pfw = window.open(PANEL_URL, '_pfPanel');
          setTimeout(() => { sendSession(); setTimeout(scanHistory, 1500); }, 1500);
        } else {
          _pfw.focus();
        }
      } else if (_pfMin) {
        // Clique no ícone minimizado: restaura
        _pfMin = false;
        pfRenderWidget();
      }
    };
    document.body.appendChild(el);
  }

  // ── Banner de fila ────────────────────────────────────────────────────────

  function pfShowFilaBanner(items) {
    const prev = document.getElementById('_pfFilaBanner');
    if (prev) prev.remove();
    if (!items || !items.length) return;
    const bn = document.createElement('div');
    bn.id = '_pfFilaBanner';
    bn.style.cssText = 'position:fixed;top:12px;left:50%;transform:translateX(-50%);background:linear-gradient(135deg,#ef4444,#f59e0b);color:#fff;padding:12px 20px;border-radius:12px;font-size:13px;font-weight:700;z-index:2147483647;box-shadow:0 6px 30px rgba(239,68,68,.5);font-family:sans-serif;display:flex;align-items:center;gap:12px;cursor:pointer;';
    const it = items[0];
    bn.innerHTML = `📋 <span>Hora de revisar: <em style="font-weight:600;">${(it.desc || 'questão').substring(0, 50)}</em>${items.length > 1 ? ` (+${items.length - 1})` : ''}</span>
      <button id="_pfFilaAbrir" style="background:#fff;color:#ef4444;border:none;border-radius:8px;padding:5px 12px;font-weight:800;cursor:pointer;font-size:12px;">Abrir</button>
      <span id="_pfFilaFechar" style="opacity:.7;cursor:pointer;font-size:16px;">✕</span>`;
    bn.onclick = () => { window.open(it.link, '_self'); };
    document.body.appendChild(bn);
    const abrirBtn = document.getElementById('_pfFilaAbrir');
    if (abrirBtn) abrirBtn.onclick = (ev) => { ev.stopPropagation(); window.open(it.link, '_self'); };
    const fecharBtn = document.getElementById('_pfFilaFechar');
    if (fecharBtn) fecharBtn.onclick = (ev) => { ev.stopPropagation(); bn.remove(); };
    setTimeout(() => { if (bn.parentElement) bn.style.opacity = '0.7'; }, 10000);
  }

  // ── Listeners de mensagens reversas ──────────────────────────────────────

  window.addEventListener('message', function (ev) {
    if (!ev.data || !ev.data.type) return;
    if (ev.data.type === 'TEC_STATS_UPDATE') {
      _pfStats = {
        elapsed: ev.data.elapsed || 0,
        acertos: ev.data.acertos || 0,
        erros: ev.data.erros || 0,
        resolved: ev.data.resolved || 0,
        running: !!ev.data.running,
        paused: !!ev.data.paused,
        discName: ev.data.discName || ''
      };
      pfRenderWidget();
      // Atualiza badge da extensão via background
      try { chrome.runtime.sendMessage({ type: 'UPDATE_BADGE', filaCount: _pfFila.length, stats: _pfStats }); } catch (x) { /* */ }
      return;
    }
    if (ev.data.type === 'PF_FILA_READY') {
      _pfFila = ev.data.items || [];
      pfShowFilaBanner(_pfFila);
      pfRenderWidget();
      try { chrome.runtime.sendMessage({ type: 'UPDATE_BADGE', filaCount: _pfFila.length }); } catch (x) { /* */ }
      return;
    }
    if (ev.data.type === 'PF_OPEN_QUESTION' && ev.data.url) {
      window.open(ev.data.url, '_self');
      return;
    }
    if (ev.data.type === 'PF_NO_FILA') {
      const nb = document.createElement('div');
      nb.style.cssText = 'position:fixed;top:12px;left:50%;transform:translateX(-50%);background:#0c1120;color:#fff;padding:10px 18px;border-radius:10px;font-size:13px;z-index:2147483647;border:1px solid rgba(255,255,255,.15);font-family:sans-serif;';
      nb.textContent = '⏰ Fila vazia — nenhuma revisão pendente';
      document.body.appendChild(nb);
      setTimeout(() => nb.remove(), 3000);
      return;
    }
  });

  // Escuta mensagens do background (relay reverso + PING do popup)
  chrome.runtime.onMessage.addListener(function (msg, _sender, sendResponse) {
    if (!msg) return;
    if (msg.type === 'PING') {
      sendResponse({ pong: true });
      return true;
    }
    if (msg.type === 'FROM_PANEL') {
      window.dispatchEvent(new MessageEvent('message', { data: msg.payload }));
    }
  });

  // ── Visibilidade (auto-pausa) ─────────────────────────────────────────────

  document.addEventListener('visibilitychange', function () {
    if (document.hidden) {
      _pfHiddenSince = Date.now();
      setTimeout(function () {
        if (document.hidden && _pfHiddenSince && (Date.now() - _pfHiddenSince) >= 120000) {
          sendRaw({ type: 'TEC_TAB_INACTIVE' });
        }
      }, 120000);
    } else {
      if (_pfHiddenSince && (Date.now() - _pfHiddenSince) >= 120000) {
        sendRaw({ type: 'TEC_TAB_ACTIVE' });
      }
      _pfHiddenSince = 0;
    }
  });

  // ── Atalho Alt+R ──────────────────────────────────────────────────────────

  window.addEventListener('keydown', function (ev) {
    if (ev.altKey && (ev.key === 'r' || ev.key === 'R')) {
      ev.preventDefault();
      sendRaw({ type: 'PF_REQUEST_NEXT_FILA' });
    }
  });

  // ── Init ──────────────────────────────────────────────────────────────────

  function init() {
    _pfw = findPanelWindow();
    const init0 = parse();
    if (init0) { A = init0.a; E = init0.e; }

    const connected = send('ping', null);
    if (connected) {
      sendSession();
      _lastUrl = window.location.href;
      setTimeout(scanHistory, 1500);
    }

    createWidget(connected);

    const obs = new MutationObserver(check);
    obs.observe(document.body, { childList: true, subtree: true, characterData: true });
    window._pfM = { obs, el, win: _pfw };

    // Notifica background que o content script está ativo nesta aba
    try { chrome.runtime.sendMessage({ type: 'CONTENT_READY', connected, url: window.location.href }); } catch (x) { /* */ }
  }

  // Aguarda DOM estar pronto
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
