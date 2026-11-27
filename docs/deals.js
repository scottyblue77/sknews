(() => {
  const $ = id => document.getElementById(id);
  const read = (key, fallback) => { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } };
  const repo = read('sknews.repo', '') || 'scottyblue77/sknews';
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const euros = n => n == null ? '–' : (n / 100).toLocaleString('de-DE', {style:'currency', currency:'EUR'});
  const date = n => new Date(n * 1000).toLocaleDateString('de-DE');
  const safe = u => { try { const p = new URL(u); return ['https:', 'http:'].includes(p.protocol) && !p.username ? p.href : '#'; } catch { return '#'; } };
  let config = {products:[]}, sha, snapshot = {products:[]}, editing;
  async function gh(path, opts = {}) {
    const token = read('sknews.token', '');
    if (!token) throw new Error('Bitte zuerst auf der News-Seite unter GitHub-Synchronisierung verbinden.');
    const r = await fetch(`https://api.github.com/repos/${repo}/contents/${path}`, {...opts, cache:'no-store', headers:{Authorization:`Bearer ${token}`, Accept:'application/vnd.github+json', ...(opts.body ? {'Content-Type':'application/json'} : {})}});
    if (!r.ok) throw new Error(r.status === 409 ? 'Die Watchlist wurde parallel geändert. Neu laden und Änderung erneut speichern.' : `GitHub-Anfrage fehlgeschlagen (${r.status}).`);
    return r.json();
  }
  const decode = s => JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(s.replace(/\n/g,'')), c => c.charCodeAt(0))));
  const encode = data => { let s=''; for (const b of new TextEncoder().encode(JSON.stringify(data,null,2)+'\n')) s += String.fromCharCode(b); return btoa(s); };
  function chart(rows) {
    if (!rows?.length) return '<p class="muted">Noch keine Preisbeobachtungen.</p>';
    const min = Math.min(...rows.map(r=>r.cents)), max = Math.max(...rows.map(r=>r.cents));
    const first = rows[0].day, last = rows.at(-1).day;
    const points = rows.map(r => `${10+300*(r.day-first)/Math.max(86400,last-first)},${95-80*(r.cents-min)/Math.max(1,max-min)}`).join(' ');
    return `<svg viewBox="0 0 320 110" preserveAspectRatio="none" role="img" aria-label="Preisverlauf vom ${date(first)} bis ${date(last)}, Minimum ${esc(euros(min))}, Maximum ${esc(euros(max))}"><polyline points="${points}" fill="none" stroke="currentColor" stroke-width="2"/>${rows.map(r=>`<circle cx="${10+300*(r.day-first)/Math.max(86400,last-first)}" cy="${95-80*(r.cents-min)/Math.max(1,max-min)}" r="2" fill="currentColor"><title>${date(r.day)}: ${euros(r.cents)}</title></circle>`).join('')}</svg><div class="row muted chart-label"><span>${date(first)}</span><span>bis ${date(last)}</span></div>`;
  }
  const via = s => ({web:'Händlerseite', ki:'von KI gelesen', manual:'manuell'})[s] || s;
  function offers(s, w) {
    const now = Date.now()/1000;
    const list = (s.sources||[]).filter(o => o.available && now - o.observed <= 21600).sort((a,b) => a.cents-b.cents);
    if (!list.length) return '<p class="muted">Beim letzten Lauf kein lieferbares Angebot gefunden.</p>';
    return '<ol class="offers">' + list.slice(0, 8).map(o => `<li><a href="${esc(safe(o.url))}" target="_blank" rel="noopener noreferrer">${esc(o.merchant)}</a> · <b>${euros(o.cents)}</b> <small>${o.shipping_known===0?'+ Versand?':'inkl. Versand'} · ${esc(via(o.source))}</small></li>`).join('') + '</ol>';
  }
  function render() {
    $('empty').hidden = !!config.products.length;
    $('cards').innerHTML = config.products.map(w => {
      const s = snapshot.products?.find(x=>x.id===w.id) || {}, c=s.current;
      const stale = !snapshot.updated || Date.now()/1000-snapshot.updated>4*3600;
      const current = c && Date.now()/1000-c.observed<=21600 ? c : null;
      const statuses = (snapshot.sources_status||[]).filter(x=>x.watch===w.id);
      return `<article class="card"><span class="tag">${w.enabled ? (snapshot.updated ? 'Beobachtung aktiviert' : 'Zur Beobachtung vorgemerkt') : 'Pausiert'}</span>${stale?'<span class="tag">Datenstand prüfen</span>':''}<h3>${esc(w.name)}</h3><small>GTIN ${esc(w.variant)}</small><div class="price">${euros(current?.cents)}</div><p class="muted">${current?`${esc(current.merchant)} · ${current.shipping_known===0?'Versand nicht angegeben':'inkl. Versand'} · ${esc(via(current.source))}`:'Noch kein frisches Angebot gefunden'}</p><div class="stats"><span>Zielpreis<b>${euros(w.target_cents)}</b></span><span>30-Tage-Tief<b>${euros(s.best?.['30'])}</b></span><span>Jahrestief beobachtet<b>${euros(s.best?.['365'])}</b></span></div><p>${s.drop_percent_actual != null ? `${esc(s.drop_percent_actual)} % unter 30-Tage-Median` : `Rabattbewertung braucht mindestens ${w.min_days} gemessene Tage im letzten Monat.`}</p>${chart(s.history||[])}<details><summary>Angebote & Regeln</summary><p>${esc(w.mode==='all'?'Alle Regeln':'Mindestens eine Regel')} · ${w.cooldown_hours} h Push-Abstand</p>${offers(s, w)}<p class="muted">${statuses.filter(x=>x.url).length} Händlerseiten geprüft, ${statuses.filter(x=>x.url&&x.ok).length} mit Preis.</p><p>${s.history_days||0} beobachtete Tage. Keine vollständige Marktabdeckung zugesichert.</p></details><div class="row"><button data-edit="${esc(w.id)}">Bearbeiten</button>${current?`<a href="${esc(safe(current.url))}" target="_blank" rel="noopener noreferrer">Zum Angebot ↗</a>`:''}</div></article>`;
    }).join('');
    document.querySelectorAll('[data-edit]').forEach(b=>b.onclick=()=>open(b.dataset.edit));
  }
  async function load() {
    try {
      const r=await fetch('data/deals.json',{cache:'no-store'});
      if (r.ok) snapshot=await r.json();
      if (read('sknews.token','')) { const f=await gh('config/deals.json?ref=main'); config=decode(f.content); sha=f.sha; }
      else { const f=await fetch(`https://raw.githubusercontent.com/${repo}/main/config/deals.json`,{cache:'no-store'}); if(f.ok) config=await f.json(); }
      $('status').textContent = snapshot.updated ? `Letzte Preissuche: ${new Date(snapshot.updated*1000).toLocaleString('de-DE')}${snapshot.method?` · ${snapshot.method}`:''}` : 'Die Preissuche hat noch keine Daten geliefert. Sie läuft alle 3 Stunden.';
      render();
    } catch(e) { $('status').textContent=e.message; }
  }
  function open(id) {
    editing=id;
    const f=$('form'); f.reset();
    const w=config.products.find(x=>x.id===id);
    if(w) { for(const k of ['name','variant','mode','min_days']) f.elements[k].value=w[k]; f.elements.model.value=w.model||''; f.elements.shops.value=(w.shops||[]).join('\n'); f.elements.target.value=w.target_cents==null?'':w.target_cents/100; f.elements.drop.value=w.drop_percent??''; f.elements.cooldown.value=w.cooldown_hours; for(const k of ['new_low','enabled']) f.elements[k].checked=w[k]; for(const k of ['idealo','geizhals','billiger','guenstiger']) f.elements[k].value=w.sources?.[k]||''; }
    f.elements.variant.readOnly=!!w;
    $('saveStatus').textContent=''; $('editor').showModal();
  }
  $('add').onclick=()=>open(); $('cancel').onclick=()=>$('editor').close(); $('refresh').onclick=load;
  $('form').onsubmit=async e=> {
    e.preventDefault(); const f=e.target, v=k=>f.elements[k].value.trim();
    const button=f.querySelector('[type=submit]'); button.disabled=true;
    try {
      if(sha===undefined) { const cur=await gh('config/deals.json?ref=main'); config=decode(cur.content); sha=cur.sha; }
      const hosts={idealo:['www.idealo.de','idealo.de'], geizhals:['www.geizhals.de','geizhals.de'],billiger:['www.billiger.de','billiger.de'],guenstiger:['www.guenstiger.de','guenstiger.de']};
      const sources={}; for(const k of Object.keys(hosts)) if(v(k)) { const u=new URL(v(k)); if(u.protocol!=='https:'||!hosts[k].includes(u.hostname)||u.username||u.password||u.port) throw new Error(`Bitte eine direkte HTTPS-Produkt-URL von ${k} verwenden.`); sources[k]=u.href; }
      const shops=[]; for(const line of v('shops').split(/\s+/).filter(Boolean)) { const u=new URL(line); if(u.protocol!=='https:'||u.username||u.password||u.port) throw new Error('Händler-Links müssen direkte HTTPS-Adressen sein.'); shops.push(u.href); }
      const model=v('model').toUpperCase(); if(model && !/^[A-Z0-9][A-Z0-9\-\/.]{3,59}$/.test(model)) throw new Error('Modellnummer bitte ohne Leerzeichen angeben.');
      if(!v('target')&&!v('drop')&&!f.elements.new_low.checked) throw new Error('Mindestens eine Alarmregel setzen.');
      const w={id:editing||crypto.randomUUID(),name:v('name'),variant:v('variant'),...(model?{model}:{}),shops,target_cents:v('target')?Math.round(Number(v('target'))*100):null,drop_percent:v('drop')?Number(v('drop')):null,new_low:f.elements.new_low.checked,mode:v('mode'),min_days:Number(v('min_days')),cooldown_hours:Number(v('cooldown')),enabled:f.elements.enabled.checked,sources};
      const next={...config,products:[...config.products.filter(x=>x.id!==w.id),w]};
      const result=await gh('config/deals.json',{method:'PUT',body:JSON.stringify({message:'Deals-Watchlist aktualisiert',content:encode(next),branch:'main',sha})});
      config=next; sha=result.content.sha; $('editor').close();render(); $('status').textContent='Watchlist gespeichert. Die Preissuche übernimmt sie beim nächsten Lauf (alle 3 Stunden).';
    } catch(err) { $('saveStatus').textContent=err.message; } finally { button.disabled=false; }
  };
  load();
})();
