// HUD-Layout ("Jarvis") für SKNews. Legt sich über die bestehende Seite, ohne deren Logik zu ändern:
// - setzt html.hud (Aussehen in hud.css), Umschalter "Klassisch" / "HUD" in der Kopfzeile
// - ordnet die News-Seite in drei Spalten: Themen-Radar | Lagezentrum + News | Gedanken und Lernen
// - Startsequenz, Partikel-Hintergrund, Uhr, Karten-Einflug, Lichtkegel unter dem Mauszeiger
// Daten kommen nur über window.SKNews, die Ereignisse "sknews:topics-changed" und die öffentlichen JSON-Dateien.
(() => {
  const KEY = "sknews.layout", BOOT = "sknews.hudBooted";
  const ls = { get(k, d){ try { return localStorage.getItem(k) ?? d; } catch { return d; } }, set(k, v){ try { localStorage.setItem(k, v); } catch {} } };
  const ss = { get(k){ try { return sessionStorage.getItem(k); } catch { return "1"; } }, set(k){ try { sessionStorage.setItem(k, "1"); } catch {} } };
  const on = ls.get(KEY, "hud") !== "classic";
  const root = document.documentElement;
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const boot = on && !reduce && !ss.get(BOOT);
  if (on) root.classList.add("hud");
  if (boot) root.classList.add("hud-boot");

  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  const h = (html) => { const t = document.createElement("template"); t.innerHTML = html.trim(); return t.content.firstElementChild; };

  document.addEventListener("DOMContentLoaded", () => {
    addSwitch();
    if (!on) return;
    try { if (boot) bootSequence(); } catch { root.classList.remove("hud-boot"); }
    reactor(); clock(); background(); spotlight(); votePop();
    if (document.getElementById("main") && document.getElementById("tabs")) layout();
    headerHeight();
  });

  // ---------- Umschalter ----------
  function addSwitch(){
    const row = document.querySelector(".top-row"); if (!row) return;
    const b = h(`<button type="button" class="hud-switch" title="${on ? "Zum klassischen Layout wechseln" : "Zum HUD-Layout wechseln"}">${on ? "Klassisch" : "HUD-Layout"}</button>`);
    b.addEventListener("click", () => { ls.set(KEY, on ? "classic" : "hud"); location.reload(); });
    row.append(b);
  }

  // ---------- Kopfzeile ----------
  const REACTOR = (cls = "hud-reactor") => `<svg class="${cls}" viewBox="-50 -50 100 100" aria-hidden="true">
    <defs><radialGradient id="hudCore"><stop offset="0" stop-color="#fff"/><stop offset=".35" stop-color="#9ff3ff"/><stop offset="1" stop-color="#38e1ff" stop-opacity="0"/></radialGradient></defs>
    <circle class="r1" r="44" fill="none" stroke="#38e1ff" stroke-width="2" stroke-dasharray="40 10 6 10" opacity=".85"/>
    <circle class="r2" r="34" fill="none" stroke="#38e1ff" stroke-width="5" stroke-dasharray="3 6" opacity=".55"/>
    <circle class="r3" r="25" fill="none" stroke="#ffb547" stroke-width="1.5" stroke-dasharray="60 20" opacity=".7"/>
    <circle class="core" r="16" fill="url(#hudCore)"/>
  </svg>`;
  function reactor(){
    const h1 = document.querySelector("h1"); if (!h1 || h1.querySelector(".hud-reactor")) return;
    h1.prepend(h(REACTOR()));
  }
  function clock(){
    const row = document.querySelector(".top-row"); if (!row) return;
    const el = h(`<div class="hud-clock" aria-hidden="true"></div>`);
    const anchor = row.querySelector(".search") || row.querySelector(".sub");
    anchor ? anchor.before(el) : row.append(el);
    const tick = () => {
      if (document.hidden) return;
      const d = new Date();
      el.innerHTML = `${d.toLocaleTimeString("de-DE")}<small>${d.toLocaleDateString("de-DE", { weekday: "short", day: "2-digit", month: "short" }).toUpperCase()}</small>`;
    };
    tick(); setInterval(tick, 1000);
  }
  function headerHeight(){
    const top = document.querySelector(".top"); if (!top) return;
    const set = () => root.style.setProperty("--hdr-h", top.offsetHeight + "px");
    set();
    if ("ResizeObserver" in window) new ResizeObserver(set).observe(top);
  }

  // ---------- Startsequenz (einmal pro Sitzung) ----------
  function bootSequence(){
    ss.set(BOOT);
    const ov = h(`<div class="hud-boot-ov" role="presentation"><div class="bx">${REACTOR("")}<div class="ln"></div><div class="bar"><i></i></div></div></div>`);
    document.body.append(ov);
    const ln = ov.querySelector(".ln");
    const lines = ["SKNews System online", "Verbinde Nachrichtenquellen", "Lade Interessenprofil", "Lagebild bereit"];
    let i = 0;
    const step = setInterval(() => { if (i < lines.length) ln.insertAdjacentHTML("beforeend", `<div>${esc(lines[i++])}</div>`); }, 320);
    const end = () => {
      clearInterval(step);
      ov.classList.add("out");
      root.classList.remove("hud-boot");
      setTimeout(() => ov.remove(), 700);
    };
    ov.addEventListener("click", end);
    setTimeout(end, 1650);
  }

  // ---------- Partikelnetz im Hintergrund ----------
  function background(){
    const cv = document.createElement("canvas");
    cv.className = "hud-bg"; cv.setAttribute("aria-hidden", "true");
    document.body.prepend(cv);
    const ctx = cv.getContext("2d"); if (!ctx) return;
    let w, hgt, dpr, pts = [];
    const mouse = { x: -9999, y: -9999 };
    function size(){
      dpr = Math.min(2, devicePixelRatio || 1);
      w = innerWidth; hgt = innerHeight;
      cv.width = w * dpr; cv.height = hgt * dpr; ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const n = Math.round(Math.min(90, w * hgt / 22000));
      pts = Array.from({ length: n }, () => ({ x: Math.random() * w, y: Math.random() * hgt, vx: (Math.random() - .5) * .25, vy: (Math.random() - .5) * .25, r: Math.random() * 1.4 + .4, a: Math.random() < .12 }));
    }
    function draw(){
      ctx.clearRect(0, 0, w, hgt);
      const max = 130;
      for (let i = 0; i < pts.length; i++){
        const p = pts[i];
        if (!reduce){ p.x += p.vx; p.y += p.vy; if (p.x < 0 || p.x > w) p.vx *= -1; if (p.y < 0 || p.y > hgt) p.vy *= -1; }
        for (let j = i + 1; j < pts.length; j++){
          const q = pts[j], dx = p.x - q.x, dy = p.y - q.y, d = dx * dx + dy * dy;
          if (d < max * max){ ctx.strokeStyle = `rgba(56,225,255,${(1 - Math.sqrt(d) / max) * .16})`; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(q.x, q.y); ctx.stroke(); }
        }
        const md = Math.hypot(p.x - mouse.x, p.y - mouse.y);
        if (md < 180){ ctx.strokeStyle = `rgba(56,225,255,${(1 - md / 180) * .35})`; ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(mouse.x, mouse.y); ctx.stroke(); }
        ctx.fillStyle = p.a ? "rgba(255,181,71,.8)" : "rgba(120,235,255,.7)";
        ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2); ctx.fill();
      }
    }
    let raf = 0;
    const loop = () => { draw(); raf = requestAnimationFrame(loop); };
    size();
    addEventListener("resize", () => { size(); if (reduce) draw(); });
    addEventListener("pointermove", e => { mouse.x = e.clientX; mouse.y = e.clientY; }, { passive: true });
    if (reduce) { draw(); return; }
    loop();
    document.addEventListener("visibilitychange", () => { cancelAnimationFrame(raf); if (!document.hidden) loop(); });
  }

  // ---------- Lichtkegel auf Karten, Abstimmen mit kleinem Puls ----------
  function spotlight(){
    document.addEventListener("pointermove", e => {
      const c = e.target.closest?.(".card"); if (!c) return;
      const r = c.getBoundingClientRect();
      c.style.setProperty("--mx", (e.clientX - r.left) + "px");
      c.style.setProperty("--my", (e.clientY - r.top) + "px");
    }, { passive: true });
  }
  let lastVote = null;
  function votePop(){
    document.addEventListener("click", e => { const b = e.target.closest?.(".vote"); if (b) lastVote = b.dataset.id + "|" + b.dataset.vote; }, true);
  }

  // ---------- Drei-Spalten-Layout der News-Seite ----------
  function layout(){
    const wrap = document.querySelector(".wrap"), main = document.getElementById("main"), tabs = document.getElementById("tabs");
    const tabsRow = tabs.closest(".top-row");
    const grid = h(`<div class="hud-grid">
      <aside class="hud-rail" aria-label="Themen">
        <div class="hud-panel hud-radar"><div class="hud-label">Themen-Radar</div><svg viewBox="-150 -140 300 280" role="img" aria-label="News-Rating je Thema"></svg><div class="legend"><span><i></i>Rating</span><span><i class="a"></i>Aktivität 3 Tage</span></div></div>
        <div class="hud-label">Kanäle</div>
      </aside>
      <div class="hud-center"></div>
      <aside class="hud-side" aria-label="Gedanken und Lernen"></aside>
    </div>`);
    const rail = grid.querySelector(".hud-rail"), center = grid.querySelector(".hud-center"), side = grid.querySelector(".hud-side");
    main.before(grid);
    rail.append(tabs);
    rail.append(h(`<div class="hud-stats" id="hudStats"></div>`));
    if (tabsRow && !tabsRow.children.length) tabsRow.classList.add("hud-empty");
    const brief = h(`<section class="hud-brief" id="hudBrief" aria-label="Lagezentrum" hidden></section>`);
    center.append(brief, main);
    ["gedanken", "prefs"].forEach(id => { const el = document.getElementById(id); if (el) side.append(el); });
    // Sprung zu den Gedanken: in der Seitenleiste scrollt nur die Leiste
    addEventListener("hashchange", () => { if (location.hash === "#gedanken") setTimeout(() => document.getElementById("gedanken")?.scrollIntoView({ block: "start" }), 50); });

    const data = { arts: [], lastRun: "" };
    const api = () => window.SKNews;
    const topicsList = () => api()?.topics?.() || [];

    function radar(){
      const svg = rail.querySelector(".hud-radar svg"), ts = topicsList();
      if (ts.length < 3){ svg.closest(".hud-radar").hidden = true; return; }
      svg.closest(".hud-radar").hidden = false;
      const n = ts.length, R = 92, maxR = Math.max(.1, ...ts.map(t => t.rating)) * 1.12;
      const now = Date.now(), vol = ts.map(t => data.arts.filter(a => a.topic === t.id && now - new Date(a.published || a.fetchedAt) < 3 * 864e5).length), maxV = Math.max(1, ...vol);
      const ang = i => -Math.PI / 2 + i * 2 * Math.PI / n;
      const pt = (i, f) => [Math.cos(ang(i)) * R * f, Math.sin(ang(i)) * R * f];
      const rings = [.25, .5, .75, 1].map(f => `<polygon class="ring" points="${ts.map((_, i) => pt(i, f).join(",")).join(" ")}"/>`).join("");
      const axes = ts.map((_, i) => `<line class="axis" x1="0" y1="0" x2="${pt(i, 1)[0]}" y2="${pt(i, 1)[1]}"/>`).join("");
      const vals = ts.map((t, i) => pt(i, Math.max(.06, Math.min(1, t.rating / maxR))));
      const labels = ts.map((t, i) => {
        const [x, y] = pt(i, 1.2), a = Math.abs(x) < 8 ? "middle" : x > 0 ? "start" : "end";
        const short = t.name.split(/\s+/)[0].slice(0, 9);
        return `<text x="${x.toFixed(1)}" y="${(y + 3).toFixed(1)}" text-anchor="${a}" data-t="${esc(t.id)}" style="${t.mode === "off" ? "fill:var(--bad)" : ""}"><title>${esc(t.name)} · ${t.rating.toFixed(1)}</title>${esc(short)}</text>`;
      }).join("");
      svg.innerHTML = `<defs><linearGradient id="hudSweep" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#38e1ff" stop-opacity="0"/><stop offset="1" stop-color="#38e1ff" stop-opacity=".35"/></linearGradient></defs>
        ${rings}${axes}
        <g class="sweep"><circle r="${R}" fill="none"/><path d="M0 0 L${R} 0 A${R} ${R} 0 0 0 ${(Math.cos(-.6) * R).toFixed(1)} ${(Math.sin(-.6) * R).toFixed(1)} Z" fill="url(#hudSweep)"/></g>
        <polygon class="act" points="${ts.map((_, i) => pt(i, Math.max(.05, vol[i] / maxV * .95)).map(x => x.toFixed(1)).join(",")).join(" ")}"><title>Artikel der letzten 3 Tage</title></polygon>
        <polygon class="area" points="${vals.map(v => v.map(x => x.toFixed(1)).join(",")).join(" ")}"/>
        ${vals.map((v, i) => `<circle class="pt" cx="${v[0].toFixed(1)}" cy="${v[1].toFixed(1)}" r="4.5" style="fill:${ts[i].mode === "off" ? "var(--bad)" : ts[i].color}"/>`).join("")}
        ${labels}`;
      svg.querySelectorAll("text[data-t]").forEach(el => el.addEventListener("click", () => api()?.filter(el.dataset.t)));
    }

    // Balken in der Kanalliste: Anteil am höchsten News-Rating
    function tabBars(){
      const ts = topicsList(), maxR = Math.max(1, ...ts.map(t => t.rating));
      tabs.querySelectorAll(".tab[data-f]").forEach(b => {
        const t = ts.find(x => x.id === b.dataset.f);
        b.style.setProperty("--rv", t ? Math.max(0, t.rating / maxR).toFixed(3) : "1");
      });
    }

    async function loadArticles(){
      try {
        const st = await fetch("data/status.json", { cache: "no-cache" }).then(r => r.ok ? r.json() : null);
        if (st && st.lastRun === data.lastRun && data.arts.length) return false;
        const d = await fetch("data/articles.json", { cache: "no-cache" }).then(r => r.ok ? r.json() : null);
        data.arts = d?.articles || [];
        data.lastRun = st?.lastRun || "";
        return true;
      } catch { return false; }
    }

    function stats(){
      const now = Date.now(), day = 864e5, ts = topicsList();
      const known = new Set(ts.map(t => t.id));
      const arts = data.arts.filter(a => known.has(a.topic));
      const fresh = arts.filter(a => now - new Date(a.published || a.fetchedAt) < day).length;
      const vids = arts.filter(a => a.kind === "video").length;
      const srcs = new Set(arts.map(a => a.source).filter(Boolean)).size;
      document.getElementById("hudStats").innerHTML = [[arts.length, "Artikel"], [fresh, "Neu 24 h"], [srcs, "Quellen"], [vids, "Videos"]]
        .map(([v, l]) => `<div class="hud-stat"><b data-count="${v}">${v}</b><span>${l}</span></div>`).join("");
    }

    function lageCache(){ try { return JSON.parse(localStorage.getItem("sknews.lage") || "{}") || {}; } catch { return {}; } }
    function ago(iso){
      const d = (Date.now() - new Date(iso)) / 36e5;
      if (!isFinite(d)) return "";
      return d < 1 ? "gerade eben" : d < 24 ? `vor ${Math.round(d)} Std.` : `vor ${Math.round(d / 24)} Tg.`;
    }

    function renderBrief(){
      const a = api();
      const show = a && a.current === "all" && !(document.getElementById("q")?.value || "").trim();
      brief.hidden = !show;
      if (!show) return;
      const ts = topicsList().filter(t => t.mode !== "off");
      if (!ts.length){ brief.hidden = true; return; }
      const cache = lageCache(), now = Date.now(), day = 864e5;
      const cards = ts.map((t, i) => {
        const arts = data.arts.filter(x => x.topic === t.id);
        const days = Array.from({ length: 7 }, (_, k) => arts.filter(x => { const age = (now - new Date(x.published || x.fetchedAt)) / day; return age >= 6 - k && age < 7 - k; }).length);
        const last = days[6], prev = days.slice(0, 6).reduce((s, v) => s + v, 0) / 6;
        const trend = prev ? Math.round((last - prev) / prev * 100) : (last ? 100 : 0);
        const mx = Math.max(1, ...days);
        const bars = days.map((v, k) => { const bh = Math.max(2, v / mx * 30); return `<rect class="${k === 6 ? "today" : ""}" style="--d:${k}" x="${k * 14.3 + 1}" y="${34 - bh}" width="11" height="${bh}" rx="1.5"><title>${v} Artikel</title></rect>`; }).join("");
        const c = cache[t.id], kern = c?.data?.kern;
        return `<article class="brief" data-re="${esc(t.id)}" style="--c:${t.color};--i:${i}">
          <div class="b-top"><span class="dot"></span><b>${t.mode === "relevant" ? "★ " : ""}${esc(t.name)}</b><span class="b-r" title="News-Rating">${t.rating.toFixed(1)}</span><button type="button" data-f="${esc(t.id)}" aria-label="${esc(t.name)} mit Lage-Analyse öffnen">Analyse →</button></div>
          <svg viewBox="0 0 100 34" preserveAspectRatio="none" aria-hidden="true">${bars}</svg>
          <div class="b-nums"><span><b>${last}</b>heute</span><span><b>${arts.length}</b>gesamt</span><span class="${trend > 0 ? "up" : trend < 0 ? "down" : ""}">${trend > 0 ? "▲ +" : trend < 0 ? "▼ " : "■ "}${trend}%</span></div>
          <p class="b-kern${kern ? "" : " none"}">${kern ? esc(kern) : "Noch keine KI-Lage. Antippen, die KI ordnet die Artikel ein."}</p>
          ${c ? `<small>Lage ${esc(ago(c.at))}${c.by ? " · " + esc(c.by) : ""}</small>` : ""}
        </article>`;
      }).join("");
      brief.innerHTML = `<div class="hud-brief-head"><h2>Lage<span>zentrum</span></h2><p>Analyse statt Schlagzeilen · Balken = Artikel der letzten 7 Tage</p></div><div class="brief-grid">${cards}</div>`;
    }

    // Karten nur beim ersten Erscheinen einfliegen lassen, nicht bei jedem Neuzeichnen (z. B. nach + / −)
    const seen = new Set();
    function animateCards(){
      let i = 0;
      main.querySelectorAll(".card").forEach(c => {
        const id = c.querySelector("[data-id]")?.dataset.id || c.querySelector("a")?.href;
        if (!seen.has(id) && !reduce){ c.classList.add("hud-in"); c.style.setProperty("--i", Math.min(i++, 14)); }
        seen.add(id);
      });
      if (lastVote){
        const [id, v] = lastVote.split("|");
        main.querySelector(`.vote[data-id="${CSS.escape(id)}"][data-vote="${CSS.escape(v)}"]`)?.classList.add("pop");
        lastVote = null;
      }
    }

    let briefKey = "";
    function refresh(){
      tabBars();
      const k = (api()?.current || "") + "|" + (document.getElementById("q")?.value || "") + "|" + data.lastRun + "|" + JSON.stringify(topicsList()) + "|" + localStorage.getItem("sknews.lage")?.length;
      if (k !== briefKey){ briefKey = k; renderBrief(); }
    }
    new MutationObserver(() => { animateCards(); refresh(); }).observe(main, { childList: true });
    new MutationObserver(tabBars).observe(tabs, { childList: true });
    let t1;
    addEventListener("sknews:topics-changed", () => {
      clearTimeout(t1);
      t1 = setTimeout(async () => { radar(); await loadArticles(); radar(); stats(); briefKey = ""; refresh(); }, 120);
    });
    (async () => { radar(); animateCards(); await loadArticles(); radar(); stats(); refresh(); })();
  }
})();
