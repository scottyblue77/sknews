"""Kostenlose Preissuche: Suchmaschine -> Händlerseiten -> Preise, ohne Preis-API und ohne NAS.

Läuft in GitHub Actions (siehe .github/workflows/deals.yml):
1. Für jedes Produkt der Watchlist wird nach EAN/GTIN und Modellnummer gesucht (Bing, DuckDuckGo).
   Dazu kommen fest hinterlegte Händler-Links aus config/deals.json ("shops").
2. Jede Händlerseite wird gelesen. Zuerst zählen die strukturierten Produktdaten (JSON-LD), die
   Shops für Suchmaschinen einbauen: GTIN oder Modellnummer muss exakt passen.
3. Nur wenn eine Seite keine solchen Daten hat, liest die KI (Gemini, kostenloser Schlüssel optional)
   den Seitentext. Ein KI-Preis zählt nur, wenn er wörtlich im Text steht und plausibel ist.
4. Die Historie liegt dauerhaft in docs/data/deals-history.json, die Seite liest docs/data/deals.json.

Portale wie idealo werden nicht abgefragt (sie sperren automatische Abrufe), robots.txt wird beachtet.
"""
import html as htmllib
import json
import os
import re
import statistics
import sys
import tempfile
import time
import urllib.parse
import urllib.request
import urllib.robotparser
from concurrent.futures import ThreadPoolExecutor
from html.parser import HTMLParser
from pathlib import Path

from deals import Store
from portals import Scripts, nodes, money

ROOT = Path(__file__).resolve().parents[1]
CONFIG = ROOT / 'config' / 'deals.json'
SNAPSHOT = ROOT / 'docs' / 'data' / 'deals.json'
HISTORY = ROOT / 'docs' / 'data' / 'deals-history.json'
BOT = 'SKNews-Deals'
UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 SKNews-Deals/1.1'
GEMINI_MODEL = os.environ.get('DEALS_GEMINI_MODEL', 'gemini-2.5-flash')
MAX_PAGES = 20
# Preisportale (sperren Abrufe), Gebrauchtmärkte, Foren und Videos liefern keine verwertbaren Neupreise.
SKIP = ('idealo.', 'geizhals.', 'billiger.', 'guenstiger.', 'preis.de', 'check24.', 'ebay.', 'kleinanzeigen.',
        'rebuy.', 'backmarket.', 'youtube.', 'reddit.', 'wikipedia.', 'computerbase.', 'hardwareluxx.',
        'rtings.', 'facebook.', 'instagram.', 'tiktok.', 'pinterest.', 'bing.', 'duckduckgo.', 'google.',
        'mydealz.', 'pricespy.', 'pricerunner.', 'icecat.', 'manua.ls', 'manualslib.')
AVAILABLE = {'InStock': True, 'LimitedAvailability': True, 'OnlineOnly': True, 'InStoreOnly': False,
             'OutOfStock': False, 'SoldOut': False, 'Discontinued': False, 'BackOrder': False, 'PreOrder': False,
             'PreSale': False}


def log(*a):
    print(*a, file=sys.stderr, flush=True)


def host(u):
    return (urllib.parse.urlsplit(u).hostname or '').lower()


def base_domain(h):
    parts = h.split('.')
    return '.'.join(parts[-2:]) if len(parts) >= 2 else h


def norm(s):
    return re.sub(r'[^a-z0-9]', '', str(s).lower())


def fetch(url, timeout=20, limit=3_000_000):
    req = urllib.request.Request(url, headers={'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8',
                                               'Accept-Language': 'de-DE,de;q=0.9'})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        final = r.geturl()
        raw = r.read(limit + 1)
    if len(raw) > limit:
        raise ValueError('Seite zu groß')
    return final, raw.decode('utf-8', 'replace')


# ---------- Suche ----------

def search_bing(q):
    """Liste aus (URL, Titel + Textauszug)."""
    _, t = fetch('https://www.bing.com/search?format=rss&cc=DE&setlang=de-DE&count=30&q=' + urllib.parse.quote(q))
    out = []
    for item in re.findall(r'<item>(.*?)</item>', t, re.S):
        link = re.search(r'<link>(.*?)</link>', item, re.S)
        if link:
            out.append((htmllib.unescape(link.group(1)), htmllib.unescape(re.sub(r'<[^>]+>', ' ', item))))
    return out


def search_ddg(q):
    _, t = fetch('https://html.duckduckgo.com/html/?kl=de-de&q=' + urllib.parse.quote(q))
    out = []
    for block in re.split(r'class="result[ _]', t)[1:]:
        m = re.search(r'href="([^"]*uddg=[^"]+)"', block)
        if m:
            u = urllib.parse.parse_qs(urllib.parse.urlsplit(htmllib.unescape(m.group(1))).query).get('uddg', [''])[0]
            if u:
                out.append((u, htmllib.unescape(re.sub(r'<[^>]+>', ' ', block))))
    return out


def markers(w):
    """Kennungen, an denen ein Suchtreffer als passend erkannt wird (nur Vorauswahl, die Seite prüft exakt)."""
    m = {w['variant']}
    model = norm(w.get('model') or '')
    if model:
        m.add(model)
        if len(model) >= 10:
            m.add(model[1:-3])  # Samsung & Co.: LS57CG954NUXEN wird oft als S57CG954NU geführt
    m |= {norm(t) for t in re.findall(r'\b(?=\w*\d)(?=\w*[A-Za-z])\w{5,}\b', w['name'])}
    return {x for x in m if len(x) >= 5}


def relevant(u, text, w):
    hay = norm(u + ' ' + text)
    return any(x in hay for x in markers(w))


def candidates(w, status):
    """Kandidaten-URLs: feste Händler-Links zuerst, dann Suchtreffer (ohne Portale und Gebrauchtmärkte)."""
    queries = [w['variant']]
    if w.get('model'):
        queries += [w['model'], f"{w['model']} kaufen"]
    seen, urls = set(), []
    def add(u, fixed=False):
        h = host(u)
        if not u.startswith('https://') or not h or (not fixed and any(s in h for s in SKIP)):
            return
        key = norm(u.split('#')[0])
        if key not in seen:
            seen.add(key)
            urls.append(u)
    for u in w.get('shops', []):
        add(u, fixed=True)
    for q in queries:
        for name, engine in (('bing', search_bing), ('duckduckgo', search_ddg)):
            try:
                found = [u for u, text in engine(q) if relevant(u, text, w)]
                status.append({'watch': w['id'], 'source': name, 'ok': True, 'query': q, 'hits': len(found)})
                for u in found:
                    add(u)
            except Exception as e:  # Suchmaschine nicht erreichbar: andere Suche läuft weiter
                status.append({'watch': w['id'], 'source': name, 'ok': False, 'query': q, 'error': type(e).__name__})
    # pro Shop nur eine Seite, damit kein Händler die Liste füllt
    per_shop, out = set(), []
    for u in urls:
        d = base_domain(host(u))
        if d not in per_shop:
            per_shop.add(d)
            out.append(u)
    return out[:MAX_PAGES]


_robots = {}


def allowed(url):
    p = urllib.parse.urlsplit(url)
    if p.netloc not in _robots:
        rp = urllib.robotparser.RobotFileParser()
        try:
            _, t = fetch(f'https://{p.netloc}/robots.txt', timeout=10, limit=500_000)
            rp.parse(t.splitlines())
        except Exception:
            rp.parse([])  # keine robots.txt lesbar: wie "alles erlaubt" (Standardverhalten)
        _robots[p.netloc] = rp
    return _robots[p.netloc].can_fetch(BOT, url)


# ---------- Auswerten: strukturierte Daten ----------

def identity_ok(product, w):
    """GTIN exakt gleich, oder (ohne GTIN auf der Seite) exakte Modellnummer in mpn/sku/Name."""
    gtins = {str(product[k]).lstrip('0') for k in ('gtin', 'gtin8', 'gtin12', 'gtin13', 'gtin14', 'ean') if product.get(k)}
    if gtins and w['variant'].isdigit():
        return w['variant'].lstrip('0') in gtins
    model = norm(w.get('model') or '')
    if not model:
        return False
    fields = [product.get('mpn'), product.get('sku'), product.get('model'), product.get('name')]
    return any(model in norm(f) for f in fields if isinstance(f, str))


def price_of(o):
    p = o.get('price')
    if p is None:
        spec = o.get('priceSpecification') or {}
        spec = spec[0] if isinstance(spec, list) and spec else spec
        p = spec.get('price') if isinstance(spec, dict) else None
        cur = (spec.get('priceCurrency') if isinstance(spec, dict) else None) or o.get('priceCurrency')
    else:
        cur = o.get('priceCurrency')
    if p is None or cur != 'EUR':
        return None
    try:
        return money(str(p).replace(',', '.') if str(p).count(',') == 1 and '.' not in str(p) else p)
    except Exception:
        return None


def structured(page, w, url, now):
    parser = Scripts()
    try:
        parser.feed(page)
    except Exception:
        return []
    rows = []
    for product in nodes(parser.documents):
        types = product.get('@type', [])
        types = [types] if isinstance(types, str) else types
        if not any(t in ('Product', 'ProductGroup') for t in types) or not identity_ok(product, w):
            continue
        offers = product.get('offers', [])
        offers = [offers] if isinstance(offers, dict) else offers
        for o in offers if isinstance(offers, list) else []:
            if not isinstance(o, dict) or o.get('@type') not in ('Offer', None):
                continue  # AggregateOffer: Händler/Versand unklar
            cents = price_of(o)
            avail = AVAILABLE.get(str(o.get('availability', '')).rsplit('/', 1)[-1])
            cond = str(o.get('itemCondition', 'NewCondition')).rsplit('/', 1)[-1]
            if cents is None or avail is None or cond != 'NewCondition':
                continue
            seller = o.get('seller') or {}
            merchant = (seller.get('name') if isinstance(seller, dict) else None) or base_domain(host(url))
            ship, unknown = None, True
            details = o.get('shippingDetails') or []
            for d in details if isinstance(details, list) else [details]:
                dest = (d.get('shippingDestination') or {}) if isinstance(d, dict) else {}
                dest = dest[0] if isinstance(dest, list) and dest else dest
                rate = d.get('shippingRate') or {} if isinstance(d, dict) else {}
                if isinstance(dest, dict) and dest.get('addressCountry') in ('DE', 'Germany') and rate.get('currency', 'EUR') == 'EUR' and 'value' in rate:
                    try:
                        ship, unknown = money(rate['value']), False
                    except Exception:
                        pass
                    break
            link = o.get('url') if isinstance(o.get('url'), str) and o['url'].startswith('https://') and host(o['url']) == host(url) else url
            rows.append({'watch': w['id'], 'variant': w['variant'], 'source': 'web', 'merchant': str(merchant)[:200],
                         'observed': now, 'price_cents': cents, 'shipping_cents': ship, 'shipping_unknown': unknown,
                         'currency': 'EUR', 'condition': 'new', 'available': avail, 'url': link})
    return rows


def meta_price(page, w, url, now):
    """Zweiter fester Weg ohne KI: Preis-Metadaten (Open Graph / Microdata), wenn EAN oder Modell im Seitenkopf steht."""
    title, text = page_text(page)
    head = norm(title + ' ' + ' '.join(re.findall(r'<meta[^>]+content="([^"]*)"', page[:200000])))
    model = norm(w.get('model') or '')
    if w['variant'] not in head and not (model and model in head) and not (
            w['variant'] in norm(text) and model and model[1:-3] in head):
        return []
    def meta(*names):
        for n in names:
            m = re.search(r'<meta[^>]+(?:property|itemprop|name)="' + re.escape(n) + r'"[^>]*content="([^"]+)"', page) or \
                re.search(r'<meta[^>]+content="([^"]+)"[^>]*(?:property|itemprop|name)="' + re.escape(n) + r'"', page)
            if m:
                return htmllib.unescape(m.group(1)).strip()
    price = meta('product:price:amount', 'og:price:amount', 'price')
    currency = meta('product:price:currency', 'og:price:currency', 'priceCurrency') or ''
    avail = (meta('product:availability', 'og:availability', 'availability') or '').lower()
    if not price or currency.upper() != 'EUR':
        return []
    try:
        cents = money(price.replace(',', '.') if price.count(',') == 1 and '.' not in price else price)
    except Exception:
        return []
    available = None
    if any(x in avail for x in ('instock', 'in stock', 'available for order', 'limitedavailability')):
        available = True
    elif any(x in avail for x in ('outofstock', 'out of stock', 'soldout', 'discontinued')):
        available = False
    if available is None or 'used' in (meta('product:condition', 'og:condition', 'itemCondition') or 'new').lower():
        return []
    return [{'watch': w['id'], 'variant': w['variant'], 'source': 'web', 'merchant': base_domain(host(url)),
             'observed': now, 'price_cents': cents, 'shipping_cents': None, 'shipping_unknown': True,
             'currency': 'EUR', 'condition': 'new', 'available': available, 'url': url}]


# ---------- Auswerten: KI liest den Seitentext ----------

class Text(HTMLParser):
    def __init__(self):
        super().__init__()
        self.skip, self.parts, self.title = 0, [], ''
        self._in_title = False

    def handle_starttag(self, tag, attrs):
        if tag in ('script', 'style', 'noscript', 'svg', 'template'):
            self.skip += 1
        self._in_title = tag == 'title'

    def handle_endtag(self, tag):
        if tag in ('script', 'style', 'noscript', 'svg', 'template') and self.skip:
            self.skip -= 1
        self._in_title = False

    def handle_data(self, data):
        if self._in_title:
            self.title += data
        elif not self.skip and data.strip():
            self.parts.append(data.strip())


def page_text(page):
    t = Text()
    try:
        t.feed(page)
    except Exception:
        pass
    return t.title.strip(), re.sub(r'\s+', ' ', ' '.join(t.parts))


def euro(s):
    """'1.299,00 €' / '1299,-' / '1.299 €' -> Cent, sonst None."""
    m = re.fullmatch(r'\s*(?:€\s*)?(\d{1,3}(?:[.\s]\d{3})*|\d+)(?:,(\d{2}|-{1,2}))?\s*(?:€|EUR)?\s*', s or '')
    if not m:
        return None
    cents = m.group(2) if m.group(2) and m.group(2)[0] != '-' else '00'
    return int(re.sub(r'[.\s]', '', m.group(1))) * 100 + int(cents)


def gemini(prompt, key):
    url = f'https://generativelanguage.googleapis.com/v1beta/models/{GEMINI_MODEL}:generateContent'
    body = {'contents': [{'parts': [{'text': prompt}]}],
            'generationConfig': {'temperature': 0, 'responseMimeType': 'application/json', 'maxOutputTokens': 400,
                                 'thinkingConfig': {'thinkingBudget': 0}}}
    req = urllib.request.Request(url, data=json.dumps(body).encode(), method='POST',
                                 headers={'Content-Type': 'application/json', 'x-goog-api-key': key})
    with urllib.request.urlopen(req, timeout=60) as r:
        data = json.load(r)
    return json.loads(data['candidates'][0]['content']['parts'][0]['text'])


def ki_read(page, w, url, now, key):
    title, text = page_text(page)
    hay = norm(title + ' ' + text)
    if w['variant'] not in hay and not (w.get('model') and norm(w['model']) in hay):
        return [], 'Produkt nicht auf der Seite'
    i = max(text.find(w['variant']), text.lower().find((w.get('model') or '\0').lower()), 0)
    excerpt = text[max(0, i - 2500): i + 3500]
    prompt = (
        'Du liest eine deutsche Händler-Produktseite. Gesucht ist genau dieses Produkt:\n'
        f"Name: {w['name']}\nEAN/GTIN: {w['variant']}\nModellnummer: {w.get('model') or 'unbekannt'}\n\n"
        'Antworte nur mit JSON: {"passt": bool, "preis": string|null, "versand": string|null, '
        '"lieferbar": bool|null, "neuware": bool|null, "haendler": string|null}.\n'
        '"passt" nur true, wenn die Seite genau dieses Modell verkauft (kein Zubehör, keine andere Variante). '
        '"preis" ist der aktuelle Kaufpreis genau so geschrieben, wie er im Text steht (z. B. "1.299,00 €"). '
        '"versand" genau so wie im Text, "kostenlos" oder null wenn nicht genannt. Nichts erfinden.\n\n'
        f'Seitentitel: {title}\nSeitentext:\n{excerpt}')
    r = gemini(prompt, key)
    if not r.get('passt') or not r.get('preis') or r.get('neuware') is False or r.get('lieferbar') is None:
        return [], 'KI: kein passendes Angebot'
    if r['preis'] not in excerpt:
        return [], 'KI-Preis steht nicht wörtlich im Text, verworfen'
    cents = euro(r['preis'])
    if not cents:
        return [], 'KI-Preis nicht lesbar'
    v = (r.get('versand') or '').strip()
    if v.lower() in ('kostenlos', 'gratis', 'versandkostenfrei', '0,00 €'):
        ship, unknown = 0, False
    elif v and v in excerpt and euro(v) is not None:
        ship, unknown = euro(v), False
    else:
        ship, unknown = None, True
    merchant = (r.get('haendler') or '').strip()[:200] or base_domain(host(url))
    return [{'watch': w['id'], 'variant': w['variant'], 'source': 'ki', 'merchant': merchant, 'observed': now,
             'price_cents': cents, 'shipping_cents': ship, 'shipping_unknown': unknown, 'currency': 'EUR',
             'condition': 'new', 'available': bool(r['lieferbar']), 'url': url}], None


# ---------- Ablauf ----------

def read_page(url, w, now, key):
    if not allowed(url):
        return [], 'robots.txt erlaubt den Abruf nicht'
    final, page = fetch(url)
    if base_domain(host(final)) != base_domain(host(url)):
        return [], 'leitet auf andere Seite um'
    rows = structured(page, w, final, now) or meta_price(page, w, final, now)
    if rows:
        return rows, None
    if not key:
        return [], 'keine Produktdaten (KI-Schlüssel fehlt)'
    return ki_read(page, w, final, now, key)


def plausible(rows):
    """Zubehör/Fehltreffer aussortieren: KI-Preise weit weg vom Median der strukturierten Preise fliegen raus."""
    base = [r['price_cents'] for r in rows if r['source'] == 'web'] or [r['price_cents'] for r in rows]
    if len(base) < 2:
        return rows
    med = statistics.median(base)
    return [r for r in rows if 0.5 * med <= r['price_cents'] <= 2 * med or (r['source'] == 'web' and len(base) < 3)]


def collect(w, now, key, status):
    urls = candidates(w, status)
    log(f"{w['id']}: {len(urls)} Seiten")
    def one(u):
        try:
            rows, why = read_page(u, w, now, key)
        except Exception as e:
            rows, why = [], f'{type(e).__name__}'
        return u, rows, why
    found = []
    with ThreadPoolExecutor(4) as ex:
        for u, rows, why in ex.map(one, urls):
            status.append({'watch': w['id'], 'source': host(u), 'url': u, 'ok': bool(rows), **({'error': why} if why else {}),
                           **({'found': rows[0]['price_cents'], 'via': rows[0]['source']} if rows else {})})
            log(' ', 'OK ' if rows else '-- ', u[:100], rows[0]['price_cents'] / 100 if rows else why)
            found += rows
    return plausible(found)


def load(path, fallback):
    try:
        return json.loads(Path(path).read_text(encoding='utf-8'))
    except (OSError, ValueError):
        return fallback


def telegram(text):
    token, chat = os.environ.get('TELEGRAM_BOT_TOKEN'), os.environ.get('TELEGRAM_CHAT_ID')
    if not token or not chat:
        return
    data = urllib.parse.urlencode({'chat_id': chat, 'text': text, 'disable_web_page_preview': 'true'}).encode()
    try:
        urllib.request.urlopen(f'https://api.telegram.org/bot{token}/sendMessage', data, timeout=20).read()
    except Exception as e:
        log('Telegram fehlgeschlagen:', type(e).__name__)


def run(write=True, now=None):
    now = int(time.time()) if now is None else now
    config = load(CONFIG, {'products': []})
    history = load(HISTORY, {})
    key = os.environ.get('GEMINI_API_KEY', '')
    with tempfile.TemporaryDirectory() as d:
        store = Store(Path(d) / 'deals.db')
        for w in config['products']:
            store.save({k: v for k, v in w.items() if k not in ('sources', 'shops')} | {'sources': w.get('sources', {}), 'shops': w.get('shops', [])})
        store.restore(history)
        before = max((a['id'] for a in history.get('alerts', [])), default=0)
        status, rows = [], []
        for w in config['products']:
            if w.get('enabled', True):
                # Ohne EAN dient die Modellnummer als Kennung (z. B. aus "Zu Deals hinzufügen")
                if not w['variant'].isdigit() and not w.get('model'):
                    w = {**w, 'model': w['variant']}
                rows += collect(w, now, key, status)
        if rows:
            try:
                store.ingest(rows, now=now)
            except ValueError as e:  # einzelne fehlerhafte Zeile darf den Lauf nicht kippen
                log('Sammel-Import abgelehnt, einzeln:', e)
                for r in rows:
                    try:
                        store.ingest([r], now=now)
                    except ValueError as e2:
                        log('  verworfen:', r['url'][:80], e2)
        active = {w['id'] for w in config['products']}
        snap = store.dashboard(now)
        snap['products'] = [p for p in snap['products'] if p['id'] in active]
        snap['sources_status'] = status
        snap['method'] = 'Suche + Händlerseiten' + (' + KI' if key else '')
        dump = store.dump()
    fresh = [a for a in dump['alerts'] if a['id'] > before]
    for a in fresh:
        log('ALARM:', a['text'].replace('\n', ' | '))
    if write:
        SNAPSHOT.write_text(json.dumps(snap, ensure_ascii=False, indent=1) + '\n', encoding='utf-8')
        HISTORY.write_text(json.dumps(dump, ensure_ascii=False, separators=(',', ':')) + '\n', encoding='utf-8')
        for a in fresh:
            telegram(a['text'])
    best = {p['id']: p['current'] for p in snap['products']}
    for pid, cur in best.items():
        log(f"Bestpreis {pid}:", f"{cur['cents'] / 100:.2f} € bei {cur['merchant']} ({cur['source']})" if cur else 'keiner gefunden')
    return snap


if __name__ == '__main__':
    run(write='--dry-run' not in sys.argv)
