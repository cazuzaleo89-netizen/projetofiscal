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
  let _pfConnectTime = 0; // timestamp da conexão — usado para warmup de 3s
  let _lastUrl = '';
  let _pfEndSent = false;
  let _pfDesempenhoOpen = false; // rastreia se painel "Desempenho nesta questão" está aberto
  let _pfAutoFetchKey = '';     // dedup para autoFetchDesempenho (qid_A_E)
  let _pfMin = false;
  let _pfHiddenSince = 0;
  let _pfFila = [];
  let _pfStats = { elapsed: 0, acertos: 0, erros: 0, resolved: 0, running: false, paused: false, discName: '', dificuldade: '' };
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

  function scanDesempenho() {
    const tx = document.body.innerText || '';
    if (!tx.includes('Meu Desempenho')) return;
    const qi = getInfo();
    if (!qi.qid) return;

    // Divide o texto para isolar seção "Meu Desempenho" (pessoal) do resto
    const meuIdx = tx.indexOf('Meu Desempenho');
    const globalTx = meuIdx >= 0 ? tx.slice(0, meuIdx) : tx;
    const myTx     = meuIdx >= 0 ? tx.slice(meuIdx)    : '';

    // ── Meu Desempenho ───────────────────────────────────────────────────────
    const errouArr = myTx.match(/\bErrou\b/gi);
    let myErrors = errouArr ? errouArr.length : 0;
    const myErrNumM = myTx.match(/(\d+)\s*(?:erros?\b|[x×]\s*errou)/i);
    if (myErrNumM) { const ne = parseInt(myErrNumM[1]); if (ne > myErrors) myErrors = ne; }
    const myResM = myTx.match(/Total de resolu[çc][õo]es[:\s]+(\d+)/i);
    const myTotal = myResM ? parseInt(myResM[1]) : 0;

    // ── Dificuldade (do Desempenho Geral) ────────────────────────────────────
    const difM = globalTx.match(/Dificuldade:\s*([^\n\r]+)/i);
    const dificuldade = difM ? difM[1].trim() : '';

    qi.myErrors    = myErrors;
    qi.myTotal     = myTotal;
    qi.dificuldade = dificuldade;

    // Atualiza widget imediatamente com a dificuldade
    if (dificuldade && _pfStats.dificuldade !== dificuldade) {
      _pfStats.dificuldade = dificuldade;
      pfRenderWidget();
    }

    send('desempenho_detail', qi);
  }

  // Tenta ler dados de desempenho do DOM. Se não disponíveis, abre a seção programaticamente.
  function autoFetchDesempenho(snapQid) {
    const qi = getInfo();
    if (snapQid && qi.qid && qi.qid !== snapQid) return; // navegou para outra questão

    // Dedup: não reprocessar o mesmo estado de resposta
    const dKey = (qi.qid || window.location.href) + '_' + A + '_' + E;
    if (_pfAutoFetchKey === dKey) return;

    const tx = document.body.innerText || '';
    const meuIdx = tx.indexOf('Meu Desempenho');
    const myTx = meuIdx >= 0 ? tx.slice(meuIdx) : '';
    // Dados disponíveis se há histórico pessoal (Acertou/Errou ou Total de resoluções)
    const hasData = meuIdx >= 0 &&
      (myTx.includes('Total de resolu') || myTx.includes('Errou') || myTx.includes('Acertou'));

    if (hasData) {
      _pfAutoFetchKey = dKey;
      scanDesempenho();
      return;
    }

    // Dados não carregados: abre seção "Desempenho nesta questão" programaticamente
    const clickables = document.querySelectorAll('button, [role="button"]');
    for (const el of clickables) {
      const t = (el.textContent || '').trim();
      if (/desempenho/i.test(t) && !/fechar|esconder/i.test(t) && t.length < 80) {
        _pfAutoFetchKey = dKey;
        el.click();
        setTimeout(() => {
          scanDesempenho();
          // Fecha o painel após leitura para não interferir no fluxo
          setTimeout(() => {
            const btns = document.querySelectorAll('button');
            for (const b of btns) {
              if (/fechar/i.test(b.textContent || '')) { b.click(); break; }
            }
          }, 350);
        }, 750);
        break;
      }
    }
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
      _pfDesempenhoOpen = false;
      setTimeout(scanHistory, 1200);
      setTimeout(checkCadernoEnd, 1500);
    }
    const s = parse();

    // Detecta abertura do painel "Desempenho nesta questão" (usuário abre manualmente)
    const tx0 = document.body.innerText || '';
    const isDesempenhoOpen = tx0.includes('Meu Desempenho') && tx0.includes('Desempenho Geral');
    if (isDesempenhoOpen && !_pfDesempenhoOpen) {
      _pfDesempenhoOpen = true;
      setTimeout(scanDesempenho, 400);
    } else if (!isDesempenhoOpen) {
      _pfDesempenhoOpen = false;
    }
    if (!s) return;
    const da = s.a - A, de = s.e - E;
    // Warmup: nos primeiros 3s só atualiza baseline sem enviar msgs (evita burst do SPA)
    if (Date.now() - _pfConnectTime < 3000) { if (da > 0) A = s.a; if (de > 0) E = s.e; return; }
    if (da > 0) { for (let i = 0; i < da; i++) send('correct', null); A = s.a; }
    if (da > 0 || de > 0) {
      // Reset do estado de desempenho: permite re-scan quando dados da nova questão carregam
      // Necessário em cadernos onde a URL não muda entre questões
      _pfDesempenhoOpen = false;
      const _snapQidD = getInfo().qid;
      setTimeout(() => autoFetchDesempenho(_snapQidD), 1500);  // tentativa principal
      setTimeout(() => autoFetchDesempenho(_snapQidD), 4000);  // fallback se DOM demorar
    }
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

  let _pfExpanded = false;

  // Injeta keyframes CSS uma vez
  function pfInjectStyles() {
    if (document.getElementById('_pfStyles')) return;
    const s = document.createElement('style');
    s.id = '_pfStyles';
    s.textContent = `
    @keyframes _pfPulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.45;transform:scale(.8)}}
    @keyframes _pfGlow{0%,100%{box-shadow:0 0 0 1px rgba(99,102,241,.3),0 8px 32px rgba(0,0,0,.7)}50%{box-shadow:0 0 0 1px rgba(99,102,241,.6),0 8px 40px rgba(99,102,241,.25),0 0 20px rgba(99,102,241,.15)}}
    @keyframes _pfSlideUp{from{opacity:0;transform:translateY(12px) scale(.96)}to{opacity:1;transform:translateY(0) scale(1)}}
    #_pfBadge{animation:_pfSlideUp .35s cubic-bezier(.16,1,.3,1);}
    #_pfBadge *{box-sizing:border-box;}
    ._pf-s{transition:transform .15s;}
    ._pf-s:hover{transform:scale(1.05);}
    ._pf-mb:hover{background:rgba(255,255,255,.12)!important;color:#e2e8f0!important;}
  `;
    document.head.appendChild(s);
  }

  function pfFmt(s) {
    if (!s || s < 0) s = 0;
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sc = s % 60;
    if (h > 0) return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(sc).padStart(2,'0')}`;
    return `${String(m).padStart(2,'0')}:${String(sc).padStart(2,'0')}`;
  }

  function pfRenderWidget() {
    if (!el) return;
    pfInjectStyles();

    const s = _pfStats;
    const total = s.acertos + s.erros;
    const pct = total > 0 ? Math.round(s.acertos / total * 100) : null;
    const pctColor = pct === null ? '#64748b' : pct >= 70 ? '#10b981' : pct >= 50 ? '#f59e0b' : '#ef4444';
    const isRunning = s.running && !s.paused;
    const statusColor = s.paused ? '#f59e0b' : isRunning ? '#10b981' : '#6366f1';
    const statusDot = `<span style="width:7px;height:7px;border-radius:50%;background:${statusColor};display:inline-block;flex-shrink:0;${isRunning?'animation:_pfPulse 2s ease infinite':''}"></span>`;

    // ── MINIMIZADO ──
    if (_pfMin) {
      el.style.cssText = `position:fixed;bottom:16px;right:16px;z-index:2147483647;cursor:pointer;
        background:#0f172a;border:1px solid rgba(99,102,241,.4);border-radius:50%;
        width:42px;height:42px;display:flex;align-items:center;justify-content:center;
        box-shadow:0 4px 20px rgba(0,0,0,.6),0 0 0 1px rgba(99,102,241,.2);
        font-family:sans-serif;user-select:none;transition:all .2s ease;`;
      const badge = _pfFila.length > 0
        ? `<span style="position:absolute;top:-3px;right:-3px;background:#ef4444;color:#fff;border-radius:6px;padding:0 4px;font-size:9px;font-weight:800;font-family:sans-serif;">${_pfFila.length}</span>`
        : '';
      el.innerHTML = `<span style="position:relative;font-size:18px;line-height:1;">⚡${badge}</span>`;
      return;
    }

    // ── COMPACTO (padrão) ──
    if (!_pfExpanded) {
      el.style.cssText = `position:fixed;bottom:16px;right:16px;z-index:2147483647;cursor:pointer;
        background:rgba(9,11,20,.88);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);
        border:1px solid rgba(99,102,241,.25);border-radius:24px;
        padding:7px 13px 7px 10px;
        box-shadow:0 4px 24px rgba(0,0,0,.55),0 1px 0 rgba(255,255,255,.04) inset;
        font-family:sans-serif;user-select:none;transition:all .2s ease;color:#f1f5f9;`;
      const filaPin = _pfFila.length > 0
        ? `<span style="width:6px;height:6px;border-radius:50%;background:#ef4444;box-shadow:0 0 6px #ef4444;flex-shrink:0;animation:_pfPulse 1.5s infinite;"></span>`
        : '';
      el.innerHTML = `
        <div style="display:flex;align-items:center;gap:7px;">
          ${statusDot}
          <span style="font-family:'Courier New',monospace;font-size:13px;font-weight:700;letter-spacing:1px;color:#e2e8f0;">${pfFmt(s.elapsed)}</span>
          ${total > 0 ? `<span style="font-size:10px;font-weight:700;color:${pctColor};letter-spacing:.5px;">${pct}%</span>` : ''}
          ${filaPin}
        </div>`;
      return;
    }

    // ── EXPANDIDO (hover) ──
    el.style.cssText = `position:fixed;bottom:16px;right:16px;z-index:2147483647;cursor:default;
      background:rgba(9,11,20,.94);backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px);
      border:1px solid rgba(99,102,241,.3);border-radius:18px;
      width:220px;padding:14px;
      box-shadow:0 8px 40px rgba(0,0,0,.7),0 1px 0 rgba(255,255,255,.05) inset;
      font-family:sans-serif;user-select:none;transition:all .2s ease;color:#f1f5f9;`;

    const discLabel = s.discName
      ? `<div style="font-size:9px;letter-spacing:1.5px;color:#6366f1;text-transform:uppercase;font-weight:700;margin-bottom:10px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${s.discName}</div>`
      : '';

    const timerColor = s.paused ? '#f59e0b' : isRunning ? '#a5b4fc' : '#94a3b8';

    const statsRow = total > 0 ? `
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px;margin-top:12px;">
        <div class="_pf-stat" style="background:rgba(16,185,129,.08);border:1px solid rgba(16,185,129,.18);border-radius:10px;padding:7px 4px;text-align:center;cursor:default;transition:background .15s;">
          <div style="font-size:15px;font-weight:800;color:#10b981;font-family:'Courier New',monospace;">${s.acertos}</div>
          <div style="font-size:8px;color:#6b7280;letter-spacing:1px;margin-top:2px;">ACERTOS</div>
        </div>
        <div class="_pf-stat" style="background:rgba(239,68,68,.08);border:1px solid rgba(239,68,68,.15);border-radius:10px;padding:7px 4px;text-align:center;transition:background .15s;">
          <div style="font-size:15px;font-weight:800;color:#f87171;font-family:'Courier New',monospace;">${s.erros}</div>
          <div style="font-size:8px;color:#6b7280;letter-spacing:1px;margin-top:2px;">ERROS</div>
        </div>
        <div class="_pf-stat" style="background:rgba(${pct>=70?'16,185,129':pct>=50?'245,158,11':'239,68,68'},.08);border:1px solid rgba(${pct>=70?'16,185,129':pct>=50?'245,158,11':'239,68,68'},.2);border-radius:10px;padding:7px 4px;text-align:center;transition:background .15s;">
          <div style="font-size:15px;font-weight:800;color:${pctColor};font-family:'Courier New',monospace;">${pct}%</div>
          <div style="font-size:8px;color:#6b7280;letter-spacing:1px;margin-top:2px;">TAXA</div>
        </div>
      </div>` : '';

    const filaRow = _pfFila.length > 0 ? `
      <div style="display:flex;align-items:center;gap:6px;margin-top:8px;background:rgba(239,68,68,.08);border:1px solid rgba(239,68,68,.2);border-radius:8px;padding:5px 8px;cursor:pointer;" onclick="window._pfOpenFila && window._pfOpenFila()">
        <span style="font-size:12px;">📋</span>
        <span style="font-size:10px;color:#fca5a5;font-weight:600;flex:1;">${_pfFila.length} revisão${_pfFila.length>1?'ões':''} pendente${_pfFila.length>1?'s':''}</span>
        <span style="font-size:9px;color:#ef4444;font-weight:800;">Alt+R</span>
      </div>` : '';

    el.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:2px;">
        <div style="display:flex;align-items:center;gap:6px;">
          ${statusDot}
          <span style="font-size:9px;color:#64748b;letter-spacing:1px;font-weight:600;">${s.paused?'PAUSADO':isRunning?'EM ANDAMENTO':'PAINEL FISCAL'}</span>
        </div>
        <div style="display:flex;gap:4px;align-items:center;">
          <span id="_pfMinBtn" title="Minimizar" style="width:22px;height:22px;border-radius:6px;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.08);display:inline-flex;align-items:center;justify-content:center;cursor:pointer;font-size:11px;color:#64748b;transition:all .15s;" onmouseover="this.style.background='rgba(255,255,255,.12)'" onmouseout="this.style.background='rgba(255,255,255,.06)'">−</span>
        </div>
      </div>
      ${discLabel}
      <div style="font-family:'Courier New',monospace;font-size:28px;font-weight:700;color:${timerColor};letter-spacing:2px;line-height:1;text-align:center;text-shadow:0 0 20px ${timerColor}40;padding:4px 0;">${pfFmt(s.elapsed)}</div>
      ${statsRow}
      ${filaRow}`;

    const minBtn = document.getElementById('_pfMinBtn');
    if (minBtn) minBtn.onclick = (ev) => { ev.stopPropagation(); _pfMin = true; _pfExpanded = false; pfRenderWidget(); };
    window._pfOpenFila = () => { if(_pfFila[0]) window.open(_pfFila[0].link, '_self'); };
  }

  function createWidget(connected) {
    if (document.getElementById('_pfBadge')) return;
    pfInjectStyles();
    el = document.createElement('div');
    el.id = '_pfBadge';
    el.title = 'Painel Fiscal Monitor — passe o mouse para stats | clique para abrir painel | duplo clique para desativar';
    if (connected) {
      pfRenderWidget();
    } else {
      el.style.cssText = `position:fixed;bottom:16px;right:16px;z-index:2147483647;cursor:pointer;
        background:rgba(9,11,20,.88);backdrop-filter:blur(12px);border:1px solid rgba(245,158,11,.3);
        border-radius:24px;padding:7px 13px;font-family:sans-serif;user-select:none;
        box-shadow:0 4px 24px rgba(0,0,0,.55);color:#f59e0b;font-size:11px;font-weight:700;`;
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
        discName: ev.data.discName || '',
      dificuldade: ev.data.dificuldade || _pfStats.dificuldade || ''
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
    _pfConnectTime = Date.now(); // inicia warmup de 3s
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
