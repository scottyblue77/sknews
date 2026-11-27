// Login mit Freigabe vor dem Dashboard (Cloudflare Pages Function).
//
// Läuft vor jeder Anfrage an news.skzone.de bzw. sknews-6co.pages.dev, also auch vor
// der Deals-Seite und /api/ideen.
//
// Anmelden:
//  - per E-Mail: Adresse eingeben, 6-stelligen Code aus der Mail eintippen (Versand über Resend)
//  - optional zusätzlich per Google, wenn GOOGLE_CLIENT_ID gesetzt ist
// Freigabe:
//  - Admins (ADMIN_EMAILS) kommen immer rein.
//  - Wer sonst eine Adresse eingibt, landet als "Anfrage" in der Liste. Der Admin bekommt eine
//    Telegram-Nachricht und gibt unter /auth/admin frei, lehnt ab oder sperrt später.
//  - Jede Anmeldung eines freigegebenen Nutzers wird ebenfalls per Telegram gemeldet.
//
// Einstellungen in Cloudflare (Pages → sknews → Einstellungen):
//  Variablen und Geheimnisse (Production, Typ "Secret"):
//   SESSION_SECRET        lange Zufallszeichenkette; schaltet den Login ein
//   ADMIN_EMAILS          Adresse(n) der Admins, durch Komma getrennt
//   RESEND_API_KEY        API-Key von resend.com (für die Code-Mails)
//   MAIL_FROM             Absender, z. B. "SKNews <login@skzone.de>" (Domain bei Resend bestätigt)
//   TELEGRAM_BOT_TOKEN    (optional) Bot-Token für Benachrichtigungen
//   TELEGRAM_CHAT_ID      (optional) Chat-ID, an die gemeldet wird
//   GOOGLE_CLIENT_ID      (optional) Google-Login zusätzlich anbieten
//   GOOGLE_CLIENT_SECRET  (optional) dazu
//  Bindungen:
//   KV-Namespace mit Variablenname USERS (Anfragen, Freigaben, Codes)
//
// Solange SESSION_SECRET nicht gesetzt ist, bleibt die Seite wie bisher offen,
// damit ein Deploy vor dem Einrichten nichts kaputt macht.

const COOKIE = "sknews_session";
const STATE_COOKIE = "sknews_oauth";
const SESSION_DAYS = 30;
const CODE_MINUTES = 10;
const CODE_TRIES = 5;

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
const validEmail = e => /^[^\s@<>"',;]{1,64}@[^\s@<>"',;]{1,190}\.[a-z]{2,}$/i.test(e);

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

// ---------- Speicher (KV) ----------
const getUser = (env, email) => env.USERS.get(`user:${email}`, "json");
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

// Einfache Bremse gegen Massenversand: zählt pro Schlüssel und Stunde.
async function tooMany(env, key, max) {
  const k = `rate:${key}:${Math.floor(Date.now() / 3600000)}`;
  const n = Number(await env.USERS.get(k)) || 0;
  if (n >= max) return true;
  await env.USERS.put(k, String(n + 1), { expirationTtl: 3700 });
  return false;
}

// ---------- Nachrichten nach außen ----------
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

async function sendMail(env, to, subject, text) {
  if (!env.RESEND_API_KEY || !env.MAIL_FROM) return false;
  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Authorization": `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: env.MAIL_FROM, to: [to], subject, text }),
    });
    return r.ok;
  } catch { return false; }
}

// ---------- Seiten ----------
function page(status, title, html, headers = {}) {
  return new Response(`<!doctype html><html lang="de"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>body{font-family:system-ui,sans-serif;background:#0f1115;color:#e6e6e6;margin:0;padding:16px}
main{max-width:640px;margin:10vh auto;text-align:center}a{color:#7cb7ff}
table{width:100%;border-collapse:collapse;text-align:left;margin:12px 0}td,th{padding:8px 6px;border-bottom:1px solid #2a2e36;font-size:14px;word-break:break-all}
button{background:#2a2e36;color:#e6e6e6;border:1px solid #3a3f4a;border-radius:6px;padding:8px 12px;cursor:pointer;margin:2px;font-size:15px}
button.ok{background:#1f5f3a;border-color:#2f8f57}h2{margin-top:28px;text-align:left}
input{background:#171a21;color:#e6e6e6;border:1px solid #3a3f4a;border-radius:6px;padding:10px;font-size:16px;width:100%;max-width:320px;box-sizing:border-box;margin:6px 0}
input.code{letter-spacing:.4em;text-align:center;font-size:22px;max-width:220px}
.hint{opacity:.7;font-size:14px}.or{margin:22px 0 10px;opacity:.6}</style></head>
<body><main><h1>${esc(title)}</h1>${html}</main></body></html>`,
    { status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", ...headers } });
}

const redirect = (location, cookies = []) => {
  const h = new Headers({ Location: location, "Cache-Control": "no-store" });
  cookies.forEach(c => h.append("Set-Cookie", c));
  return new Response(null, { status: 302, headers: h });
};

const back = `<p><a href="/auth/login">Zurück zur Anmeldung</a></p>`;

function loginPage(env, next, msg = "") {
  const google = env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET
    ? `<p class="or">oder</p><p><a href="/auth/google?next=${encodeURIComponent(next)}"><button type="button">Mit Google anmelden</button></a></p>` : "";
  return page(200, "SKNews Anmeldung", `${msg}
<form method="post" action="/auth/code">
<input type="hidden" name="next" value="${esc(next)}">
<p><input type="email" name="email" placeholder="deine@email.de" autocomplete="email" required autofocus></p>
<p><button class="ok">Code per E-Mail schicken</button></p>
<p class="hint">Neue Adressen müssen einmal freigegeben werden.</p></form>${google}`);
}

function codePage(email, next, msg = "") {
  return page(200, "Code eingeben", `${msg}
<p>Wir haben einen 6-stelligen Code an <b>${esc(email)}</b> geschickt. Er gilt ${CODE_MINUTES} Minuten.</p>
<form method="post" action="/auth/verify">
<input type="hidden" name="email" value="${esc(email)}"><input type="hidden" name="next" value="${esc(next)}">
<p><input class="code" name="code" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" autocomplete="one-time-code" required autofocus></p>
<p><button class="ok">Anmelden</button></p></form>${back}`);
}

// ---------- Ablauf nach erfolgreichem Nachweis der Adresse ----------
// Gibt bei freigegebenen Konten eine Session aus, sonst eine Seite zur Anfrage.
async function admit(env, ctx, email, name, next, via, extraCookies = []) {
  const startSession = async () => redirect(next, [
    cookie(COOKIE, await sign(env.SESSION_SECRET, { e: email, exp: now() + SESSION_DAYS * 86400 }), SESSION_DAYS * 86400),
    ...extraCookies,
  ]);
  if (isAdmin(env, email)) return startSession();
  const u = await getUser(env, email);
  if (u?.status === "approved") {
    ctx.waitUntil(Promise.all([
      putUser(env, email, { ...u, name: name || u.name, last_login: now() }),
      notify(env, `🔓 SKNews: ${name || u.name || email} (${email}) hat sich angemeldet (${via}).`),
    ]));
    return startSession();
  }
  return requestPage(env, ctx, email, name, u);
}

async function requestPage(env, ctx, email, name, u) {
  if (u?.status === "denied") return page(403, "Kein Zugriff", `<p>Die Adresse ${esc(email)} ist nicht freigeschaltet.</p>${back}`);
  if (!u) {
    await putUser(env, email, { status: "pending", name, requested_at: now() });
    ctx.waitUntil(notify(env, `🆕 SKNews: Zugangsanfrage von ${name ? `${name} (${email})` : email}.\nFreigeben: ${env.__origin}/auth/admin`));
  }
  return page(200, "Anfrage gesendet",
    `<p>Deine Anfrage für ${esc(email)} ist eingegangen. Sobald sie freigegeben ist, bekommst du eine Mail und kannst dich hier anmelden.</p>${back}`);
}

// ---------- E-Mail-Code ----------
async function requestCode(request, env, ctx) {
  const f = await request.formData();
  const email = String(f.get("email") || "").trim().toLowerCase();
  const next = safeNext(String(f.get("next") || "/"));
  if (!validEmail(email)) return loginPage(env, next, `<p>Bitte eine gültige E-Mail-Adresse eingeben.</p>`);

  const ip = request.headers.get("CF-Connecting-IP") || "?";
  if (await tooMany(env, `ip:${ip}`, 20) || await tooMany(env, `mail:${email}`, 5)) {
    return page(429, "Zu viele Versuche", `<p>Bitte in einer Stunde noch einmal versuchen.</p>${back}`);
  }

  if (!isAdmin(env, email)) {
    const u = await getUser(env, email);
    if (u?.status !== "approved") return requestPage(env, ctx, email, "", u);
  }

  const code = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1000000).padStart(6, "0");
  await env.USERS.put(`otp:${email}`,
    JSON.stringify({ h: await hmac(env.SESSION_SECRET, `${email}:${code}`), tries: 0, exp: now() + CODE_MINUTES * 60 }),
    { expirationTtl: CODE_MINUTES * 60 });
  const sent = await sendMail(env, email, `Dein SKNews-Code: ${code}`,
    `Dein Anmeldecode für SKNews: ${code}\n\nEr gilt ${CODE_MINUTES} Minuten. Wenn du das nicht warst, kannst du die Mail ignorieren.`);
  if (!sent) return page(502, "Mail nicht verschickt", `<p>Der Code konnte nicht verschickt werden. Bitte später noch einmal versuchen.</p>${back}`);
  return codePage(email, next);
}

async function verifyCode(request, env, ctx) {
  const f = await request.formData();
  const email = String(f.get("email") || "").trim().toLowerCase();
  const code = String(f.get("code") || "").trim();
  const next = safeNext(String(f.get("next") || "/"));
  const otp = validEmail(email) ? await env.USERS.get(`otp:${email}`, "json") : null;
  if (!otp || otp.exp < now() || otp.tries >= CODE_TRIES) {
    if (otp) await env.USERS.delete(`otp:${email}`);
    return loginPage(env, next, `<p>Der Code ist abgelaufen. Bitte einen neuen anfordern.</p>`);
  }
  if (!/^\d{6}$/.test(code) || !safeEqual(otp.h, await hmac(env.SESSION_SECRET, `${email}:${code}`))) {
    const left = otp.exp - now();
    if (left >= 60) await env.USERS.put(`otp:${email}`, JSON.stringify({ ...otp, tries: otp.tries + 1 }), { expirationTtl: left });
    return codePage(email, next, `<p>Der Code stimmt nicht.</p>`);
  }
  await env.USERS.delete(`otp:${email}`);
  return admit(env, ctx, email, "", next, "E-Mail");
}

// ---------- Google (optional) ----------
async function googleStart(url, env) {
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

async function googleCallback(request, url, env, ctx) {
  const st = await verify(env.SESSION_SECRET, getCookie(request, STATE_COOKIE));
  const code = url.searchParams.get("code");
  if (!st || !code || !safeEqual(st.s, url.searchParams.get("state") || "")) {
    return page(400, "Login abgelaufen", `<p>Bitte noch einmal versuchen.</p>${back}`);
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
  if (!r.ok) return page(502, "Login fehlgeschlagen", `<p>Google hat die Anmeldung nicht bestätigt.</p>${back}`);
  // Das ID-Token kommt direkt per TLS von Google, daher reicht das Prüfen der Felder.
  const { id_token } = await r.json();
  let c;
  try { c = JSON.parse(b64urlDecode(id_token.split(".")[1])); } catch { c = {}; }
  const okIssuer = ["https://accounts.google.com", "accounts.google.com"].includes(c.iss);
  if (!okIssuer || c.aud !== env.GOOGLE_CLIENT_ID || !c.email_verified || !c.email) {
    return page(403, "Login fehlgeschlagen", `<p>Die Google-Anmeldung war ungültig.</p>${back}`);
  }
  return admit(env, ctx, c.email.toLowerCase(), String(c.name || "").slice(0, 80), st.n, "Google",
    [cookie(STATE_COOKIE, "", 0, "/auth/")]);
}

// ---------- Verwaltung ----------
async function admin(request, url, env, ctx, email) {
  if (!isAdmin(env, email)) return page(403, "Kein Zugriff", "<p>Nur für Admins.</p>");

  if (request.method === "POST") {
    const f = await request.formData();
    const target = String(f.get("email") || "").toLowerCase();
    const action = f.get("action");
    const u = await getUser(env, target);
    if (target && u) {
      if (action === "remove") await env.USERS.delete(`user:${target}`);
      else if (action === "approve" || action === "deny") {
        await putUser(env, target, { ...u, status: action === "approve" ? "approved" : "denied", decided_at: now() });
        if (action === "approve" && u.status === "pending") {
          ctx.waitUntil(sendMail(env, target, "SKNews: Zugang freigeschaltet",
            `Dein Zugang zu SKNews ist freigeschaltet. Anmelden: ${url.origin}/auth/login`));
        }
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
      `<tr><td>${esc(u.name)}${u.name ? "<br>" : ""}<small>${esc(u.email)}</small></td><td>${fmt(u[cols[1]])}</td><td>${actions(u.email)}</td></tr>`).join("")}</table>`;
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
  if (!env.SESSION_SECRET) return next(); // noch nicht eingerichtet → offen wie bisher
  if (!env.ADMIN_EMAILS || !env.USERS) {
    return page(500, "Login nicht fertig eingerichtet", "<p>In Cloudflare fehlen ADMIN_EMAILS oder die KV-Bindung USERS.</p>");
  }
  const url = new URL(request.url);
  env.__origin = url.origin;
  const path = url.pathname;

  // Formulare nur von der eigenen Seite annehmen (Schutz gegen fremde Seiten).
  if (request.method === "POST" && path.startsWith("/auth/") && request.headers.get("Origin") !== url.origin) {
    return new Response("Falscher Ursprung", { status: 403 });
  }

  if (path === "/auth/login") return loginPage(env, safeNext(url.searchParams.get("next")));
  if (path === "/auth/code" && request.method === "POST") return requestCode(request, env, context);
  if (path === "/auth/verify" && request.method === "POST") return verifyCode(request, env, context);
  if (path === "/auth/google" && env.GOOGLE_CLIENT_ID) return googleStart(url, env);
  if (path === "/auth/callback" && env.GOOGLE_CLIENT_ID) return googleCallback(request, url, env, context);
  if (path === "/auth/logout") {
    return page(200, "Abgemeldet", `<p><a href="/auth/login">Wieder anmelden</a></p>`, { "Set-Cookie": cookie(COOKIE, "", 0) });
  }

  const session = await verify(env.SESSION_SECRET, getCookie(request, COOKIE));
  let ok = false;
  if (session) {
    if (isAdmin(env, session.e)) ok = true;
    else ok = (await getUser(env, session.e))?.status === "approved"; // Sperren wirkt sofort
  }

  if (ok && path === "/auth/admin") return admin(request, url, env, context, session.e);
  if (ok) {
    const res = await next();
    const out = new Response(res.body, res);
    out.headers.set("Cache-Control", "private, no-store");
    return out;
  }

  const wantsHtml = request.method === "GET" && (request.headers.get("Accept") || "").includes("text/html");
  if (wantsHtml) return redirect(`/auth/login?next=${encodeURIComponent(path + url.search)}`);
  return new Response(JSON.stringify({ error: "nicht angemeldet" }), {
    status: 401, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}
