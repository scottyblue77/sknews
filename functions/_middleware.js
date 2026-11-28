// Anmeldung für news.skzone.de: dasselbe Konto wie DataWrangler, einmal anmelden reicht.
//
// DataWrangler (dw.skzone.de) setzt nach der Anmeldung das Cookie skz_sso für ganz skzone.de: einen mit Ed25519
// signierten Vermerk „Benutzer, Rolle, gültig bis“ (12 Stunden). Hier wird er nur mit dem öffentlichen Schlüssel
// geprüft, ein Geheimnis gibt es auf dieser Seite nicht. Fehlt der Vermerk oder ist er abgelaufen, geht der Browser
// zu dw.skzone.de/api/auth/sso, meldet sich dort an (oder ist es schon) und kommt hierher zurück.
// Den Schlüssel liefert https://dw.skzone.de/api/auth/sso/key; er ändert sich nur mit DWs MASTER_KEY.

const DW = "https://dw.skzone.de";
const PUBLIC_KEY = "UzN0moW__Txw1aiOSUB6-aCVXu5xd7O7cjAN7t3tBL4";
const HOST = "news.skzone.de";
const ROLE = "admin";

function bytes(b64url) {
  const s = b64url.replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(s + "=".repeat((4 - (s.length % 4)) % 4)), (c) => c.charCodeAt(0));
}

const keys = new Map();

/** Der geprüfte Vermerk aus dem Cookie-Header ({sub, role, exp}) oder null. */
export async function signedIn(cookieHeader, publicKey = PUBLIC_KEY, now = Date.now()) {
  const m = /(?:^|;\s*)skz_sso=([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)(?:;|$)/.exec(cookieHeader || "");
  if (!m) return null;
  try {
    if (!keys.has(publicKey)) keys.set(publicKey, crypto.subtle.importKey("raw", bytes(publicKey), { name: "Ed25519" }, false, ["verify"]));
    if (!(await crypto.subtle.verify("Ed25519", await keys.get(publicKey), bytes(m[2]), new TextEncoder().encode(m[1])))) return null;
    const claims = JSON.parse(new TextDecoder().decode(bytes(m[1])));
    return claims.role === ROLE && Number(claims.exp) * 1000 > now ? claims : null;
  } catch {
    return null;
  }
}

export async function onRequest({ request, next }) {
  const url = new URL(request.url);
  // SK (Bot auf dem NAS) ruft /api/ideen ohne Browser auf.
  // shortcut: /api/* bleibt offen wie bisher; schließen, sobald SK einen eigenen Zugang hat.
  if (url.pathname.startsWith("/api/")) return next();
  if (await signedIn(request.headers.get("cookie"))) return next();
  // sknews.pages.dev und Vorschau-Adressen bekommen das skzone.de-Cookie nie: dort gar nicht anzeigen
  if (url.hostname !== HOST || url.protocol !== "https:") return new Response(`Nur über https://${HOST}`, { status: 403 });
  return Response.redirect(`${DW}/api/auth/sso?next=${encodeURIComponent(url.href)}`, 302);
}
