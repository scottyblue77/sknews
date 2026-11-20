// KI-Helfer für das Gedanken-Feld im Dashboard (Cloudflare Pages Function, POST /api/ideen).
//
// mode "vorschlag": beim Tippen bis zu 6 kurze Vorschläge (Schlagworte, Fortsetzungen)
// mode "analyse":   beim Merken Schlagworte, Suchbegriffe für die Recherche,
//                   Verbindungen zu anderen Themen und neue Themen-Ideen
// mode "lage":      Analyse der aktuellen Artikel eines Themas (statt nur Schlagzeilen),
//                   mit Blick auf Sebastians Gedanken dazu
//
// KI: Workers AI über die Bindung "AI" (Pages → Settings → Bindings → Workers AI, Name AI).
// Ohne Bindung, aber mit Secret GEMINI_API_KEY wird Gemini benutzt. Ohne beides
// antwortet die Funktion mit 503 und das Dashboard arbeitet nur mit eigenen Begriffen.

// Vorschläge beim Tippen kommen oft und müssen schnell sein: kleines Modell.
// Auswertung und Lage-Analyse brauchen gutes Deutsch und Sorgfalt: großes Modell.
const WORKERS_MODEL = { vorschlag: "@cf/meta/llama-3.1-8b-instruct-fast", analyse: "@cf/meta/llama-3.3-70b-instruct-fp8-fast", lage: "@cf/meta/llama-3.3-70b-instruct-fp8-fast" };
const GEMINI_MODEL = "gemini-2.5-flash";

const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
});

const cut = (s, n) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);
const list = (a, n, len = 60) => (Array.isArray(a) ? a : []).map(x => cut(x, len)).filter(Boolean).slice(0, n);

function prompt(mode, b){
  const themen = list(b.topics, 30).join(", ") || "keine";
  const begriffe = list(b.keywords, 30).join(", ") || "keine";
  const gedanken = list(b.notes, 8, 300).map(n => `- ${n}`).join("\n") || "- keine";
  const kontext = `Thema: ${cut(b.topic, 60) || "noch offen"}
Alle Themen des Nutzers: ${themen}
Bekannte Suchbegriffe zum Thema: ${begriffe}
Frühere Gedanken zum Thema:
${gedanken}`;
  if (mode === "vorschlag") {
    return `Du hilfst Sebastian, Gedanken für sein persönliches News-Dashboard aufzuschreiben. Er tippt gerade.
${kontext}

Bisher getippt: "${cut(b.text, 600)}"

Schlage bis zu 6 kurze Ergänzungen vor (1 bis 4 Wörter), wie eine Suchvorschlag-Liste: Schlagworte, Namen, Produkte, Ereignisse, die zu dem passen, was er gerade denkt, und die man als News suchen kann. Gern auch Verbindungen zu seinen anderen Themen. Nichts wiederholen, was schon getippt ist.
Antworte nur mit JSON: {"vorschlaege": ["…", "…"]}`;
  }
  if (mode === "lage") {
    const arts = (Array.isArray(b.articles) ? b.articles : []).slice(0, 25)
      .map((a, i) => `[${i + 1}] ${cut(a?.title, 200)} (${cut(a?.source, 40)}, ${cut(a?.date, 10)})${a?.summary ? ": " + cut(a.summary, 300) : ""}`).join("\n");
    return `Du bist Sebastians News-Analyst. Er will keine Schlagzeilen-Sammlung, sondern eine gute Einordnung.
${kontext}

Aktuelle Artikel zum Thema (Nummer, Titel, Quelle, Datum, Anriss):
${arts}

Schreibe eine kurze, ehrliche Analyse der Lage. Stütze dich nur auf diese Artikel, erfinde nichts dazu, und nenne zu jeder Aussage die Artikelnummern.
Antworte nur mit JSON in genau dieser Form:
{"kern": "2 bis 3 Sätze: was gerade wirklich passiert", "punkte": [{"text": "eine Entwicklung oder Einordnung in 1 bis 2 Sätzen", "quellen": [1, 4]}], "fuer_dich": "1 bis 2 Sätze, was davon zu seinen Gedanken passt (leer, wenn nichts)", "offen": ["offene Frage oder worauf man achten sollte"]}
- punkte: 3 bis 5, zusammengehörige Artikel bündeln, Dubletten zusammenfassen
- offen: bis zu 3
Alles auf Deutsch.`;
  }
  return `Sebastian hat einen Gedanken für sein persönliches News-Dashboard notiert. Werte ihn aus, damit das Dashboard lernt, was ihn interessiert, und passende News sucht.
${kontext}

Neuer Gedanke: "${cut(b.text, 2000)}"

Antworte nur mit JSON in genau dieser Form:
{"schlagworte": ["…"], "suchbegriffe": ["…"], "verbindungen": [{"thema": "…", "grund": "…"}], "neue_themen": ["…"]}
- schlagworte: 3 bis 8 Kernbegriffe aus dem Gedanken (Namen, Produkte, Ereignisse, Fachbegriffe), je 1 bis 3 Wörter
- suchbegriffe: 2 bis 4 konkrete News-Suchanfragen (2 bis 5 Wörter), die zum Gedanken passen und nicht schon bei den bekannten Suchbegriffen stehen
- verbindungen: bis zu 3 seiner anderen Themen, die mit dem Gedanken zusammenhängen, mit einem kurzen Grund (höchstens 12 Wörter)
- neue_themen: bis zu 2 Themenbereiche, die er noch nicht hat, aber spannend finden könnte
Alles auf Deutsch, Eigennamen im Original.`;
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
    max_tokens: mode === "lage" ? 1200 : 500, temperature: mode === "lage" ? 0.2 : 0.4,
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
      generationConfig: { responseMimeType: "application/json", temperature: 0.4, maxOutputTokens: mode === "lage" ? 1500 : 600, thinkingConfig: { thinkingBudget: 0 } },
    }),
  });
  if (!r.ok) throw new Error(`Gemini ${r.status}`);
  const d = await r.json();
  return { data: parse(d?.candidates?.[0]?.content?.parts?.map(x => x.text).join("")), by: "Gemini" };
}

function aufraeumen(mode, d){
  if (mode === "vorschlag") return { vorschlaege: list(d.vorschlaege, 6, 50) };
  if (mode === "lage") return {
    kern: cut(d.kern, 600),
    punkte: (Array.isArray(d.punkte) ? d.punkte : []).slice(0, 6).map(p => ({
      text: cut(p?.text, 400),
      quellen: (Array.isArray(p?.quellen) ? p.quellen : []).map(Number).filter(n => Number.isInteger(n) && n > 0 && n <= 25).slice(0, 6),
    })).filter(p => p.text),
    fuer_dich: cut(d.fuer_dich, 300),
    offen: list(d.offen, 3, 200),
  };
  return {
    schlagworte: list(d.schlagworte, 8, 40),
    suchbegriffe: list(d.suchbegriffe, 4, 60),
    verbindungen: (Array.isArray(d.verbindungen) ? d.verbindungen : []).slice(0, 3)
      .map(v => ({ thema: cut(v?.thema, 60), grund: cut(v?.grund, 120) })).filter(v => v.thema),
    neue_themen: list(d.neue_themen, 2, 40),
  };
}

export async function onRequestPost({ request, env }){
  // Nur Aufrufe vom eigenen Dashboard (schützt das KI-Kontingent vor fremden Seiten)
  const origin = request.headers.get("origin");
  if (origin && new URL(origin).host !== new URL(request.url).host) return json({ error: "fremde Herkunft" }, 403);

  let b;
  try { b = await request.json(); } catch { return json({ error: "kein JSON" }, 400); }
  const mode = ["vorschlag", "lage"].includes(b?.mode) ? b.mode : "analyse";
  if (mode === "lage" ? !(Array.isArray(b?.articles) && b.articles.length) : cut(b?.text, 10).length < 3) return json({ error: "zu wenig Text" }, 400);

  const fragen = [];
  if (env.AI) fragen.push(frageWorkersAI);
  if (env.GEMINI_API_KEY) fragen.push(frageGemini);
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

export const onRequest = () => json({ error: "nur POST" }, 405);
