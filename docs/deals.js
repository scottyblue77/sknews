// SKNews Deals: Watchlist (config/deals.json im Repo), Preise aus docs/data/deals.json (Preissuche in GitHub Actions).
// Produkt erkennen über /api/produkt, Speichern und "Jetzt suchen" über das GitHub-Token der News-Seite.
(() => {
  const $ = id => document.getElementById(id);
  const read = (key, fallback) => { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } };
  const repo = read('sknews.repo', '') || 'scottyblue77/sknews';
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const euros = n => n == null ? '–' : (n / 100).toLocaleString('de-DE', {style:'currency', currency:'EUR'});
  const euro0 = n => n == null ? '–' : Math.round(n / 100).toLocaleString('de-DE') + ' €';
  const when = t => new Date(t * 1000).toLocaleString('de-DE', {day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit'});
  const day = t => new Date(t * 1000).toLocaleDateString('de-DE', {day:'2-digit', month:'2-digit'});
  const safe = u => { try { const p = new URL(u); return ['https:', 'http:'].includes(p.protocol) && !p.username ? p.href : '#'; } catch { return '#'; } };
  const via = s => ({web:'Händlerseite', ki:'von KI gelesen', manual:'manuell'})[s] || s;
  const COLORS = ['var(--t1)', 'var(--t2)', 'var(--t3)', 'var(--t4)', 'var(--t6)', 'var(--t5)'];
  const RANGES = [['1T', 86400], ['7T', 7 * 86400], ['30T', 30 * 86400], ['Alle', Infinity]];
  let config = {products: []}, sha, snapshot = {products: []}, editing, found = null;
  const view = {};   // je Produkt: {range, hidden:Set}

  function toast(msg){ const t = $('toast'); t.textContent = msg; t.classList.add('on'); clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('on'), 4200); }

  // ---------- GitHub ----------
  async function gh(path, opts = {}, api = 'contents/') {
    const token = read('sknews.token', '');
    if (!token) throw new Error('Zum Speichern bitte zuerst auf der News-Seite unter GitHub-Synchronisierung verbinden.');
    const r = await fetch(`https://api.github.com/repos/${repo}/${api}${path}`, {...opts, cache: 'no-store', headers: {Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', ...(opts.body ? {'Content-Type': 'application/json'} : {})}});
    if (!r.ok) throw new Error(r.status === 409 ? 'Die Watchlist wurde parallel geändert. Bitte neu laden.' : r.status === 403 || r.status === 404 ? `GitHub verweigert den Zugriff (${r.status}). Das Token braucht Schreibrechte für Inhalte${api === 'actions/' ? ' und Actions' : ''}.` : `GitHub-Anfrage fehlgeschlagen (${r.status}).`);
    return r.status === 204 ? null : r.json();
  }
  const decode = s => JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(s.replace(/\n/g, '')), c => c.charCodeAt(0))));
  const encode = data => { let s = ''; for (const b of new TextEncoder().encode(JSON.stringify(data, null, 2) + '\n')) s += String.fromCharCode(b); return btoa(s); };
  async function saveConfig(next, message) {
    if (sha === undefined) { const cur = await gh('config/deals.json?ref=main'); config = decode(cur.content); sha = cur.sha; next = next(config); }
    else next = next(config);
    const result = await gh('config/deals.json', {method: 'PUT', body: JSON.stringify({message, content: encode(next), branch: 'main', sha})});
    config = next; sha = result.content.sha; render();
  }

  // ---------- Auswertung ----------
  function analyse(w, s) {
    const now = Date.now() / 1000;
    // ältere Daten ohne "series": letzte Angebote je Händler als einzelne Messung
    const series = s.series || Object.fromEntries((s.sources || []).filter(o => o.available).map(o => [o.merchant, [[o.observed, o.cents]]]));
    const merchants = Object.keys(series).sort();
    // bester Preis je Suchlauf (alle Händler eines Laufs haben denselben Zeitstempel)
    const runs = new Map();
    for (const m of merchants) for (const [t, c] of series[m]) runs.set(t, Math.min(runs.get(t) ?? Infinity, c));
    const best = [...runs].sort((a, b) => a[0] - b[0]);
    const vals = best.map(x => x[1]);
    const cur = s.current && now - s.current.observed <= 21600 ? s.current : null;
    const first = best[0], last = best.at(-1), prev = best.at(-2);
    let slope = null;   // Cent pro Tag, lineare Regression über die Läufe
    if (best.length >= 3 && last[0] - first[0] >= 3 * 3600) {
      const n = best.length, mx = best.reduce((a, x) => a + x[0], 0) / n, my = vals.reduce((a, x) => a + x, 0) / n;
      const num = best.reduce((a, x) => a + (x[0] - mx) * (x[1] - my), 0), den = best.reduce((a, x) => a + (x[0] - mx) ** 2, 0);
      slope = den ? num / den * 86400 : 0;
    }
    const latest = (s.sources || []).filter(o => o.available && now - o.observed <= 21600).sort((a, b) => a.cents - b.cents);
    return {series, merchants, best, cur, first, last, prev, slope, latest,
      min: vals.length ? Math.min(...vals) : null, max: vals.length ? Math.max(...vals) : null,
      avg: vals.length ? vals.reduce((a, x) => a + x, 0) / vals.length : null,
      spread: latest.length > 1 ? latest.at(-1).cents - latest[0].cents : null,
      days: s.history_days || 0};
  }
  function trendBadge(a) {
    if (!a.last) return '<span class="trend">Noch keine Messung</span>';
    if (a.best.length < 2) return `<span class="trend" title="Erste Messung">● Erste Messung · ${esc(when(a.last[0]))}</span>`;
    const d = a.last[1] - a.first[1], pct = 100 * d / a.first[1];
    const dir = Math.abs(pct) < 0.5 ? '' : d < 0 ? 'down' : 'up';
    const arrow = dir === 'down' ? '▼' : dir === 'up' ? '▲' : '▶';
    const since = a.last[0] - a.first[0] >= 2 * 86400 ? `seit ${day(a.first[0])}` : `seit ${when(a.first[0])}`;
    return `<span class="trend ${dir}" title="Bester Preis jetzt gegenüber der ersten Messung">${arrow} ${d > 0 ? '+' : ''}${euros(d)} (${pct > 0 ? '+' : ''}${pct.toFixed(1).replace('.', ',')} %) ${esc(since)}</span>`;
  }
  function tendency(a) {
    if (a.slope == null) return a.best.length < 3 ? `ab 3 Messungen (jetzt ${a.best.length})` : 'zu kurzer Zeitraum';
    const perDay = a.slope / 100;
    if (Math.abs(perDay) < 0.5) return '→ stabil';
    return `${perDay < 0 ? '↘ fällt' : '↗ steigt'} ~${Math.abs(perDay).toLocaleString('de-DE', {maximumFractionDigits: perDay > 10 || perDay < -10 ? 0 : 1})} €/Tag`;
  }

  // ---------- Diagramm ----------
  function chart(w, a) {
    const v = view[w.id];
    const now = Date.now() / 1000, span = RANGES.find(r => r[0] === v.range)[1];
    const from = Math.max(a.first ? a.first[0] : now, now - span);
    const inRange = pts => pts.filter(p => p[0] >= from - 1);
    const best = inRange(a.best);
    if (!best.length) return `<div class="empty-chart">${a.best.length ? 'Keine Messungen in diesem Zeitraum.' : 'Noch keine Preise. Die Suche läuft stündlich, mit „Jetzt suchen“ sofort.'}</div>`;
    const W = 640, H = 240, L = 54, R = 12, T = 14, B = 26;
    const lines = a.merchants.map((m, i) => ({m, c: COLORS[i % COLORS.length], pts: inRange(a.series[m] || [])})).filter(l => !v.hidden.has(l.m) && l.pts.length);
    const all = [...best, ...lines.flatMap(l => l.pts)].map(p => p[1]);
    if (w.target_cents) all.push(w.target_cents);
    let lo = Math.min(...all), hi = Math.max(...all);
    const pad = Math.max((hi - lo) * 0.12, hi * 0.01, 500); lo -= pad; hi += pad;
    let t0 = best[0][0], t1 = Math.max(best.at(-1)[0], now);
    if (t1 - t0 < 6 * 3600) t0 = t1 - 6 * 3600;   // wenige Punkte: mindestens 6 Stunden Achse, damit nichts am Rand klebt
    const x = t => L + (W - L - R) * (t - t0) / (t1 - t0), y = c => T + (H - T - B) * (1 - (c - lo) / (hi - lo));
    const path = pts => pts.map((p, i) => `${i ? 'L' : 'M'}${x(p[0]).toFixed(1)},${y(p[1]).toFixed(1)}`).join('');
    const ticks = [0, 1, 2, 3].map(i => lo + (hi - lo) * (i + .5) / 4);
    const xt = [0, .5, 1].map(f => t0 + (t1 - t0) * f);
    const fmtX = t => t1 - t0 > 3 * 86400 ? day(t) : new Date(t * 1000).toLocaleTimeString('de-DE', {hour: '2-digit', minute: '2-digit'});
    const single = best.length === 1;
    const svg = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Preisverlauf ${esc(w.name)}: ${best.length} Messungen, ${euros(Math.min(...best.map(p => p[1])))} bis ${euros(Math.max(...best.map(p => p[1])))}">
      <g class="grid">${ticks.map(c => `<line x1="${L}" x2="${W - R}" y1="${y(c)}" y2="${y(c)}"/>`).join('')}</g>
      ${ticks.map(c => `<text class="ax" x="${L - 6}" y="${y(c) + 3}" text-anchor="end">${euro0(c)}</text>`).join('')}
      ${xt.map((t, i) => `<text class="ax" x="${x(t)}" y="${H - 6}" text-anchor="${['start', 'middle', 'end'][i]}">${fmtX(t)}</text>`).join('')}
      ${w.target_cents ? `<line class="target" x1="${L}" x2="${W - R}" y1="${y(w.target_cents)}" y2="${y(w.target_cents)}"/><text class="tl" x="${W - R}" y="${y(w.target_cents) - 4}" text-anchor="end">Ziel ${euro0(w.target_cents)}</text>` : ''}
      ${lines.map(l => `<path class="mline" style="--c:${l.c}" d="${path(l.pts)}"/>${l.pts.map(p => `<circle class="dot" style="--c:${l.c}" cx="${x(p[0])}" cy="${y(p[1])}" r="${single ? 4 : 2.5}"/>`).join('')}`).join('')}
      ${single ? '' : `<path class="area" d="${path(best)}L${x(best.at(-1)[0])},${H - B}L${x(best[0][0])},${H - B}Z"/><path class="best" d="${path(best)}"/>`}
      ${best.map(p => `<circle cx="${x(p[0])}" cy="${y(p[1])}" r="${single ? 6 : 3.5}" fill="var(--accent)"/>`).join('')}
      <line class="cross" x1="0" x2="0" y1="${T}" y2="${H - B}"/>
    </svg><div class="tip"></div>`;
    return {svg, geo: {x, t0, t1, L, R, W, best, lines}};
  }
  function bindChart(el, w, geo) {
    const tip = el.querySelector('.tip'), cross = el.querySelector('.cross');
    const move = e => {
      const r = el.getBoundingClientRect();
      const px = ((e.touches ? e.touches[0].clientX : e.clientX) - r.left) / r.width * geo.W;
      const near = geo.best.reduce((b, p) => Math.abs(geo.x(p[0]) - px) < Math.abs(geo.x(b[0]) - px) ? p : b, geo.best[0]);
      const t = near[0];
      cross.setAttribute('x1', geo.x(t)); cross.setAttribute('x2', geo.x(t));
      const at = geo.lines.map(l => [l, l.pts.find(p => p[0] === t)]).filter(x => x[1]).sort((a, b) => a[1][1] - b[1][1]);
      tip.innerHTML = `<b>${esc(when(t))}</b><div><span>Bester Preis</span><strong>${euros(near[1])}</strong></div>${at.map(([l, p]) => `<div><span style="color:${l.c}">● ${esc(l.m)}</span><span>${euros(p[1])}</span></div>`).join('')}`;
      const left = geo.x(t) / geo.W * r.width;
      tip.style.left = Math.min(Math.max(8, left + 12), r.width - tip.offsetWidth - 8) + 'px'; tip.style.top = '8px';
      el.classList.add('hover');
    };
    el.addEventListener('pointermove', move); el.addEventListener('pointerdown', move);
    el.addEventListener('pointerleave', () => el.classList.remove('hover'));
  }

  // ---------- Karten ----------
  function card(w, i) {
    const s = snapshot.products?.find(x => x.id === w.id) || {series: {}};
    const a = analyse(w, s);
    view[w.id] ||= {range: a.best.length && a.last[0] - a.first[0] < 86400 ? '1T' : '30T', hidden: new Set()};
    const v = view[w.id];
    const c = chart(w, a);
    const price = a.cur ? a.cur.cents : null;
    const goal = w.target_cents && price ? Math.max(0, Math.min(100, 100 * w.target_cents / price)) : 0;
    const shops = a.latest.slice(0, 8);
    const colorOf = m => COLORS[a.merchants.indexOf(m) % COLORS.length] || 'var(--accent)';
    const maxShop = shops.length ? shops.at(-1).cents : 1, minShop = shops.length ? shops[0].cents : 0;
    return `<article class="deal" style="--i:${i}" data-id="${esc(w.id)}">
      <header><h2>${esc(w.name)}</h2>${w.enabled ? '' : '<span class="chip">Pausiert</span>'}
        <div class="ids">${/^\d+$/.test(w.variant) ? `<span class="chip">EAN ${esc(w.variant)}</span>` : ''}${w.model || !/^\d+$/.test(w.variant) ? `<span class="chip">Modell ${esc(w.model || w.variant)}</span>` : ''}<span class="chip">${a.best.length} Messungen · ${a.days} ${a.days === 1 ? 'Tag' : 'Tage'}</span></div></header>
      <div>
        <div class="hint">Bester Preis jetzt</div>
        <div class="price">${euros(price)}</div>
        <p class="where">${a.cur ? `${esc(a.cur.merchant)} · ${a.cur.shipping_known === 0 ? '+ Versand?' : 'inkl. Versand'} · ${esc(via(a.cur.source))}` : 'Kein frisches Angebot aus der letzten Suche'}</p>
        ${trendBadge(a)}
        <div class="goal">
          ${w.target_cents ? `<div class="hint">${price && price <= w.target_cents ? '🎯 Zielpreis erreicht!' : price ? `Noch ${euros(price - w.target_cents)} bis zum Ziel` : 'Zielpreis gesetzt'}</div><div class="meter" role="img" aria-label="Fortschritt zum Zielpreis"><i style="--p:${goal}%"></i></div>` : '<div class="hint">Kein Zielpreis gesetzt</div>'}
          <form data-goal="${esc(w.id)}"><input name="t" type="number" min="1" step="1" inputmode="decimal" placeholder="Zielpreis €" value="${w.target_cents ? Math.round(w.target_cents / 100) : ''}" aria-label="Zielpreis in Euro"><button class="btn ghost" type="submit">Ziel setzen</button></form>
        </div>
        <div class="stats">
          <div><small>Tief</small><b>${euros(a.min)}</b></div>
          <div><small>Hoch</small><b>${euros(a.max)}</b></div>
          <div><small>Schnitt</small><b>${euros(a.avg == null ? null : Math.round(a.avg))}</b></div>
          <div><small>Händler-Spanne</small><b>${a.spread == null ? '–' : euros(a.spread)}</b></div>
          <div><small>Tendenz</small><b>${esc(tendency(a))}</b></div>
          <div><small>Shops jetzt</small><b>${a.latest.length}</b></div>
        </div>
      </div>
      <div class="chartbox">
        <div class="chartbar"><span class="seg" role="group" aria-label="Zeitraum">${RANGES.map(([k]) => `<button type="button" data-range="${k}" aria-pressed="${v.range === k}">${k}</button>`).join('')}</span><span class="sp"></span>
          ${a.merchants.map(m => `<button type="button" class="chip" style="--c:${colorOf(m)}" data-shop="${esc(m)}" aria-pressed="${!v.hidden.has(m)}"><i></i>${esc(m)}</button>`).join('')}</div>
        <div class="chart">${typeof c === 'string' ? c : c.svg}</div>
        ${shops.length ? `<ol class="shops">${shops.map(o => `<li style="--c:${colorOf(o.merchant)};--w:${maxShop === minShop ? 100 : 25 + 75 * (maxShop - o.cents) / (maxShop - minShop)}%"><a href="${esc(safe(o.url))}" target="_blank" rel="noopener noreferrer">${esc(o.merchant)}</a><span><b>${euros(o.cents)}</b> <small>${o.shipping_known === 0 ? '+ Versand?' : 'inkl. Versand'} · ${esc(via(o.source))}</small></span><span class="bar"><i></i></span></li>`).join('')}</ol>` : ''}
      </div>
      <footer>
        ${a.cur ? `<a class="btn" href="${esc(safe(a.cur.url))}" target="_blank" rel="noopener noreferrer">Zum Angebot ↗</a>` : ''}
        <button class="btn ghost" type="button" data-edit="${esc(w.id)}">Bearbeiten</button>
        <button class="btn ghost" type="button" data-pause="${esc(w.id)}">${w.enabled ? 'Pausieren' : 'Fortsetzen'}</button>
        <span class="sp"></span>
        <details class="rules"><summary>Regeln</summary><p class="hint">${w.mode === 'all' ? 'Alle Regeln' : 'Mindestens eine Regel'}: ${[w.target_cents ? `Zielpreis ${euros(w.target_cents)}` : '', w.drop_percent ? `${w.drop_percent} % unter 30-Tage-Median` : '', w.new_low ? 'neuer Bestpreis' : ''].filter(Boolean).join(', ') || 'keine'} · ab ${w.min_days} Tagen · ${w.cooldown_hours} h Push-Abstand</p></details>
      </footer>
    </article>`;
  }

  function render() {
    const el = $('cards');
    if (!config.products.length) { el.innerHTML = '<div class="empty"><strong>Deine Watchlist ist leer.</strong>Beschreib oben ein Produkt, die KI sucht Modell und EAN.</div>'; return; }
    el.innerHTML = config.products.map(card).join('');
    for (const w of config.products) {
      const art = el.querySelector(`.deal[data-id="${CSS.escape(w.id)}"]`);
      const s = snapshot.products?.find(x => x.id === w.id) || {series: {}};
      const c = chart(w, analyse(w, s));
      if (typeof c !== 'string') bindChart(art.querySelector('.chart'), w, c.geo);
      art.querySelectorAll('[data-range]').forEach(b => b.onclick = () => { view[w.id].range = b.dataset.range; render(); });
      art.querySelectorAll('[data-shop]').forEach(b => b.onclick = () => { const h = view[w.id].hidden; h.has(b.dataset.shop) ? h.delete(b.dataset.shop) : h.add(b.dataset.shop); render(); });
    }
    el.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => openEditor(b.dataset.edit));
    el.querySelectorAll('[data-pause]').forEach(b => b.onclick = () => update(b.dataset.pause, w => ({...w, enabled: !w.enabled}), 'Beobachtung umgeschaltet'));
    el.querySelectorAll('[data-goal]').forEach(f => f.onsubmit = e => {
      e.preventDefault();
      const n = Number(f.elements.t.value);
      update(f.dataset.goal, w => ({...w, target_cents: n > 0 ? Math.round(n * 100) : null}), n > 0 ? `Zielpreis ${n} € gespeichert` : 'Zielpreis entfernt');
    });
  }
  async function update(id, fn, msg) {
    try { await saveConfig(cfg => ({...cfg, products: cfg.products.map(w => w.id === id ? fn(w) : w)}), 'Deals-Watchlist aktualisiert'); toast(msg); }
    catch (err) { toast(err.message); }
  }

  async function load() {
    try {
      const r = await fetch('data/deals.json', {cache: 'no-store'});
      if (r.ok) snapshot = await r.json();
      if (read('sknews.token', '')) { const f = await gh('config/deals.json?ref=main'); config = decode(f.content); sha = f.sha; }
      else { const f = await fetch(`https://raw.githubusercontent.com/${repo}/main/config/deals.json`, {cache: 'no-store'}); if (f.ok) config = await f.json(); }
      $('status').textContent = snapshot.updated ? `Letzte Preissuche ${when(snapshot.updated)} · stündlich · ${snapshot.method || ''}` : 'Noch keine Preissuche gelaufen';
      render();
    } catch (e) { $('status').textContent = e.message; render(); }
    const neu = new URLSearchParams(location.search).get('neu');
    if (neu) { $('askInput').value = neu.slice(0, 200); history.replaceState(null, '', location.pathname); detect(); }
  }

  // ---------- Produkt erkennen ----------
  async function detect() {
    const text = $('askInput').value.trim();
    if (text.length < 3) return;
    $('askBtn').disabled = true; $('found').classList.remove('on'); $('scan').classList.add('on');
    const steps = ['Suche im Netz …', 'Lese Treffer …', 'KI prüft Modell und EAN …'];
    let i = 0; $('scanText').textContent = steps[0];
    const timer = setInterval(() => { $('scanText').textContent = steps[Math.min(++i, steps.length - 1)]; }, 1400);
    try {
      let r;
      if (/^\d{8,14}$/.test(text)) r = {name: '', ean: text, modell: null, belege: [], varianten: []};
      const res = r ? null : await fetch('/api/produkt', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({text})});
      if (res) { r = await res.json().catch(() => ({})); if (!res.ok) throw new Error(r.error || `Produktsuche nicht erreichbar (${res.status})`); }
      found = {name: r.name || text, ean: r.ean || '', model: r.modell || '', belege: r.belege || [], varianten: r.varianten || [], by: r.by};
      showFound();
    } catch (e) {
      found = {name: text, ean: '', model: '', belege: [], varianten: [], err: e.message};
      showFound();
    } finally { clearInterval(timer); $('scan').classList.remove('on'); $('askBtn').disabled = false; }
  }
  function showFound() {
    const f = found, ok = f.ean || f.model;
    $('found').innerHTML = `<h3>${esc(f.name)}</h3>
      ${f.err ? `<p class="hint warn">${esc(f.err)}. Du kannst Modell oder EAN selbst eintragen.</p>` : ''}
      ${ok ? '' : '<p class="hint warn">Keine sichere Modellnummer oder EAN gefunden. Ohne eine davon kann die Preissuche das Produkt nicht eindeutig erkennen.</p>'}
      <div class="row">
        <label>EAN<input id="fEan" value="${esc(f.ean)}" inputmode="numeric" pattern="[0-9]{8,14}" placeholder="unbekannt"></label>
        <label>Modellnummer<input id="fModel" value="${esc(f.model)}" placeholder="unbekannt"></label>
        <label>Zielpreis € (optional)<input id="fTarget" type="number" min="1" step="1" inputmode="decimal"></label>
      </div>
      ${f.varianten.length ? `<p class="hint warn">Nicht verwechseln mit: ${f.varianten.map(esc).join(', ')} (wird getrennt gehalten)</p>` : ''}
      ${f.belege.length ? `<details><summary class="hint">${f.belege.length} Belege${f.by ? ` · geprüft mit ${esc(f.by)}` : ''}</summary><ul class="belege">${f.belege.map(b => `<li><a href="${esc(safe(b.url))}" target="_blank" rel="noopener noreferrer">${esc(b.title)}</a></li>`).join('')}</ul></details>` : ''}
      <div class="row"><button class="btn" type="button" id="fAdd">🏷 Beobachten</button><button class="btn ghost" type="button" id="fMore">Mehr Einstellungen</button></div>`;
    $('found').classList.add('on');
    $('fAdd').onclick = () => addFound(false);
    $('fMore').onclick = () => addFound(true);
  }
  function fromFound() {
    const ean = $('fEan').value.trim(), model = $('fModel').value.trim().toUpperCase().replace(/\s+/g, '');
    if (ean && !/^\d{8,14}$/.test(ean)) throw new Error('Die EAN hat 8 bis 14 Ziffern.');
    if (!ean && !model) throw new Error('Bitte EAN oder Modellnummer angeben.');
    const t = Number($('fTarget').value);
    return {id: crypto.randomUUID(), name: found.name, variant: ean || model, ...(model ? {model} : {}), target_cents: t > 0 ? Math.round(t * 100) : null,
      drop_percent: 10, new_low: true, mode: 'any', min_days: 7, cooldown_hours: 24, enabled: true, sources: {}, shops: []};
  }
  async function addFound(more) {
    let w; try { w = fromFound(); } catch (e) { toast(e.message); return; }
    if (config.products.some(x => x.variant === w.variant)) { toast('Dieses Produkt beobachtest du schon.'); return; }
    if (more) { openEditor(null, w); return; }
    $('fAdd').disabled = true;
    try {
      await saveConfig(cfg => ({...cfg, products: [...cfg.products, w]}), `Deals: ${w.name} beobachten`);
      $('found').classList.remove('on'); $('askInput').value = '';
      toast('Gespeichert. Die Preissuche startet gleich von selbst.');
    } catch (e) { toast(e.message); $('fAdd').disabled = false; }
  }

  // ---------- Bearbeiten ----------
  function openEditor(id, draft) {
    editing = id;
    const f = $('form'); f.reset();
    const w = draft || config.products.find(x => x.id === id);
    $('formTitle').textContent = id ? 'Beobachtung bearbeiten' : 'Produkt beobachten';
    $('delBtn').hidden = !id;
    f.elements.name.value = w.name || '';
    f.elements.variant.value = /^\d+$/.test(w.variant || '') ? w.variant : '';
    f.elements.model.value = w.model || (/^\d+$/.test(w.variant || '') ? '' : w.variant || '');
    f.elements.variant.readOnly = !!id; f.elements.model.readOnly = !!id && !/^\d+$/.test(w.variant || '');
    f.elements.target.value = w.target_cents == null ? '' : w.target_cents / 100;
    f.elements.drop.value = w.drop_percent ?? '';
    f.elements.mode.value = w.mode || 'any';
    f.elements.min_days.value = Math.min(30, w.min_days || 7);
    f.elements.cooldown.value = w.cooldown_hours || 24;
    f.elements.new_low.checked = !!w.new_low; f.elements.enabled.checked = w.enabled !== false;
    f.elements.shops.value = (w.shops || []).join('\n');
    f._base = w;
    $('saveStatus').textContent = ''; $('editor').showModal();
  }
  $('cancel').onclick = () => $('editor').close();
  $('delBtn').onclick = async () => {
    if (!confirm('Beobachtung entfernen? Die bisherigen Preise bleiben in der Historie.')) return;
    try { await saveConfig(cfg => ({...cfg, products: cfg.products.filter(x => x.id !== editing)}), 'Deals: Beobachtung entfernt'); $('editor').close(); toast('Entfernt.'); }
    catch (e) { $('saveStatus').textContent = e.message; }
  };
  $('form').onsubmit = async e => {
    e.preventDefault();
    const f = e.target, v = k => f.elements[k].value.trim(), button = f.querySelector('[type=submit]');
    button.disabled = true;
    try {
      const shops = [];
      for (const line of v('shops').split(/\s+/).filter(Boolean)) { const u = new URL(line); if (u.protocol !== 'https:' || u.username || u.password || u.port) throw new Error('Händler-Links müssen direkte HTTPS-Adressen sein.'); shops.push(u.href); }
      const model = v('model').toUpperCase().replace(/\s+/g, '');
      if (model && !/^[A-Z0-9][A-Z0-9\-\/.]{3,59}$/.test(model)) throw new Error('Modellnummer bitte ohne Sonderzeichen angeben.');
      if (!v('variant') && !model) throw new Error('Bitte EAN oder Modellnummer angeben.');
      if (!v('target') && !v('drop') && !f.elements.new_low.checked) throw new Error('Mindestens eine Alarmregel setzen.');
      const base = f._base || {};
      const w = {...base, id: editing || base.id || crypto.randomUUID(), name: v('name'), variant: editing ? base.variant : (v('variant') || model), ...(model ? {model} : {}), shops,
        target_cents: v('target') ? Math.round(Number(v('target')) * 100) : null, drop_percent: v('drop') ? Number(v('drop')) : null,
        new_low: f.elements.new_low.checked, mode: v('mode'), min_days: Number(v('min_days')), cooldown_hours: Number(v('cooldown')), enabled: f.elements.enabled.checked, sources: base.sources || {}};
      await saveConfig(cfg => ({...cfg, products: [...cfg.products.filter(x => x.id !== w.id), w]}), 'Deals-Watchlist aktualisiert');
      $('editor').close(); $('found').classList.remove('on'); toast('Gespeichert. Die Preissuche übernimmt es beim nächsten Lauf.');
    } catch (err) { $('saveStatus').textContent = err.message; } finally { button.disabled = false; }
  };

  // ---------- Jetzt suchen ----------
  $('runBtn').onclick = async () => {
    const b = $('runBtn'); b.disabled = true;
    try {
      await gh('workflows/deals.yml/dispatches', {method: 'POST', body: JSON.stringify({ref: 'main'})}, 'actions/');
      toast('Preissuche gestartet. Neue Preise erscheinen in etwa 5 Minuten.');
    } catch (e) { toast(e.message); } finally { setTimeout(() => { b.disabled = false; }, 4000); }
  };
  $('askForm').onsubmit = e => { e.preventDefault(); detect(); };
  load();
})();
