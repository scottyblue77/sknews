// KI-Helfer für das Gedanken-Feld im Dashboard (Cloudflare Pages Function, /api/ideen).
//
// GET                 Status: welche KI eingerichtet ist ({ki: "Workers AI" | "Gemini" | null}),
//                     mit ?test=1 zusätzlich ein kleiner Probeaufruf ({ok, ms})
// POST mode:
//   "vorschlag"  beim Tippen bis zu 6 kurze Vorschläge
//   "verstehen"  beim Absenden: was will Sebastian wissen, sinnvolle Schlagworte (Wortgruppen),
//                2 bis 3 vollständige News-Suchanfragen, Verbindungen, Themen-Ideen
//   "suchen"     holt für die Suchanfragen sofort aktuelle Artikel (Bing News, sonst Google News),
//                ohne KI
//   "antwort"    beantwortet den Gedanken aus den gefundenen Artikeln, mit Quellennummern
//   "lage"       Einordnung der aktuellen Artikel eines Themas
//
// KI: Workers AI über die Bindung "AI" (Pages → Settings → Bindings → Workers AI, Name AI).
// Ohne Bindung, aber mit Secret GEMINI_API_KEY wird Gemini benutzt. Ohne beides antworten die
// KI-Modi mit 503 und das Dashboard arbeitet nur mit eigenen Begriffen.

// Vorschläge beim Tippen kommen oft und müssen schnell sein: kleines Modell. Der Rest braucht
// gutes Deutsch und Sorgfalt: großes Modell.
const BIG = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
const WORKERS_MODEL = { vorschlag: "@cf/meta/llama-3.1-8b-instruct-fast", verstehen: BIG, antwort: BIG, lage: BIG };
const GEMINI_MODEL = "gemini-2.5-flash";
const MAX_TOKENS = { vorschlag: 300, verstehen: 700, antwort: 1400, lage: 1300 };
const UA = "Mozilla/5.0 (compatible; SKNews/1.0)";

const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
});

const cut = (s, n) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);
const list = (a, n, len = 60) => (Array.isArray(a) ? a : a ? [a] : []).map(x => cut(x, len)).filter(Boolean).slice(0, n);
const nums = (a, max) => (Array.isArray(a) ? a : []).map(Number).filter(n => Number.isInteger(n) && n > 0 && n <= max).slice(0, 6);

function artikelListe(arts){
  return arts.map((a, i) => `[${i + 1}] ${cut(a?.title, 200)} (${cut(a?.source, 40)}, ${cut(a?.date, 10)})${a?.summary ? ": " + cut(a.summary, 300) : ""}`).join("\n");
}

function prompt(mode, b){
  const themen = list(b.topics, 30).join(", ") || "keine";
  const begriffe = list(b.keywords, 30).join(", ") || "keine";
  const gedanken = list(b.notes, 8, 300).map(n => `- ${n}`).join("\n") || "- keine";
  const kontext = `Thema: ${cut(b.topic, 60) || "noch offen"}
Alle Themen des Nutzers: ${themen}
Feste Suchbegriffe zum Thema: ${begriffe}
Frühere Gedanken zum Thema:
${gedanken}${b.verlauf ? `
Bisheriges Gespräch mit ihm dazu:
${list(b.verlauf, 10, 600).map(x => `- ${x}`).join("\n")}` : ""}`;
  if (mode === "vorschlag") {
    return `Du hilfst Sebastian, Gedanken für sein persönliches News-Dashboard aufzuschreiben. Er tippt gerade.
${kontext}

Bisher getippt: "${cut(b.text, 600)}"

Schlage bis zu 6 kurze Ergänzungen vor (1 bis 5 Wörter), wie eine Suchvorschlag-Liste: konkrete Produkte, Namen, Ereignisse oder Fragen, die zu dem passen, was er gerade denkt. Nichts wiederholen, was schon getippt ist.
Antworte nur mit JSON: {"vorschlaege": ["…", "…"]}`;
  }
  if (mode === "verstehen") {
    return `Sebastian schreibt frei und oft stichwortartig auf, was ihn interessiert. Verstehe, was er eigentlich wissen will, und plane eine News-Recherche dazu.
${kontext}

Sein Gedanke: "${cut(b.text, 2000)}"

Antworte nur mit JSON in genau dieser Form:
{"verstanden": "…", "thema": "…", "schlagworte": ["…"], "suchanfragen": ["…"], "verbindungen": [{"thema": "…", "grund": "…"}], "neue_themen": ["…"]}
- verstanden: ein Satz, als Frage oder Interesse formuliert, was er wissen will (z. B. "Welche AR-Brille mit 6DoF-Tracking taugt aktuell als Beamer-Ersatz für 4K-Inhalte?")
- thema: wohin das gehört: genau einer seiner Themennamen aus der Liste, wenn es passt, sonst ein neuer kurzer Themenname (1 bis 3 Wörter, z. B. "AR-Brillen")
- schlagworte: 3 bis 6 aussagekräftige Begriffe oder Wortgruppen im Zusammenhang (z. B. "AR-Brille mit 6DoF", "Beamer-Ersatz", "4K-Bildqualität"), keine Füllwörter, keine allgemeinen Einzelwörter wie "Technik"
- suchanfragen: 2 bis 3 präzise News-Suchanfragen mit 3 bis 7 Wörtern, die zusammen die Frage abdecken; für internationale Technik-Themen darf eine davon Englisch sein
- verbindungen: bis zu 2 seiner anderen Themen, die wirklich damit zusammenhängen, mit kurzem Grund (höchstens 12 Wörter); leer, wenn keins passt
- neue_themen: höchstens 2 Themenbereiche, die er noch nicht hat
Alles auf Deutsch außer Eigennamen und der optionalen englischen Suchanfrage.`;
  }
  if (mode === "antwort") {
    const arts = (Array.isArray(b.articles) ? b.articles : []).slice(0, 25);
    return `Du bist Sebastians persönlicher Rechercheur. Er will keine Schlagzeilen-Sammlung, sondern eine brauchbare Antwort.
${kontext}

Sein Gedanke: "${cut(b.text, 2000)}"
So hast du ihn verstanden: "${cut(b.verstanden, 300)}"

Gefundene aktuelle Artikel (Nummer, Titel, Quelle, Datum, Anriss):
${artikelListe(arts)}

Beantworte seine Frage so gut es mit diesen Artikeln geht. Stütze dich nur auf die Artikel, erfinde keine Fakten, Produkte oder Zahlen, und nenne zu jeder Aussage die Artikelnummern. Wenn die Artikel die Frage nicht beantworten, sag das ehrlich und was fehlt.
Antworte nur mit JSON in genau dieser Form:
{"kern": "2 bis 4 Sätze direkte Antwort", "punkte": [{"text": "konkrete Erkenntnis, Option oder Entwicklung in 1 bis 2 Sätzen", "quellen": [1, 3]}], "offen": ["was noch unklar ist oder worauf er achten sollte"], "weiter": ["sinnvolle nächste Frage oder Suche"]}
- punkte: 2 bis 5, zusammengehörige Artikel bündeln
- offen: bis zu 3, weiter: bis zu 3
Alles auf Deutsch.`;
  }
  // lage
  const arts = (Array.isArray(b.articles) ? b.articles : []).slice(0, 25);
  return `Du bist Sebastians News-Analyst. Er will keine Schlagzeilen-Sammlung, sondern eine gute Einordnung.
${kontext}

Aktuelle Artikel zum Thema (Nummer, Titel, Quelle, Datum, Anriss):
${artikelListe(arts)}

Schreibe eine kurze, ehrliche Analyse der Lage. Stütze dich nur auf diese Artikel, erfinde nichts dazu, und nenne zu jeder Aussage die Artikelnummern.
Antworte nur mit JSON in genau dieser Form:
{"kern": "2 bis 3 Sätze: was gerade wirklich passiert", "punkte": [{"text": "eine Entwicklung oder Einordnung in 1 bis 2 Sätzen", "quellen": [1, 4]}], "fuer_dich": "1 bis 2 Sätze, was davon zu seinen Gedanken passt (leer, wenn nichts)", "offen": ["offene Frage oder worauf man achten sollte"]}
- punkte: 3 bis 5, zusammengehörige Artikel bündeln, Dubletten zusammenfassen
- offen: bis zu 3
Alles auf Deutsch.`;
}

function parse(text){
  const m = String(text || "").match(/\{[\s\S]*\}/);
  if (!m) throw new Error("KI-Antwort ohne JSON");
  return JSON.parse(m[0]);
}

async function frageWorkersAI(env, p, mode){
  const r = await env.AI.run(WORKERS_MODEL[mode], {
    messages: [
      { role: "system", content: "Du antwortest ausschließlich mit gültigem JSON, ohne Erklärtext." },
      { role: "user", content: p },
    ],
    max_tokens: MAX_TOKENS[mode], temperature: mode === "vorschlag" ? 0.5 : 0.2,
  });
  return { data: typeof r?.response === "object" ? r.response : parse(r?.response), by: "Workers AI" };
}

async function frageGemini(env, p, mode){
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: p }] }],
      generationConfig: { responseMimeType: "application/json", temperature: 0.3, maxOutputTokens: MAX_TOKENS[mode] + 300, thinkingConfig: { thinkingBudget: 0 } },
    }),
  });
  if (!r.ok) throw new Error(`Gemini ${r.status}`);
  const d = await r.json();
  return { data: parse(d?.candidates?.[0]?.content?.parts?.map(x => x.text).join("")), by: "Gemini" };
}

function aufraeumen(mode, d){
  const punkte = max => (Array.isArray(d.punkte) ? d.punkte : []).slice(0, 6)
    .map(p => ({ text: cut(p?.text, 400), quellen: nums(p?.quellen, max) })).filter(p => p.text);
  if (mode === "vorschlag") return { vorschlaege: list(d.vorschlaege, 6, 60) };
  if (mode === "verstehen") return {
    verstanden: cut(d.verstanden, 300),
    thema: cut(d.thema, 40),
    schlagworte: list(d.schlagworte, 6, 50),
    suchanfragen: list(d.suchanfragen, 3, 90),
    verbindungen: (Array.isArray(d.verbindungen) ? d.verbindungen : []).slice(0, 2)
      .map(v => ({ thema: cut(v?.thema, 60), grund: cut(v?.grund, 120) })).filter(v => v.thema),
    neue_themen: list(d.neue_themen, 2, 40),
  };
  if (mode === "antwort") return { kern: cut(d.kern, 900), punkte: punkte(25), offen: list(d.offen, 3, 200), weiter: list(d.weiter, 3, 120) };
  return { kern: cut(d.kern, 600), punkte: punkte(25), fuer_dich: cut(d.fuer_dich, 300), offen: list(d.offen, 3, 200) };
}

// ---------- Live-Suche (ohne KI) ----------
const decode = s => String(s || "")
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n)).replace(/&amp;/g, "&")
  .replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
const tag = (xml, name) => { const m = xml.match(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`, "i")); return m ? decode(m[1]) : ""; };

function parseRss(xml, via){
  const out = [];
  for (const m of xml.slice(0, 200_000).matchAll(/<item\b[\s\S]*?<\/item>/gi)) {
    const it = m[0];
    let url = tag(it, "link");
    if (url.includes("bing.com/news/apiclick")) { try { url = new URL(url).searchParams.get("url") || url; } catch {} }
    let title = tag(it, "title"), source = tag(it, "News:Source") || tag(it, "source");
    if (url.includes("news.google") && source && title.endsWith(" - " + source)) title = title.slice(0, -(source.length + 3));
    if (!title || !/^https?:\/\//.test(url)) continue;
    const date = new Date(tag(it, "pubDate"));
    let host = ""; try { host = new URL(url).hostname.replace(/^www\./, ""); } catch {}
    out.push({ title: cut(title, 220), url, source: cut(source || host, 50), date: isNaN(date) ? "" : date.toISOString().slice(0, 10),
      summary: url.includes("news.google") ? "" : cut(tag(it, "description"), 300), via });
  }
  return out;
}

async function holeFeed(url){
  const r = await fetch(url, { headers: { "user-agent": UA, accept: "application/rss+xml, application/xml, text/xml" }, cf: { cacheTtl: 600 } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.text();
}

async function suche(q){
  const de = /[äöüß]|\b(der|die|das|und|mit|für|aktuell|beste)\b/i.test(q);
  const [lang, region] = de ? ["de", "DE"] : ["en", "US"];
  try {
    const items = parseRss(await holeFeed(`https://www.bing.com/news/search?q=${encodeURIComponent(q)}&format=rss&setmkt=${lang}-${region}&setlang=${lang}`), q);
    if (items.length) return items.slice(0, 12);
  } catch {}
  return parseRss(await holeFeed(`https://news.google.com/rss/search?q=${encodeURIComponent(q + " when:30d")}&hl=${lang}&gl=${region}&ceid=${region}:${lang}`), q).slice(0, 12);
}

async function sucheAlle(queries){
  const res = await Promise.allSettled(queries.map(suche));
  const seen = new Set(), out = [];
  // abwechselnd aus jeder Suche, damit jede Frage-Seite vertreten ist
  const lists = res.map(r => r.status === "fulfilled" ? r.value : []);
  for (let i = 0; i < 12; i++) for (const l of lists) {
    const a = l[i]; if (!a) continue;
    const key = a.title.toLowerCase().replace(/[^a-z0-9äöüß]+/g, " ").slice(0, 70);
    if (seen.has(key) || seen.has(a.url)) continue;
    seen.add(key); seen.add(a.url); out.push(a);
  }
  return { artikel: out.slice(0, 30), fehler: res.filter(r => r.status === "rejected").length };
}

function kiListe(env){
  const fragen = [];
  if (env.AI) fragen.push(frageWorkersAI);
  if (env.GEMINI_API_KEY) fragen.push(frageGemini);
  return fragen;
}

export async function onRequestGet({ request, env }){
  const ki = env.AI ? "Workers AI" : env.GEMINI_API_KEY ? "Gemini" : null;
  if (!ki || !new URL(request.url).searchParams.has("test")) return json({ ki });
  const t0 = Date.now();
  try {
    await kiListe(env)[0](env, 'Antworte mit {"ok": true}', "vorschlag");
    return json({ ki, ok: true, ms: Date.now() - t0 });
  } catch (e) {
    return json({ ki, ok: false, error: String(e?.message || e).slice(0, 200) });
  }
}

export async function onRequestPost({ request, env }){
  // Nur Aufrufe vom eigenen Dashboard (schützt das KI-Kontingent vor fremden Seiten)
  const origin = request.headers.get("origin");
  if (origin && new URL(origin).host !== new URL(request.url).host) return json({ error: "fremde Herkunft" }, 403);

  let b;
  try { b = await request.json(); } catch { return json({ error: "kein JSON" }, 400); }
  const mode = ["vorschlag", "verstehen", "suchen", "antwort", "lage"].includes(b?.mode) ? b.mode : "verstehen";

  if (mode === "suchen") {
    const queries = list(b.queries, 3, 90).filter(q => q.length >= 3);
    if (!queries.length) return json({ error: "keine Suchanfragen" }, 400);
    return json(await sucheAlle(queries));
  }
  const needsArticles = mode === "lage";
  if (needsArticles ? !(Array.isArray(b?.articles) && b.articles.length) : cut(b?.text, 10).length < 3) return json({ error: "zu wenig Text" }, 400);

  const fragen = kiListe(env);
  if (!fragen.length) return json({ error: "keine KI eingerichtet" }, 503);
  const p = prompt(mode, b);
  let fehler = "";
  for (const frage of fragen) {
    try {
      const { data, by } = await frage(env, p, mode);
      return json({ ...aufraeumen(mode, data || {}), by });
    } catch (e) {
      fehler = String(e?.message || e).slice(0, 200);
    }
  }
  return json({ error: fehler || "KI nicht erreichbar" }, 502);
}
