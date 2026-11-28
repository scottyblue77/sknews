// node --test tests/middleware.test.mjs  (prüft die Anmeldung in functions/_middleware.js mit einem eigenen Testschlüssel)
import assert from "node:assert/strict";
import nodeCrypto from "node:crypto";
import { test } from "node:test";
import { onRequest, signedIn } from "../functions/_middleware.js";

const { privateKey, publicKey } = nodeCrypto.generateKeyPairSync("ed25519");
const PUB = Buffer.from(publicKey.export({ format: "jwk" }).x, "base64url").toString("base64url");

// so wie DataWrangler signiert (src/server/http/sso.ts)
function note(claims) {
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${payload}.${nodeCrypto.sign(null, Buffer.from(payload), privateKey).toString("base64url")}`;
}
const later = Math.floor(Date.now() / 1000) + 3600;

test("gültiger Vermerk eines Admins", async () => {
  const c = await signedIn(`a=1; skz_sso=${note({ sub: "Sebastian", role: "admin", exp: later })}; b=2`, PUB);
  assert.equal(c.sub, "Sebastian");
});

test("abgelehnt: abgelaufen, andere Rolle, verändert, fremder Schlüssel, kaputt", async () => {
  assert.equal(await signedIn(`skz_sso=${note({ sub: "x", role: "admin", exp: 1 })}`, PUB), null);
  assert.equal(await signedIn(`skz_sso=${note({ sub: "kevin", role: "viewer", exp: later })}`, PUB), null);
  const [, sig] = note({ sub: "x", role: "viewer", exp: later }).split(".");
  const forged = Buffer.from(JSON.stringify({ sub: "x", role: "admin", exp: later })).toString("base64url");
  assert.equal(await signedIn(`skz_sso=${forged}.${sig}`, PUB), null);
  const other = nodeCrypto.generateKeyPairSync("ed25519").publicKey.export({ format: "jwk" }).x;
  assert.equal(await signedIn(`skz_sso=${note({ sub: "x", role: "admin", exp: later })}`, other), null);
  assert.equal(await signedIn("skz_sso=kaputt", PUB), null);
  assert.equal(await signedIn(null, PUB), null);
});

test("ohne Vermerk: news geht zur Anmeldung bei DW, pages.dev wird abgewiesen, /api bleibt offen", async () => {
  const next = async () => new Response("seite");
  const r = await onRequest({ request: new Request("https://news.skzone.de/links.html?x=1"), next });
  assert.equal(r.status, 302);
  assert.equal(r.headers.get("location"), "https://dw.skzone.de/api/auth/sso?next=" + encodeURIComponent("https://news.skzone.de/links.html?x=1"));
  assert.equal((await onRequest({ request: new Request("https://sknews-6co.pages.dev/"), next })).status, 403);
  assert.equal(await (await onRequest({ request: new Request("https://news.skzone.de/api/ideen"), next })).text(), "seite");
});

test("weitere Rollen über SSO_ROLES", async () => {
  const viewer = `skz_sso=${note({ sub: "kevin", role: "viewer", exp: later })}`;
  assert.equal(await signedIn(viewer, PUB), null);
  assert.equal((await signedIn(viewer, PUB, Date.now(), "admin,viewer")).sub, "kevin");
});

test("Telegram: einmal pro Anmeldung, nicht für NOTIFY_IGNORE, auch bei abgewiesener Rolle", async () => {
  const { notifyOnce } = await import("../functions/_middleware.js");
  const sent = [];
  const fetchImpl = async (u, o) => { sent.push(JSON.parse(o.body).text); return new Response("{}"); };
  const env = { TELEGRAM_BOT_TOKEN: "t", TELEGRAM_CHAT_ID: "1", NOTIFY_IGNORE: "Sebastian" };
  const kevin = { sub: "kevin", role: "editor", exp: later };
  const set = notifyOnce({ env, cookieHeader: "", claims: kevin, allowed: true, fetchImpl });
  assert.match(set, /^skn_seen=kevin\.\d+;/);
  assert.equal(notifyOnce({ env, cookieHeader: set.split(";")[0], claims: kevin, allowed: true, fetchImpl }), null);
  assert.equal(notifyOnce({ env, cookieHeader: "", claims: { sub: "sebastian", role: "admin", exp: later }, allowed: true, fetchImpl }), null);
  notifyOnce({ env, cookieHeader: "", claims: { sub: "gast", role: "viewer", exp: later }, allowed: false, fetchImpl });
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(sent, ["🔓 SKNews: kevin (editor) hat sich angemeldet.", "⛔ SKNews: gast (viewer) wollte rein, die Rolle ist nicht freigegeben."]);
  assert.equal(notifyOnce({ env: {}, cookieHeader: "", claims: kevin, allowed: true, fetchImpl }), null);
});
