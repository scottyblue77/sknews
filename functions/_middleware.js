// Anmeldung über DataWrangler (dw.skzone.de) vor dem Dashboard (Cloudflare Pages Function).
//
// Läuft vor jeder Anfrage, also auch vor deals.html und /api/ideen.
// DW setzt nach dem Login das Cookie `skz_sso` für die ganze Domain skzone.de: ein mit Ed25519
// signierter Vermerk {sub: Benutzername, role, exp}. Diese Funktion prüft ihn nur mit dem
// öffentlichen Schlüssel von DW, braucht also kein Geheimnis. Fehlt der Vermerk oder ist er
// abgelaufen (nach 12 h), geht es zu https://dw.skzone.de/api/auth/sso?next=<diese Seite> und zurück.
// Wer rein darf, entscheidest du in DW: nur wer dort ein Konto hat (Einladung/Freigabe durch dich).
//
// Einstellungen in Cloudflare (Pages → sknews → Einstellungen → Variablen und Geheimnisse, Production):
//   DW_SSO_PUBLIC_KEY  öffentlicher Schlüssel aus https://dw.skzone.de/api/auth/sso/key ("publicKey");
//                      schaltet den Schutz ein
//   DW_URL             (optional) Adresse von DW, Standard https://dw.skzone.de
//   SSO_USERS          (optional) nur diese DW-Benutzernamen, durch Komma getrennt
//   SSO_ROLES          (optional) nur diese DW-Rollen, z. B. "admin,editor"
//   TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID  (optional) Meldung bei jeder neuen Anmeldung;
//                      braucht zusätzlich die KV-Bindung USERS, damit jede Anmeldung nur einmal gemeldet wird
//
// Ohne DW_SSO_PUBLIC_KEY bleibt die Seite wie bisher offen.

const SSO_COOKIE = "skz_sso";
const RETURN_FLAG = "_sso";
const MAIN_HOST = "news.skzone.de";

const b64urlBytes = s => {
  s = String(s).replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(s + "=".repeat((4 - s.length % 4) % 4));
  return Uint8Array.from(bin, c => c.charCodeAt(0));
};
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const list = v => (v || "").split(",").map(s => s.trim().toLowerCase()).filter(Boolean);

let cachedKey = null;
async function publicKey(raw) {
  if (cachedKey?.raw !== raw) {
    cachedKey = { raw, key: await crypto.subtle.importKey("raw", b64urlBytes(raw), { name: "Ed25519" }, false, ["verify"]) };
  }
  return cachedKey.key;
}

// Gibt {sub, role, exp} zurück, wenn der Vermerk echt und noch gültig ist, sonst null.
export async function checkToken(env, token) {
  if (!token || token.split(".").length !== 2) return null;
  const [payload, sig] = token.split(".");
  try {
    const ok = await crypto.subtle.verify("Ed25519", await publicKey(env.DW_SSO_PUBLIC_KEY), b64urlBytes(sig), new TextEncoder().encode(payload));
    if (!ok) return null;
    const p = JSON.parse(new TextDecoder().decode(b64urlBytes(payload)));
    if (typeof p.sub !== "string" || !(p.exp > Date.now() / 1000)) return null;
    return p;
  } catch { return null; }
}

function allowed(env, p) {
  const users = list(env.SSO_USERS), roles = list(env.SSO_ROLES);
  if (users.length && !users.includes(p.sub.toLowerCase())) return false;
  if (roles.length && !roles.includes(String(p.role || "").toLowerCase())) return false;
  return true;
}

function getCookie(request, name) {
  const m = (request.headers.get("Cookie") || "").match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  return m ? decodeURIComponent(m[1]) : null;
}

function page(status, title, html, headers = {}) {
  return new Response(`<!doctype html><html lang="de"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>body{font-family:system-ui,sans-serif;background:#0f1115;color:#e6e6e6;margin:0;padding:16px}
main{max-width:560px;margin:12vh auto;text-align:center}a{color:#7cb7ff}</style></head>
<body><main><h1>${esc(title)}</h1>${html}</main></body></html>`,
    { status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", ...headers } });
}

async function notifyOnce(env, ctx, p) {
  if (!env.USERS || !env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return;
  const key = `seen:${p.sub}:${p.exp}`;
  if (await env.USERS.get(key)) return;
  ctx.waitUntil((async () => {
    await env.USERS.put(key, "1", { expirationTtl: Math.max(60, Math.ceil(p.exp - Date.now() / 1000) + 60) });
    try {
      await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text: `🔓 SKNews: ${p.sub} (${p.role || "?"}) hat sich angemeldet.` }),
      });
    } catch { /* Meldung ist optional */ }
  })());
}

export async function onRequest(context) {
  const { request, env, next } = context;
  if (!env.DW_SSO_PUBLIC_KEY) return next(); // noch nicht eingerichtet → offen wie bisher
  const url = new URL(request.url);
  const dw = (env.DW_URL || "https://dw.skzone.de").replace(/\/+$/, "");
  const isHtml = request.method === "GET" && (request.headers.get("Accept") || "").includes("text/html");

  // Das DW-Cookie gilt nur für *.skzone.de: Aufrufe über pages.dev auf die eigene Domain umlenken.
  if (url.hostname !== MAIN_HOST && url.hostname.endsWith(".pages.dev")) {
    if (!isHtml) return new Response(JSON.stringify({ error: "nur über https://" + MAIN_HOST }), { status: 401, headers: { "Content-Type": "application/json" } });
    return Response.redirect(`https://${MAIN_HOST}${url.pathname}${url.search}`, 302);
  }

  if (url.pathname === "/auth/logout") {
    return page(200, "Abgemeldet", `<p>Bei SKNews abgemeldet. In DataWrangler bist du noch angemeldet, dort kannst du dich ganz abmelden.</p>
<p><a href="/">Wieder anmelden</a> · <a href="${esc(dw)}/">DataWrangler öffnen</a></p>`,
      { "Set-Cookie": `${SSO_COOKIE}=; Path=/; Domain=skzone.de; Max-Age=0; HttpOnly; Secure; SameSite=Lax` });
  }

  const p = await checkToken(env, getCookie(request, SSO_COOKIE));
  if (p && allowed(env, p)) {
    if (isHtml) await notifyOnce(env, context, p);
    // Rücksprung-Markierung aus der Adresse entfernen
    if (url.searchParams.has(RETURN_FLAG) && isHtml) {
      url.searchParams.delete(RETURN_FLAG);
      return Response.redirect(url.toString(), 302);
    }
    const res = await next();
    const out = new Response(res.body, res);
    out.headers.set("Cache-Control", "private, no-store");
    return out;
  }

  if (p) {
    return page(403, "Kein Zugriff", `<p>Das DataWrangler-Konto <b>${esc(p.sub)}</b> ist für SKNews nicht freigeschaltet.</p>`);
  }
  if (!isHtml) {
    return new Response(JSON.stringify({ error: "nicht angemeldet" }), { status: 401, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
  }
  // Schon einmal bei DW gewesen und trotzdem kein gültiger Vermerk: nicht endlos im Kreis schicken.
  if (url.searchParams.has(RETURN_FLAG)) {
    return page(502, "Anmeldung klappt nicht", `<p>DataWrangler hat keinen gültigen Anmelde-Vermerk geliefert. Ist dort <code>SSO_COOKIE_DOMAIN=skzone.de</code> gesetzt und stimmt <code>DW_SSO_PUBLIC_KEY</code> in Cloudflare?</p>
<p><a href="${esc(dw)}/">DataWrangler öffnen</a></p>`);
  }
  url.searchParams.set(RETURN_FLAG, "1");
  return Response.redirect(`${dw}/api/auth/sso?next=${encodeURIComponent(url.toString())}`, 302);
}
