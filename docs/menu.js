// Gemeinsames Seitenmenü für alle SKNews-Seiten.
// Fügt einen Menü-Knopf in .top-row ein und öffnet eine animierte Seitenleiste
// mit den Seiten und den Favoriten aus der Linksammlung (localStorage "sknews.links").
(() => {
  const PAGES = [
    { href: "./", file: "index.html", label: "News", icon: "📰" },
    { href: "links.html", file: "links.html", label: "Netzwerk", icon: "🖧" },
  ];
  const LINKS_KEY = "sknews.links";

  const css = `
.menu-btn{flex:none;width:40px;height:40px;border-radius:10px;border:1px solid var(--line);background:var(--panel);color:var(--ink);cursor:pointer;display:grid;place-items:center;padding:0}
.menu-btn span,.menu-btn span::before,.menu-btn span::after{display:block;width:18px;height:2px;border-radius:2px;background:currentColor;position:relative;transition:transform .3s cubic-bezier(.6,.05,.3,1.2),background .2s}
.menu-btn span::before,.menu-btn span::after{content:"";position:absolute;left:0}
.menu-btn span::before{top:-6px}.menu-btn span::after{top:6px}
.menu-open .menu-btn span{background:transparent}
.menu-open .menu-btn span::before{transform:translateY(6px) rotate(45deg)}
.menu-open .menu-btn span::after{transform:translateY(-6px) rotate(-45deg)}
.menu-scrim{position:fixed;inset:0;z-index:40;background:rgb(0 0 0 / .4);opacity:0;pointer-events:none;transition:opacity .3s}
.menu-open .menu-scrim{opacity:1;pointer-events:auto}
.menu-panel{position:fixed;z-index:41;top:0;left:0;bottom:0;width:min(320px,86vw);background:var(--panel);color:var(--ink);border-right:1px solid var(--line);box-shadow:var(--shadow);transform:translateX(-105%);transition:transform .38s cubic-bezier(.2,.8,.2,1);display:flex;flex-direction:column;overflow-y:auto;padding:18px 14px 28px;gap:18px}
.menu-open .menu-panel{transform:none}
.menu-panel .mh{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:0 6px}
.menu-panel .mh b{font:800 22px/1 var(--f-display);letter-spacing:-.02em}
.menu-panel .mh b span{color:var(--accent)}
.menu-panel .mx{all:unset;cursor:pointer;color:var(--muted);font-size:22px;line-height:1;padding:4px 8px;border-radius:6px}
.menu-panel .mx:hover{color:var(--ink)}
.menu-panel h5{font:600 11px/1 var(--f-mono);text-transform:uppercase;letter-spacing:.08em;color:var(--muted);margin:0 0 6px;padding:0 8px}
.menu-panel nav{display:flex;flex-direction:column;gap:2px}
.menu-panel nav a{display:flex;align-items:center;gap:12px;padding:10px 10px;border-radius:10px;color:var(--ink);text-decoration:none;font:600 15px var(--f-body);
  opacity:0;transform:translateX(-14px);transition:opacity .3s,transform .35s cubic-bezier(.2,.8,.2,1),background .15s;transition-delay:calc(var(--i,0) * 35ms + 80ms)}
.menu-open .menu-panel nav a{opacity:1;transform:none}
.menu-panel nav a:hover{background:var(--chip)}
.menu-panel nav a[aria-current="page"]{background:var(--accent);color:var(--accent-ink)}
.menu-panel nav a .mi{width:28px;height:28px;flex:none;display:grid;place-items:center;border-radius:8px;background:var(--chip);font-size:15px}
.menu-panel nav a[aria-current="page"] .mi{background:rgb(255 255 255 / .2)}
.menu-panel nav a small{display:block;font:400 11px var(--f-mono);color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.menu-panel nav a .mt{min-width:0}
.menu-panel .mempty{font-size:13px;color:var(--muted);padding:0 10px;margin:0}
.menu-panel .mempty a{color:var(--accent)}
@media (prefers-reduced-motion:reduce){.menu-panel,.menu-scrim,.menu-panel nav a,.menu-btn span,.menu-btn span::before,.menu-btn span::after{transition:none!important}}
`;

  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  const host = u => { try { const x = new URL(u); return x.host; } catch { return u; } };
  function readLinks(){
    try { const d = JSON.parse(localStorage.getItem(LINKS_KEY) || "null"); return Array.isArray(d?.links) ? d.links : []; }
    catch { return []; }
  }

  const style = document.createElement("style");
  style.textContent = css;
  document.head.appendChild(style);

  const here = location.pathname.split("/").pop() || "index.html";
  const btn = document.createElement("button");
  btn.className = "menu-btn"; btn.type = "button";
  btn.setAttribute("aria-label", "Menü öffnen"); btn.setAttribute("aria-expanded", "false"); btn.setAttribute("aria-controls", "menuPanel");
  btn.innerHTML = "<span></span>";
  const row = document.querySelector(".top-row");
  if (row) row.prepend(btn); else document.body.prepend(btn);

  const scrim = document.createElement("div");
  scrim.className = "menu-scrim";
  const panel = document.createElement("aside");
  panel.className = "menu-panel"; panel.id = "menuPanel"; panel.setAttribute("aria-label", "Menü"); panel.inert = true;
  document.body.append(scrim, panel);

  function render(){
    const links = readLinks();
    const favs = links.filter(l => l.fav);
    const quick = (favs.length ? favs : links).slice(0, 12);
    let i = 0;
    const pageItems = PAGES.map(p => `<a href="${p.href}" style="--i:${i++}" ${p.file === here ? 'aria-current="page"' : ""}><span class="mi">${p.icon}</span><span class="mt">${p.label}</span></a>`).join("");
    const linkItems = quick.map(l => `<a href="${esc(l.url)}" target="_blank" rel="noopener" style="--i:${i++}"><span class="mi">${esc(l.icon || (l.name || host(l.url)).trim().charAt(0).toUpperCase())}</span><span class="mt">${esc(l.name)}<small>${esc(host(l.url))}</small></span></a>`).join("");
    panel.innerHTML = `
      <div class="mh"><b>SK<span>News</span></b><button class="mx" type="button" aria-label="Menü schließen">×</button></div>
      <div><h5>Seiten</h5><nav>${pageItems}</nav></div>
      <div><h5>${favs.length ? "Favoriten" : "Dienste"}</h5>${linkItems ? `<nav>${linkItems}</nav>` : `<p class="mempty">Noch keine Dienste. <a href="links.html">Jetzt anlegen</a></p>`}</div>`;
    panel.querySelector(".mx").addEventListener("click", () => toggle(false));
  }

  function toggle(open){
    if (open) render();
    document.documentElement.classList.toggle("menu-open", open);
    btn.setAttribute("aria-expanded", String(open));
    btn.setAttribute("aria-label", open ? "Menü schließen" : "Menü öffnen");
    panel.inert = !open;
    if (open) setTimeout(() => panel.querySelector("nav a")?.focus(), 60); else btn.focus();
  }
  btn.addEventListener("click", () => toggle(btn.getAttribute("aria-expanded") !== "true"));
  scrim.addEventListener("click", () => toggle(false));
  document.addEventListener("keydown", e => { if (e.key === "Escape" && btn.getAttribute("aria-expanded") === "true") toggle(false); });
  window.addEventListener("sknews:links-changed", () => { if (btn.getAttribute("aria-expanded") === "true") render(); });
})();
