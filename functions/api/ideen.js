// KI-Helfer für das Gedanken-Feld im Dashboard (Cloudflare Pages Function, /api/ideen).
//
// GET                 Status: welche KI eingerichtet ist ({ki: "Workers AI" | "Gemini" | null}),
//                     mit ?test=1 zusätzlich ein kleiner Probeaufruf ({ok, ms}),
//                     mit ?yt=begriff eine Probe der YouTube-Suche
// POST mode:
//   "vorschlag"  beim Tippen bis zu 6 kurze Vorschläge
//   "verstehen"  beim Absenden: was will Sebastian wissen, sinnvolle Schlagworte (Wortgruppen),
//                2 bis 3 vollständige News-Suchanfragen, Verbindungen, Themen-Ideen
//   "suchen"     holt für die Suchanfragen sofort aktuelle Artikel (Bing News, sonst Google News),
//                ohne KI
//   "antwort"    beantwortet den Gedanken aus den gefundenen Artikeln, mit Quellennummern
//   "lage"       Einordnung der aktuellen Artikel eines Themas
//   "videos"     sucht passende YouTube-Videos, bewertet sie (Relevanz, Aufrufe, Alter, Länge,
//                bekannte und gelikte Kanäle) und lässt die KI die besten 3 auswählen
//   "recherche"  Recherche zu einer Video-Gruppe eines Themas: liest die Videobeschreibungen,
//                plant Suchanfragen, sucht News, liest die wichtigsten Artikel im Volltext und
//                schreibt eine Analyse mit Quellen, getrennt nach dem, was im Dashboard noch fehlt
//
// KI: Workers AI über die Bindung "AI" (Pages → Settings → Bindings → Workers AI, Name AI).
// Ohne Bindung, aber mit Secret GEMINI_API_KEY wird Gemini benutzt. Ohne beides antworten die
// KI-Modi mit 503 und das Dashboard arbeitet nur mit eigenen Begriffen.

// Vorschläge beim Tippen kommen oft und müssen schnell sein: kleines Modell. Der Rest braucht
// gutes Deutsch und Sorgfalt: großes Modell.
const BIG = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
const WORKERS_MODEL = { vorschlag: "@cf/meta/llama-3.1-8b-instruct-fast", verstehen: BIG, antwort: BIG, lage: BIG, videos: BIG, plan: BIG, recherche: BIG };
const GEMINI_MODEL = "gemini-2.5-flash";
const MAX_TOKENS = { vorschlag: 300, verstehen: 700, antwort: 1400, lage: 1300, videos: 500, plan: 400, recherche: 2000 };
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

// ---------- YouTube ----------
// Ohne API-Schlüssel: die Ergebnisseite enthält die Treffer als JSON (ytInitialData).
const ytZahl = s => { const m = String(s || "").replace(/[.,\s ]/g, "").match(/\d+/); return m ? +m[0] : 0; };
function ytViews(s){
  s = String(s || "").toLowerCase().replace(/\u00a0/g, " ");
  const m = s.match(/([\d.,]+)\s*(mio|mrd|tsd|m|k|b)?\b/);
  if (!m) return 0;
  if (m[2]) return Math.round(parseFloat(m[1].replace(",", ".")) * { mio: 1e6, m: 1e6, mrd: 1e9, b: 1e9, tsd: 1e3, k: 1e3 }[m[2]]);
  return +m[1].replace(/[.,]/g, "") || 0;
}
function ytTage(s){
  s = String(s || "").toLowerCase();
  const n = ytZahl(s) || 1;
  if (/minute|stunde|hour|sekunde|second|live|gestreamt\s*$/.test(s) && !/tag|day|woche|week|monat|month|jahr|year/.test(s)) return 0;
  if (/tag|day/.test(s)) return n;
  if (/woche|week/.test(s)) return n * 7;
  if (/monat|month/.test(s)) return n * 30;
  if (/jahr|year/.test(s)) return n * 365;
  return 30;
}
const ytSek = s => String(s || "").split(":").reduce((a, x) => a * 60 + (+x || 0), 0);

function ytFinde(o, out, tiefe = 0){
  if (!o || typeof o !== "object" || tiefe > 40 || out.length >= 25) return;
  if (o.videoRenderer?.videoId) { out.push(o.videoRenderer); return; }
  for (const k in o) ytFinde(o[k], out, tiefe + 1);
}

async function ytSuche(q){
  const url = `https://www.youtube.com/results?search_query=${encodeURIComponent(q)}&sp=EgIIBQ%253D%253D&hl=de&gl=DE`;
  const r = await fetch(url, { headers: { "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36",
    "accept-language": "de-DE,de;q=0.9,en;q=0.6", cookie: "CONSENT=YES+cb; SOCS=CAI" }, cf: { cacheTtl: 1800 } });
  if (!r.ok) throw new Error(`YouTube ${r.status}`);
  const html = await r.text();
  const i = html.indexOf("ytInitialData");
  if (i < 0) return [];
  const start = html.indexOf("{", i), end = html.indexOf(";</script>", start);
  let data; try { data = JSON.parse(html.slice(start, end)); } catch { return []; }
  const raw = []; ytFinde(data, raw);
  return raw.map(v => ({
    id: v.videoId,
    title: cut(v.title?.runs?.map(x => x.text).join("") || v.title?.simpleText, 160),
    channel: cut(v.ownerText?.runs?.[0]?.text || v.longBylineText?.runs?.[0]?.text, 60),
    handle: cut(v.ownerText?.runs?.[0]?.navigationEndpoint?.browseEndpoint?.canonicalBaseUrl, 80).replace(/^\//, ""),
    dauer: cut(v.lengthText?.simpleText, 10),
    alter: cut(v.publishedTimeText?.simpleText, 30),
    views: ytViews(v.viewCountText?.simpleText || v.viewCountText?.runs?.map(x => x.text).join("")),
    verified: (v.ownerBadges || []).some(b => /VERIFIED|ARTIST/.test(b?.metadataBadgeRenderer?.style || "")),
    live: !v.lengthText,
  })).filter(v => v.id && v.title);
}

// Vorbewertung ohne KI. Kanäle aus dem Thema und gelikte Kanäle zählen mehr.
function ytBewerte(v, worte, kanaele){
  const text = (v.title + " " + v.channel).toLowerCase();
  const rel = worte.length ? worte.filter(w => text.includes(w)).length / worte.length : 0.5;
  const sek = ytSek(v.dauer), tage = ytTage(v.alter);
  const kanal = [v.channel, v.handle].map(x => String(x || "").toLowerCase());
  let s = 1.4 * rel + 0.5 * Math.min(1, Math.log10(v.views + 1) / 6) + 0.5 * Math.exp(-tage / 90);
  if (v.live) s -= 0.4;
  else if (sek < 90) s -= 0.6;           // Shorts
  else if (sek >= 240 && sek <= 45 * 60) s += 0.2;
  else if (sek > 2 * 3600) s -= 0.3;
  if (v.verified) s += 0.1;
  if (kanaele.some(k => k && kanal.some(c => c && (c.includes(k) || k.includes(c))))) s += 0.5;
  if (/(!!!|\?\?\?|schock|unglaublich|you won.t believe|gone wrong|#shorts)/i.test(v.title)) s -= 0.4;
  return Math.round(s * 100) / 100;
}

async function sucheVideos(b, env){
  const queries = list(b.queries, 3, 90).filter(q => q.length >= 3);
  const kanaele = list(b.channels, 20, 80).map(k => k.toLowerCase().replace(/^@/, "").replace(/^.*youtube\.com\//, "").replace(/^@/, ""));
  const worte = [...new Set(queries.join(" ").toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(w => w.length >= 4))].slice(0, 10);
  const res = await Promise.allSettled(queries.map(ytSuche));
  const seen = new Set(), alle = [];
  for (const r of res) if (r.status === "fulfilled") for (const v of r.value) if (!seen.has(v.id)) { seen.add(v.id); alle.push(v); }
  const suche = `https://www.youtube.com/results?search_query=${encodeURIComponent(queries[0] || "")}`;
  if (!alle.length) return { videos: [], suche, fehler: res.filter(r => r.status === "rejected").length };
  for (const v of alle) v.score = ytBewerte(v, worte, kanaele);
  const kandidaten = alle.sort((a, c) => c.score - a.score).slice(0, 10);
  let top = kandidaten.slice(0, 3).map(v => ({ ...v, grund: "" })), by = "";
  const fragen = kiListe(env);
  if (fragen.length) {
    const p = `Sebastian sucht Videos zu: ${cut(b.text || queries.join(" / "), 300)}
Thema: ${cut(b.topic, 60) || "offen"}

Kandidaten (Titel | Kanal | Länge | Alter | Aufrufe | Vorbewertung):
${kandidaten.map((v, i) => `${i + 1}. ${v.title} | ${v.channel} | ${v.dauer || "live"} | ${v.alter} | ${v.views} | ${v.score}`).join("\n")}

Wähle höchstens 3 sehenswerte Videos aus: inhaltlich passend, informativ, seriöse Kanäle. Kein Clickbait, keine Shorts, nichts Themenfremdes. Lieber weniger als schlechte.
Antworte nur mit JSON:
{"top": [{"nr": 2, "grund": "in höchstens 10 Wörtern, warum sehenswert"}]}`;
    for (const frage of fragen) {
      try {
        const { data, by: wer } = await frage(env, p, "videos");
        const gew = (Array.isArray(data?.top) ? data.top : []).map(x => ({ v: kandidaten[Number(x?.nr) - 1], grund: cut(x?.grund, 90) }))
          .filter(x => x.v).filter((x, i, a) => a.findIndex(y => y.v.id === x.v.id) === i).slice(0, 3);
        if (gew.length) { top = gew.map(x => ({ ...x.v, grund: x.grund })); by = wer; }
        break;
      } catch {}
    }
  }
  return { videos: top.map(({ id, title, channel, handle, dauer, alter, views, score, grund }) => ({ id, title, channel, handle, dauer, alter, views, score, grund })), suche, by };
}

// ---------- Recherche zu einer Video-Gruppe ----------
const BROWSER = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
const VID = /^[\w-]{11}$/;

async function holeText(url, ms = 8000, max = 600_000){
  const r = await fetch(url, { headers: { "user-agent": BROWSER, "accept-language": "de-DE,de;q=0.9,en;q=0.6", cookie: "CONSENT=YES+cb; SOCS=CAI" },
    signal: AbortSignal.timeout(ms), cf: { cacheTtl: 1800 } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  if (!/html|xml|text/.test(r.headers.get("content-type") || "")) throw new Error("kein Text");
  return (await r.text()).slice(0, max);
}

// Beschreibung eines Videos von der Videoseite (enthält oft Kapitel, Quellen, Zahlen)
async function ytBeschreibung(id){
  const html = await holeText(`https://www.youtube.com/watch?v=${id}&hl=de`, 7000, 1_500_000);
  const m = html.match(/"shortDescription":"((?:[^"\\]|\\.)*)"/);
  if (!m) return "";
  try { return cut(JSON.parse(`"${m[1]}"`).replace(/https?:\/\/\S+/g, ""), 900); } catch { return ""; }
}

// Fließtext eines Artikels: Absätze aus dem HTML, ohne Menüs und Skripte
async function artikelText(url){
  const html = (await holeText(url)).replace(/<(script|style|noscript|nav|header|footer|aside|form)\b[\s\S]*?<\/\1>/gi, " ");
  const teile = [];
  for (const m of html.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)) {
    const t = decode(m[1]);
    if (t.length >= 60 && !/cookie|newsletter|abonnieren|subscribe|javascript/i.test(t)) teile.push(t);
    if (teile.join(" ").length > 2200) break;
  }
  return cut(teile.join(" "), 2200);
}

async function frageKI(env, p, mode){
  let fehler = "";
  for (const frage of kiListe(env)) {
    try { return await frage(env, p, mode); } catch (e) { fehler = String(e?.message || e).slice(0, 200); }
  }
  throw new Error(fehler || "KI nicht erreichbar");
}

async function recherche(b, env){
  const thema = cut(b.topic, 60);
  const videos = (Array.isArray(b.videos) ? b.videos : []).filter(v => VID.test(String(v?.id || ""))).slice(0, 6)
    .map(v => ({ id: v.id, title: cut(v.title, 160), channel: cut(v.channel, 60), alter: cut(v.alter, 30) }));
  const bekannt = list(b.known, 30, 160);
  const frage = cut(b.frage, 1200);

  // 1. Was steht in den Videos? Beschreibungen lesen
  const beschr = await Promise.allSettled(videos.map(v => ytBeschreibung(v.id)));
  videos.forEach((v, i) => { v.beschreibung = beschr[i].status === "fulfilled" ? beschr[i].value : ""; });
  const videoListe = videos.map((v, i) => `V${i + 1}. „${v.title}“ (${v.channel}${v.alter ? ", " + v.alter : ""})${v.beschreibung ? "\n   Beschreibung: " + v.beschreibung : ""}`).join("\n");

  // 2. Recherche planen
  let plan = {};
  try {
    ({ data: plan } = await frageKI(env, `Du planst eine gründliche News-Recherche für Sebastian. Thema: ${thema || "offen"}.
${frage ? `Seine Frage bzw. was er wissen will: "${frage}"\n` : ""}${videos.length ? `Diese aktuellen YouTube-Videos zeigen, worüber gerade gesprochen wird:\n${videoListe}\n` : ""}${bekannt.length ? `Schlagzeilen aus seinem Dashboard:\n${bekannt.slice(0, 12).map(x => "- " + x).join("\n")}\n` : ""}
Was ist der gemeinsame Kern, und welche konkreten Fakten muss man prüfen oder ergänzen (Zahlen, Termine, offizielle Aussagen, Kritik, Hintergründe)?
Antworte nur mit JSON: {"kern": "worum es geht bzw. was er wissen will, 1 Satz", "fragen": ["bis zu 4 konkrete Prüffragen"], "suchanfragen": ["3 präzise News-Suchanfragen mit 3 bis 7 Wörtern, eine davon auf Englisch"]}`, "plan"));
  } catch {}
  let queries = list(plan?.suchanfragen, 3, 90).filter(q => q.length >= 3);
  if (!queries.length && frage) queries = [cut(`${thema} ${frage}`, 90)];
  if (!queries.length) queries = [...new Set(videos.slice(0, 3).map(v => cut(v.title.replace(/[^\p{L}\p{N} .\-]+/gu, " "), 70)))].filter(q => q.length >= 3);
  if (!queries.length && thema) queries = [thema];

  // 3. News suchen, 4. die wichtigsten Artikel ganz lesen
  const { artikel } = queries.length ? await sucheAlle(queries) : { artikel: [] };
  const arts = artikel.slice(0, 18);
  const lesbar = arts.map((a, i) => ({ a, i })).filter(x => !x.a.url.includes("news.google")).slice(0, 6);
  const texte = await Promise.allSettled(lesbar.map(x => artikelText(x.a.url)));
  lesbar.forEach((x, k) => { if (texte[k].status === "fulfilled" && texte[k].value.length > 200) x.a.text = texte[k].value; });

  // Quellen: erst die Videos, dann die Artikel, durchgehend nummeriert
  const quellen = [
    ...videos.map(v => ({ title: v.title, url: `https://www.youtube.com/watch?v=${v.id}`, source: v.channel, date: "", video: true })),
    ...arts.map(a => ({ title: a.title, url: a.url, source: a.source, date: a.date })),
  ];
  const nv = videos.length;
  const quellenText = [
    ...videos.map((v, i) => `[${i + 1}] VIDEO „${v.title}“ (${v.channel})${v.beschreibung ? ": " + v.beschreibung : ""}`),
    ...arts.map((a, i) => `[${nv + i + 1}] ${a.title} (${a.source}, ${a.date})${a.text ? "\n   Volltext: " + a.text : a.summary ? ": " + a.summary : ""}`),
  ].join("\n");

  // 5. Auswertung
  const p = `Du bist Sebastians persönlicher Rechercheur. Er will keine Schlagzeilen, sondern eine richtig gute Recherche: Zusammenfassung, belegte Fakten und vor allem das, was noch nicht überall zu lesen ist.
Thema: ${thema || "offen"}
${frage ? `Seine Frage, die du beantworten sollst: "${frage}"\n` : ""}Worum es geht: ${cut(plan?.kern, 300) || "siehe Videos"}
Prüffragen: ${list(plan?.fragen, 4, 200).join(" | ") || "keine"}

Schlagzeilen, die Sebastian in seinem Dashboard schon hat (das ist NICHT neu für ihn):
${bekannt.map(x => "- " + x).join("\n") || "- keine"}

Quellen (Videos und Artikel, nummeriert):
${quellenText}

Regeln: Stütze dich nur auf diese Quellen, erfinde nichts, nenne zu jeder Aussage die Quellennummern. Aussagen, die nur in einem Video stehen und nirgends belegt sind, kennzeichne als unbestätigt. Konkrete Zahlen, Daten, Namen und Versionen sind wichtiger als allgemeine Sätze.
Antworte nur mit JSON in genau dieser Form:
{"kern": "3 bis 5 Sätze: direkte Antwort bzw. was wirklich los ist", "neu": [{"text": "Fakt oder Detail, das nicht in seinen Schlagzeilen steht, 1 bis 2 Sätze", "quellen": [2, 7]}], "punkte": [{"text": "belegte Entwicklung oder Einordnung, 1 bis 2 Sätze", "quellen": [1, 5]}], "einordnung": "2 bis 3 Sätze: was ist belegt, was ist Hype oder Meinung, wo widersprechen sich Quellen", "offen": ["offene Frage"], "weiter": ["sinnvolle nächste Suche"]}
- neu: 2 bis 5, punkte: 3 bis 6, offen: bis zu 3, weiter: bis zu 3
Alles auf Deutsch.`;
  const { data, by } = await frageKI(env, p, "recherche");
  const max = quellen.length;
  const punkte = a => (Array.isArray(a) ? a : []).slice(0, 6).map(x => ({ text: cut(x?.text, 450), quellen: nums(x?.quellen, max) })).filter(x => x.text);
  return {
    kern: cut(data?.kern, 1200), neu: punkte(data?.neu), punkte: punkte(data?.punkte), einordnung: cut(data?.einordnung, 700),
    offen: list(data?.offen, 3, 200), weiter: list(data?.weiter, 3, 120), suchanfragen: queries, quellen, by,
    gelesen: { videos: videos.filter(v => v.beschreibung).length, artikel: arts.length, volltext: arts.filter(a => a.text).length },
  };
}

function kiListe(env){
  const fragen = [];
  if (env.AI) fragen.push(frageWorkersAI);
  if (env.GEMINI_API_KEY) fragen.push(frageGemini);
  return fragen;
}

export async function onRequestGet({ request, env }){
  const ki = env.AI ? "Workers AI" : env.GEMINI_API_KEY ? "Gemini" : null;
  const yt = new URL(request.url).searchParams.get("yt");
  if (yt) {
    // Prüfung der YouTube-Suche ohne KI: /api/ideen?yt=suchbegriff
    try { const v = await ytSuche(cut(yt, 90)); return json({ ok: v.length > 0, anzahl: v.length, beispiel: v.slice(0, 3) }); }
    catch (e) { return json({ ok: false, error: String(e?.message || e).slice(0, 200) }); }
  }
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
  const mode = ["vorschlag", "verstehen", "suchen", "antwort", "lage", "videos", "recherche"].includes(b?.mode) ? b.mode : "verstehen";

  if (mode === "suchen") {
    const queries = list(b.queries, 3, 90).filter(q => q.length >= 3);
    if (!queries.length) return json({ error: "keine Suchanfragen" }, 400);
    return json(await sucheAlle(queries));
  }
  if (mode === "videos") {
    if (!list(b.queries, 3, 90).some(q => q.length >= 3)) return json({ error: "keine Suchanfragen" }, 400);
    try { return json(await sucheVideos(b, env)); }
    catch (e) { return json({ videos: [], error: String(e?.message || e).slice(0, 200) }); }
  }
  if (mode === "recherche") {
    if (!kiListe(env).length) return json({ error: "keine KI eingerichtet" }, 503);
    if (!(Array.isArray(b.videos) && b.videos.length) && cut(b.frage, 10).length < 3) return json({ error: "keine Frage" }, 400);
    try { return json(await recherche(b, env)); }
    catch (e) { return json({ error: String(e?.message || e).slice(0, 200) }, 502); }
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
