// Produkt erkennen für "Zu Deals hinzufügen" (Cloudflare Pages Function, /api/produkt).
//
// POST {text}  Freitext wie "Samsung Odyssey Neo G9 57 Zoll" oder ein Satz aus der KI-Recherche.
//              Sucht im Netz (Bing, sonst DuckDuckGo), lässt die KI Name, Modellnummer und EAN
//              aus den Suchtreffern lesen und prüft beides gegen die Treffer:
//              - die EAN muss in den Treffern stehen und eine gültige Prüfziffer haben
//              - die Modellnummer muss wörtlich in den Treffern stehen
//              Antwort: {name, modell, ean, varianten, belege:[{title,url}], by}
//
// KI wie in ideen.js: Workers AI (Bindung AI), sonst Gemini (Secret GEMINI_API_KEY). Ohne KI wird
// die häufigste gültige EAN aus den Treffern genommen.

const MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
const GEMINI_MODEL = "gemini-2.5-flash";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";

const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
});
const cut = (s, n) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);
const decode = s => String(s || "")
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/<[^>]+>/g, " ")
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n)).replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
const norm = s => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");

export function gtinOk(code){
  if (!/^\d{8}$|^\d{12,14}$/.test(code)) return false;
  const d = code.split("").map(Number), check = d.pop();
  const sum = d.reverse().reduce((s, x, i) => s + x * (i % 2 ? 1 : 3), 0);
  return (10 - (sum % 10)) % 10 === check;
}

async function bing(q){
  const r = await fetch(`https://www.bing.com/search?format=rss&cc=DE&setlang=de-DE&count=20&q=${encodeURIComponent(q)}`,
    { headers: { "user-agent": UA, "accept-language": "de-DE,de;q=0.9" }, cf: { cacheTtl: 3600 } });
  if (!r.ok) throw new Error(`Bing ${r.status}`);
  const xml = await r.text();
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map(m => ({
    title: cut(decode((m[1].match(/<title>([\s\S]*?)<\/title>/) || [])[1]), 200),
    url: decode((m[1].match(/<link>([\s\S]*?)<\/link>/) || [])[1]),
    text: cut(decode((m[1].match(/<description>([\s\S]*?)<\/description>/) || [])[1]), 400),
  })).filter(x => x.url.startsWith("http"));
}

async function ddg(q){
  const r = await fetch(`https://html.duckduckgo.com/html/?kl=de-de&q=${encodeURIComponent(q)}`, { headers: { "user-agent": UA }, cf: { cacheTtl: 3600 } });
  if (!r.ok) throw new Error(`DuckDuckGo ${r.status}`);
  const html = await r.text();
  return html.split(/class="result[ _]/).slice(1).map(b => {
    const href = (b.match(/href="([^"]*uddg=[^"]+)"/) || [])[1] || "";
    let url = ""; try { url = new URL(decode(href), "https://duckduckgo.com").searchParams.get("uddg") || ""; } catch {}
    return { title: cut(decode((b.match(/class="result__a"[^>]*>([\s\S]*?)<\/a>/) || [])[1]), 200), url,
             text: cut(decode((b.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/) || [])[1]), 400) };
  }).filter(x => x.url.startsWith("http"));
}

async function treffer(text){
  const qs = [`${text} EAN`, `${text} Modellnummer kaufen`];
  const out = [], seen = new Set();
  for (const q of qs) {
    let list = [];
    try { list = await bing(q); } catch {}
    if (!list.length) { try { list = await ddg(q); } catch {} }
    for (const t of list) if (!seen.has(t.url)) { seen.add(t.url); out.push(t); }
  }
  return out.slice(0, 24);
}

async function frageKI(env, prompt){
  if (env.AI) {
    const r = await env.AI.run(MODEL, { messages: [{ role: "user", content: prompt }], max_tokens: 500, temperature: 0.1 });
    const s = typeof r?.response === "string" ? r.response : JSON.stringify(r?.response ?? "");
    return { data: JSON.parse(s.slice(s.indexOf("{"), s.lastIndexOf("}") + 1)), by: "Workers AI" };
  }
  if (env.GEMINI_API_KEY) {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`, {
      method: "POST", headers: { "content-type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: "application/json", temperature: 0.1, maxOutputTokens: 600, thinkingConfig: { thinkingBudget: 0 } } }),
    });
    if (!r.ok) throw new Error(`Gemini ${r.status}`);
    const d = await r.json();
    return { data: JSON.parse(d.candidates[0].content.parts[0].text), by: "Gemini" };
  }
  return null;
}

export async function erkenne(text, env, suche = treffer){
  const hits = await suche(text);
  const hay = hits.map(h => `${h.title} ${h.text} ${h.url}`).join(" \n ");
  const hayN = norm(hay);
  const eans = {};
  for (const m of hay.matchAll(/(?<!\d)(\d{13}|\d{12}|\d{8})(?!\d)/g)) if (gtinOk(m[1])) eans[m[1]] = (eans[m[1]] || 0) + 1;
  const belegt = Object.keys(eans).sort((a, b) => eans[b] - eans[a]);
  let res = { name: cut(text, 120), modell: null, ean: belegt[0] || null, varianten: [], by: "" };
  try {
    const ki = await frageKI(env, `Sebastian will den Preis eines Produkts beobachten. Seine Beschreibung: "${cut(text, 300)}"

Suchtreffer:
${hits.slice(0, 18).map((h, i) => `[${i + 1}] ${h.title} | ${h.text}`).join("\n")}

Welches konkrete Produkt meint er? Antworte nur mit JSON:
{"name": "kurzer Produktname mit Hersteller und Größe", "modell": "Herstellernummer genau wie in den Treffern oder null",
 "ean": "13-stellige EAN genau wie in den Treffern oder null", "varianten": ["andere Modellnummern, die leicht verwechselt werden"]}
Nichts erfinden: Modellnummer und EAN nur, wenn sie in den Treffern stehen.`);
    if (ki) {
      const d = ki.data || {};
      const modell = cut(d.modell, 60).replace(/\s+/g, "");
      const ean = String(d.ean || "").replace(/\D/g, "");
      res = {
        name: cut(d.name, 120) || res.name,
        modell: modell && modell.length >= 4 && hayN.includes(norm(modell)) ? modell.toUpperCase() : null,
        ean: gtinOk(ean) && eans[ean] ? ean : res.ean,
        varianten: (Array.isArray(d.varianten) ? d.varianten : []).map(v => cut(v, 40)).filter(v => v && hayN.includes(norm(v))).slice(0, 4),
        by: ki.by,
      };
    }
  } catch (e) { res.fehler = cut(e?.message || e, 120); }
  const key = [res.ean, res.modell && norm(res.modell)].filter(Boolean);
  res.belege = hits.filter(h => key.some(k => norm(`${h.title} ${h.text} ${h.url}`).includes(k))).slice(0, 5)
    .map(h => ({ title: h.title, url: h.url }));
  res.treffer = hits.length;
  return res;
}

export async function onRequestPost({ request, env }){
  const origin = request.headers.get("origin");
  if (origin && new URL(origin).host !== new URL(request.url).host) return json({ error: "fremde Herkunft" }, 403);
  let b; try { b = await request.json(); } catch { return json({ error: "kein JSON" }, 400); }
  const text = cut(b?.text, 300);
  if (text.length < 3) return json({ error: "zu wenig Text" }, 400);
  try { return json(await erkenne(text, env)); }
  catch (e) { return json({ error: cut(e?.message || e, 200) }, 502); }
}
