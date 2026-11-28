// Anmeldung für news.skzone.de: dasselbe Konto wie DataWrangler, einmal anmelden reicht.
//
// DataWrangler (dw.skzone.de) setzt nach der Anmeldung das Cookie skz_sso für ganz skzone.de: einen mit Ed25519
// signierten Vermerk „Benutzer, Rolle, gültig bis“ (12 Stunden). Hier wird er nur mit dem öffentlichen Schlüssel
// geprüft, ein Geheimnis gibt es auf dieser Seite nicht. Fehlt der Vermerk oder ist er abgelaufen, geht der Browser
// zu dw.skzone.de/api/auth/sso, meldet sich dort an (oder ist es schon) und kommt hierher zurück.
// Den Schlüssel liefert https://dw.skzone.de/api/auth/sso/key; er ändert sich nur mit DWs MASTER_KEY.
//
// Optional in Cloudflare (Pages → sknews → Einstellungen → Variablen und Geheimnisse, Production):
//   SSO_ROLES           erlaubte DW-Rollen, kommagetrennt (Standard: admin), z. B. "admin,editor,viewer"
//   TELEGRAM_BOT_TOKEN  (Secret) und TELEGRAM_CHAT_ID: Meldung bei jeder Anmeldung und jedem abgewiesenen Versuch
//   NOTIFY_IGNORE       DW-Benutzernamen ohne Meldung, kommagetrennt (z. B. der eigene)

const DW = "https://dw.skzone.de";
const PUBLIC_KEY = "UzN0moW__Txw1aiOSUB6-aCVXu5xd7O7cjAN7t3tBL4";
const HOST = "news.skzone.de";
const ROLES = "admin";
const SEEN = "skn_seen";
const list = (v) => String(v || "").split(",").map((x) => x.trim().toLowerCase()).filter(Boolean);

function bytes(b64url) {
  const s = b64url.replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(s + "=".repeat((4 - (s.length % 4)) % 4)), (c) => c.charCodeAt(0));
}

const keys = new Map();

/** Der geprüfte, noch gültige Vermerk aus dem Cookie-Header ({sub, role, exp}) oder null, egal welche Rolle. */
export async function readNote(cookieHeader, publicKey = PUBLIC_KEY, now = Date.now()) {
  const m = /(?:^|;\s*)skz_sso=([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)(?:;|$)/.exec(cookieHeader || "");
  if (!m) return null;
  try {
    if (!keys.has(publicKey)) keys.set(publicKey, crypto.subtle.importKey("raw", bytes(publicKey), { name: "Ed25519" }, false, ["verify"]));
    if (!(await crypto.subtle.verify("Ed25519", await keys.get(publicKey), bytes(m[2]), new TextEncoder().encode(m[1])))) return null;
    const claims = JSON.parse(new TextDecoder().decode(bytes(m[1])));
    return typeof claims.sub === "string" && Number(claims.exp) * 1000 > now ? claims : null;
  } catch {
    return null;
  }
}

const roleOk = (claims, roles) => list(roles || ROLES).includes(String(claims.role || "").toLowerCase());

/** Der Vermerk, wenn er gültig ist und die Rolle hereindarf, sonst null. */
export async function signedIn(cookieHeader, publicKey = PUBLIC_KEY, now = Date.now(), roles = ROLES) {
  const claims = await readNote(cookieHeader, publicKey, now);
  return claims && roleOk(claims, roles) ? claims : null;
}

/**
 * Telegram-Meldung einmal pro Anmeldung (pro 12-Stunden-Vermerk): gemerkt im Cookie skn_seen, also ohne Speicher.
 * Gibt den Set-Cookie-Wert zurück, wenn gemeldet wurde, sonst null.
 */
export function notifyOnce({ env, waitUntil, cookieHeader, claims, allowed, fetchImpl = fetch }) {
  if (!env?.TELEGRAM_BOT_TOKEN || !env?.TELEGRAM_CHAT_ID) return null;
  if (list(env.NOTIFY_IGNORE).includes(claims.sub.toLowerCase())) return null;
  const mark = encodeURIComponent(`${claims.sub}.${claims.exp}`);
  if (new RegExp(`(?:^|;\\s*)${SEEN}=([^;]*)`).exec(cookieHeader || "")?.[1] === mark) return null;
  const text = allowed
    ? `🔓 SKNews: ${claims.sub} (${claims.role}) hat sich angemeldet.`
    : `⛔ SKNews: ${claims.sub} (${claims.role}) wollte rein, die Rolle ist nicht freigegeben.`;
  const send = fetchImpl(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text }),
  }).catch(() => {});
  if (waitUntil) waitUntil(send);
  return `${SEEN}=${mark}; Path=/; Max-Age=${13 * 3600}; HttpOnly; Secure; SameSite=Lax`;
}

const isPage = (request) => request.method === "GET" && (request.headers.get("accept") || "").includes("text/html");

export async function onRequest({ request, next, env = {}, waitUntil }) {
  const url = new URL(request.url);
  // SK (Bot auf dem NAS) ruft /api/ideen ohne Browser auf.
  // shortcut: /api/* bleibt offen wie bisher; schließen, sobald SK einen eigenen Zugang hat.
  if (url.pathname.startsWith("/api/")) return next();
  const cookieHeader = request.headers.get("cookie");
  const claims = await readNote(cookieHeader);
  if (claims) {
    const allowed = roleOk(claims, env.SSO_ROLES);
    const seen = isPage(request) ? notifyOnce({ env, waitUntil, cookieHeader, claims, allowed }) : null;
    let res = allowed
      ? await next()
      : new Response(`Kein Zugriff: Das DataWrangler-Konto ${claims.sub} hat keine freigegebene Rolle.`, { status: 403, headers: { "content-type": "text/plain; charset=utf-8" } });
    if (seen) {
      res = new Response(res.body, res);
      res.headers.append("Set-Cookie", seen);
    }
    return res;
  }
  // sknews-6co.pages.dev und Vorschau-Adressen bekommen das skzone.de-Cookie nie: dort gar nicht anzeigen
  if (url.hostname !== HOST || url.protocol !== "https:") return new Response(`Nur über https://${HOST}`, { status: 403 });
  return Response.redirect(`${DW}/api/auth/sso?next=${encodeURIComponent(url.href)}`, 302);
}
