// Google-Login mit Freigabe vor dem Dashboard (Cloudflare Pages Function).
//
// Läuft vor jeder Anfrage an news.skzone.de bzw. sknews-6co.pages.dev.
// Ablauf:
//  - Admins (ADMIN_EMAILS) kommen nach dem Google-Login immer rein.
//  - Wer sonst sich anmeldet, landet als "Anfrage" in der Liste. Der Admin bekommt
//    eine Telegram-Nachricht und gibt unter /auth/admin frei oder lehnt ab.
//  - Jede Anmeldung eines freigegebenen Nutzers wird ebenfalls per Telegram gemeldet.
//
// Einstellungen in Cloudflare (Pages → sknews → Einstellungen):
//  Variablen und Geheimnisse (Production, Typ "Secret"):
//   GOOGLE_CLIENT_ID      OAuth-Client-ID aus der Google Cloud Console
//   GOOGLE_CLIENT_SECRET  dazugehöriges Client-Secret
//   SESSION_SECRET        lange Zufallszeichenkette (signiert das Login-Cookie)
//   ADMIN_EMAILS          Google-Adresse(n) der Admins, durch Komma getrennt
//   TELEGRAM_BOT_TOKEN    (optional) Bot-Token für Benachrichtigungen
//   TELEGRAM_CHAT_ID      (optional) Chat-ID, an die gemeldet wird
//  Bindungen:
//   KV-Namespace mit Variablenname USERS (speichert Anfragen und Freigaben)
//
// Solange GOOGLE_CLIENT_ID nicht gesetzt ist, bleibt die Seite wie bisher offen,
// damit ein Deploy vor dem Einrichten nichts kaputt macht.

const COOKIE = "sknews_session";
const STATE_COOKIE = "sknews_oauth";
const SESSION_DAYS = 30;

const enc = new TextEncoder();
const b64url = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes)))
  .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const b64urlDecode = s => {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  return atob(s + "=".repeat((4 - s.length % 4) % 4));
};
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const now = () => Math.floor(Date.now() / 1000);
const fmt = t => t ? new Date(t * 1000).toLocaleString("de-DE", { timeZone: "Europe/Berlin" }) : "–";

async function hmac(secret, data) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64url(await crypto.subtle.sign("HMAC", key, enc.encode(data)));
}

function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

async function sign(secret, obj) {
  const body = b64url(enc.encode(JSON.stringify(obj)));
  return `${body}.${await hmac(secret, body)}`;
}

async function verify(secret, token) {
  if (!token || !token.includes(".")) return null;
  const [body, sig] = token.split(".");
  if (!safeEqual(sig, await hmac(secret, body))) return null;
  try {
    const obj = JSON.parse(b64urlDecode(body));
    return obj.exp > now() ? obj : null;
  } catch { return null; }
}

function getCookie(request, name) {
  const m = (request.headers.get("Cookie") || "").match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  return m ? m[1] : null;
}

const cookie = (name, value, maxAge, path = "/") =>
  `${name}=${value}; Path=${path}; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;

const list = v => (v || "").split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
const isAdmin = (env, email) => list(env.ADMIN_EMAILS).includes(String(email || "").toLowerCase());

// Nur relative Pfade als Rücksprungziel zulassen (kein Open Redirect).
const safeNext = n => (n && n.startsWith("/") && !n.startsWith("//") && !n.startsWith("/\\")) ? n : "/";

// ---------- Nutzerliste (KV) ----------
const getUser = async (env, email) => env.USERS ? env.USERS.get(`user:${email}`, "json") : null;
const putUser = (env, email, data) => env.USERS.put(`user:${email}`, JSON.stringify(data));
async function allUsers(env) {
  const out = [];
  let cursor;
  do {
    const r = await env.USERS.list({ prefix: "user:", cursor });
    for (const k of r.keys) {
      const u = await env.USERS.get(k.name, "json");
      if (u) out.push({ email: k.name.slice(5), ...u });
    }
    cursor = r.list_complete ? null : r.cursor;
  } while (cursor);
  return out;
}

async function notify(env, text) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return;
  try {
    await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text, disable_web_page_preview: true }),
    });
  } catch { /* Benachrichtigung ist optional */ }
}

// ---------- Antworten ----------
function page(status, title, html, headers = {}) {
  return new Response(`<!doctype html><html lang="de"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>body{font-family:system-ui,sans-serif;background:#0f1115;color:#e6e6e6;margin:0;padding:16px}
main{max-width:640px;margin:10vh auto;text-align:center}a{color:#7cb7ff}
table{width:100%;border-collapse:collapse;text-align:left;margin:12px 0}td,th{padding:8px 6px;border-bottom:1px solid #2a2e36;font-size:14px;word-break:break-all}
button{background:#2a2e36;color:#e6e6e6;border:1px solid #3a3f4a;border-radius:6px;padding:6px 10px;cursor:pointer;margin:2px}
button.ok{background:#1f5f3a;border-color:#2f8f57}h2{margin-top:28px;text-align:left}</style></head>
<body><main><h1>${esc(title)}</h1>${html}</main></body></html>`,
    { status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", ...headers } });
}

const redirect = (location, cookies = []) => {
  const h = new Headers({ Location: location, "Cache-Control": "no-store" });
  cookies.forEach(c => h.append("Set-Cookie", c));
  return new Response(null, { status: 302, headers: h });
};

const again = `<p><a href="/auth/login">Mit anderem Konto anmelden</a></p>`;

// ---------- Google-Login ----------
async function login(url, env) {
  const state = b64url(crypto.getRandomValues(new Uint8Array(24)));
  const next = safeNext(url.searchParams.get("next"));
  const stateCookie = await sign(env.SESSION_SECRET, { s: state, n: next, exp: now() + 600 });
  const params = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: `${url.origin}/auth/callback`,
    response_type: "code",
    scope: "openid email profile",
    state,
    prompt: "select_account",
  });
  return redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`,
    [cookie(STATE_COOKIE, stateCookie, 600, "/auth/")]);
}

async function callback(request, url, env, ctx) {
  const st = await verify(env.SESSION_SECRET, getCookie(request, STATE_COOKIE));
  const code = url.searchParams.get("code");
  if (!st || !code || !safeEqual(st.s, url.searchParams.get("state") || "")) {
    return page(400, "Login abgelaufen", `<p>Bitte noch einmal versuchen.</p>${again}`);
  }
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: `${url.origin}/auth/callback`,
      grant_type: "authorization_code",
    }),
  });
  if (!r.ok) return page(502, "Login fehlgeschlagen", `<p>Google hat die Anmeldung nicht bestätigt.</p>${again}`);
  // Das ID-Token kommt direkt per TLS von Google, daher reicht das Prüfen der Felder.
  const { id_token } = await r.json();
  let c;
  try { c = JSON.parse(b64urlDecode(id_token.split(".")[1])); } catch { c = {}; }
  const okIssuer = ["https://accounts.google.com", "accounts.google.com"].includes(c.iss);
  if (!okIssuer || c.aud !== env.GOOGLE_CLIENT_ID || !c.email_verified || !c.email) {
    return page(403, "Login fehlgeschlagen", `<p>Die Google-Anmeldung war ungültig.</p>${again}`);
  }
  const email = c.email.toLowerCase();
  const name = String(c.name || "").slice(0, 80);
  const clearState = cookie(STATE_COOKIE, "", 0, "/auth/");
  const startSession = async () => redirect(st.n, [
    cookie(COOKIE, await sign(env.SESSION_SECRET, { e: email, exp: now() + SESSION_DAYS * 86400 }), SESSION_DAYS * 86400),
    clearState,
  ]);

  if (isAdmin(env, email)) return startSession();

  const u = await getUser(env, email);
  if (u?.status === "approved") {
    ctx.waitUntil(Promise.all([
      putUser(env, email, { ...u, name: name || u.name, last_login: now() }),
      notify(env, `🔓 SKNews: ${name || email} (${email}) hat sich angemeldet.`),
    ]));
    return startSession();
  }
  if (u?.status === "denied") return page(403, "Kein Zugriff", `<p>Das Konto ${esc(email)} ist nicht freigeschaltet.</p>${again}`);
  if (!env.USERS) return page(403, "Kein Zugriff", `<p>Das Konto ${esc(email)} ist nicht freigeschaltet.</p>${again}`);
  if (!u) {
    await putUser(env, email, { status: "pending", name, requested_at: now() });
    ctx.waitUntil(notify(env, `🆕 SKNews: Zugangsanfrage von ${name || email} (${email}).\nFreigeben: ${url.origin}/auth/admin`));
  }
  return page(200, "Anfrage gesendet",
    `<p>Hallo ${esc(name || email)}, deine Anfrage ist eingegangen. Sobald sie freigegeben ist, kannst du dich hier anmelden.</p>${again}`,
    { "Set-Cookie": clearState });
}

// ---------- Verwaltung ----------
async function admin(request, url, env, email) {
  if (!isAdmin(env, email)) return page(403, "Kein Zugriff", "<p>Nur für Admins.</p>");
  if (!env.USERS) return page(500, "Nutzerverwaltung", "<p>Es ist kein KV-Namespace <code>USERS</code> eingebunden.</p>");

  if (request.method === "POST") {
    // Nur Formulare von der eigenen Seite annehmen (Schutz gegen fremde Seiten).
    if (request.headers.get("Origin") !== url.origin) return new Response("Falscher Ursprung", { status: 403 });
    const f = await request.formData();
    const target = String(f.get("email") || "").toLowerCase();
    const action = f.get("action");
    const u = await getUser(env, target);
    if (target && u) {
      if (action === "remove") await env.USERS.delete(`user:${target}`);
      else if (action === "approve" || action === "deny") {
        await putUser(env, target, { ...u, status: action === "approve" ? "approved" : "denied", decided_at: now() });
      }
    }
    return redirect("/auth/admin");
  }

  const users = await allUsers(env);
  const btn = (e, action, label, cls = "") =>
    `<form method="post" style="display:inline"><input type="hidden" name="email" value="${esc(e)}"><input type="hidden" name="action" value="${action}"><button class="${cls}">${label}</button></form>`;
  const rows = (status, cols, actions) => {
    const l = users.filter(u => u.status === status);
    if (!l.length) return "<p style='text-align:left;opacity:.6'>Keine.</p>";
    return `<table><tr><th>Konto</th><th>${cols[0]}</th><th></th></tr>${l.map(u =>
      `<tr><td>${esc(u.name)}<br><small>${esc(u.email)}</small></td><td>${fmt(u[cols[1]])}</td><td>${actions(u.email)}</td></tr>`).join("")}</table>`;
  };
  return page(200, "Zugänge", `
<p style="text-align:left">Angemeldet als ${esc(email)} · <a href="/">zum Dashboard</a> · <a href="/auth/logout">abmelden</a></p>
<h2>Offene Anfragen</h2>${rows("pending", ["Angefragt", "requested_at"], e => btn(e, "approve", "Freigeben", "ok") + btn(e, "deny", "Ablehnen"))}
<h2>Freigegeben</h2>${rows("approved", ["Letzte Anmeldung", "last_login"], e => btn(e, "deny", "Sperren"))}
<h2>Abgelehnt / gesperrt</h2>${rows("denied", ["Entschieden", "decided_at"], e => btn(e, "approve", "Freigeben", "ok") + btn(e, "remove", "Löschen"))}`);
}

// ---------- Einstieg ----------
export async function onRequest(context) {
  const { request, env, next } = context;
  if (!env.GOOGLE_CLIENT_ID) return next(); // noch nicht eingerichtet → offen wie bisher
  if (!env.GOOGLE_CLIENT_SECRET || !env.SESSION_SECRET || !env.ADMIN_EMAILS) {
    return page(500, "Login nicht fertig eingerichtet", "<p>In Cloudflare fehlen GOOGLE_CLIENT_SECRET, SESSION_SECRET oder ADMIN_EMAILS.</p>");
  }
  const url = new URL(request.url);

  if (url.pathname === "/auth/login") return login(url, env);
  if (url.pathname === "/auth/callback") return callback(request, url, env, context);
  if (url.pathname === "/auth/logout") {
    return page(200, "Abgemeldet", `<p><a href="/auth/login">Wieder anmelden</a></p>`, { "Set-Cookie": cookie(COOKIE, "", 0) });
  }

  const session = await verify(env.SESSION_SECRET, getCookie(request, COOKIE));
  let ok = false;
  if (session) {
    if (isAdmin(env, session.e)) ok = true;
    else ok = (await getUser(env, session.e))?.status === "approved"; // Sperren wirkt sofort
  }

  if (ok && url.pathname === "/auth/admin") return admin(request, url, env, session.e);
  if (ok) {
    const res = await next();
    const out = new Response(res.body, res);
    out.headers.set("Cache-Control", "private, no-store");
    return out;
  }

  const wantsHtml = request.method === "GET" && (request.headers.get("Accept") || "").includes("text/html");
  if (wantsHtml) return redirect(`/auth/login?next=${encodeURIComponent(url.pathname + url.search)}`);
  return new Response("Nicht angemeldet", { status: 401, headers: { "Cache-Control": "no-store" } });
}
