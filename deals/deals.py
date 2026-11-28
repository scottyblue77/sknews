"""SKNews Deals core. Integer cents; explicit identity; no inferred shipping or prices."""
import json
import sqlite3
import statistics
import time
from contextlib import closing
from urllib.parse import urlsplit

DAY = 86400
# 'web' = Händlerseite mit strukturierten Produktdaten, 'ki' = von der KI aus dem Seitentext gelesen
PORTALS = {'idealo', 'geizhals', 'billiger', 'guenstiger', 'manual', 'web', 'ki'}


def integer(v, low, high):
    if type(v) is not int or not low <= v <= high:
        raise ValueError(f'Ganze Zahl zwischen {low} und {high} erforderlich')
    return v


def url(v):
    p = urlsplit(v)
    if p.scheme not in ('https', 'http') or not p.hostname or p.username or p.password:
        raise ValueError('Ungültige Angebots-URL')
    return v


class Store:
    def __init__(self, path):
        self.path = str(path)
        with closing(self.connect()) as c:
            c.executescript('''
            PRAGMA journal_mode=WAL;
            CREATE TABLE IF NOT EXISTS watches (
              id TEXT PRIMARY KEY, config TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS offers (
              watch TEXT NOT NULL REFERENCES watches(id), source TEXT NOT NULL,
              merchant TEXT NOT NULL, observed INTEGER NOT NULL, cents INTEGER NOT NULL,
              available INTEGER NOT NULL, url TEXT NOT NULL, campaign TEXT NOT NULL,
              shipping_known INTEGER NOT NULL DEFAULT 1,
              PRIMARY KEY(watch,source,merchant,observed));
            CREATE INDEX IF NOT EXISTS offer_time ON offers(watch,observed);
            CREATE TABLE IF NOT EXISTS alerts (
              id INTEGER PRIMARY KEY AUTOINCREMENT, watch TEXT NOT NULL,
              created INTEGER NOT NULL, cents INTEGER NOT NULL, text TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS alert_state (
              watch TEXT PRIMARY KEY, last_at INTEGER NOT NULL, last_price INTEGER NOT NULL,
              armed INTEGER NOT NULL);
            ''')

    def connect(self):
        c = sqlite3.connect(self.path, timeout=20)
        c.row_factory = sqlite3.Row
        c.execute('PRAGMA foreign_keys=ON')
        return c

    def save(self, w):
        w = dict(w)
        if not isinstance(w.get('id'), str) or not w['id'] or len(w['id']) > 100:
            raise ValueError('Produkt-ID fehlt oder ist zu lang')
        for k in ('name', 'variant'):
            if not isinstance(w.get(k), str) or not 1 <= len(w[k]) <= 200:
                raise ValueError(f'{k} fehlt')
        if w.get('model') is not None and (not isinstance(w['model'], str) or not 4 <= len(w['model']) <= 60):
            raise ValueError('Modellnummer ungültig')
        w.setdefault('target_cents', None)
        w.setdefault('drop_percent', None)
        w.setdefault('new_low', False)
        w.setdefault('mode', 'any')
        w.setdefault('min_days', 30)
        w.setdefault('cooldown_hours', 24)
        w.setdefault('enabled', True)
        if w['target_cents'] is not None:
            integer(w['target_cents'], 1, 100000000)
        if w['drop_percent'] is not None:
            integer(w['drop_percent'], 1, 99)
        integer(w['min_days'], 7, 365)
        integer(w['cooldown_hours'], 1, 720)
        if w['mode'] not in ('all', 'any') or any(type(w[k]) is not bool for k in ('enabled', 'new_low')):
            raise ValueError('Ungültige Trigger-Konfiguration')
        with closing(self.connect()) as c, c:
            old = c.execute('SELECT config FROM watches WHERE id=?', (w['id'],)).fetchone()
            if old and json.loads(old[0])['variant'] != w['variant']:
                raise ValueError('Variante unveränderlich: neues Produkt anlegen, damit Historien getrennt bleiben')
            c.execute('INSERT INTO watches VALUES (?,?) ON CONFLICT(id) DO UPDATE SET config=excluded.config',
                      (w['id'], json.dumps(w)))
        return w

    def ingest(self, observations, now=None, historical=False):
        now = int(time.time()) if now is None else now
        if not isinstance(observations, list) or not 1 <= len(observations) <= 1000:
            raise ValueError('1–1000 Beobachtungen pro Import erforderlich')
        affected = set()
        with closing(self.connect()) as c, c:
            for o in observations:
                row = c.execute('SELECT config FROM watches WHERE id=?', (o['watch'],)).fetchone()
                if not row:
                    raise ValueError('Unbekanntes Produkt')
                w = json.loads(row[0])
                if o['variant'] != w['variant'] or o.get('currency') != 'EUR' or o.get('condition') != 'new':
                    raise ValueError('Variante, Währung oder Zustand passen nicht')
                if o['source'] not in PORTALS:
                    raise ValueError('Unbekannte Quelle')
                if not isinstance(o['merchant'], str) or not 1 <= len(o['merchant']) <= 200:
                    raise ValueError('Händler fehlt')
                if type(o['available']) is not bool:
                    raise ValueError('Verfügbarkeit muss explizit sein')
                observed = integer(o['observed'], 0, now + 60)
                if not historical and observed < now - 6 * 3600:
                    raise ValueError('Veraltete Daten nur als historischen Import übernehmen')
                # Adapter supplies final, unconditional checkout item price, incl. VAT.
                # Shipping is mandatory, never silently assumed zero. Only an explicit
                # shipping_unknown=True (price page without shipping data) stores the item price
                # with a visible marker instead.
                price = integer(o['price_cents'], 1, 100000000)
                unknown = o.get('shipping_unknown', False)
                if type(unknown) is not bool:
                    raise ValueError('shipping_unknown muss explizit sein')
                shipping = 0 if unknown and o['shipping_cents'] is None else integer(o['shipping_cents'], 0, 10000000)
                campaign = str(o.get('campaign', ''))[:100]
                c.execute('INSERT OR IGNORE INTO offers(watch,source,merchant,observed,cents,available,url,campaign,'
                          'shipping_known) VALUES (?,?,?,?,?,?,?,?,?)',
                          (w['id'], o['source'], o['merchant'], observed, price + shipping,
                           int(o['available']), url(o['url']), campaign, int(not unknown)))
                if c.execute('SELECT changes()').fetchone()[0]:
                    affected.add(w['id'])
            if not historical:
                for wid in affected:
                    self.evaluate(c, wid, now)
        return len(affected)

    def summary(self, c, w, now):
        rows = [dict(r) for r in c.execute('SELECT * FROM offers WHERE watch=? AND observed<=? ORDER BY observed',
                                          (w['id'], now))]
        latest = {}
        for r in rows:
            latest[(r['source'], r['merchant'])] = r
        fresh = [r for r in latest.values() if r['available'] and r['observed'] >= now - 6 * 3600]
        current = min(fresh, key=lambda r: r['cents'], default=None)
        daily = {}
        for r in rows:
            if r['available']:
                day = r['observed'] // DAY
                daily[day] = min(daily.get(day, r['cents']), r['cents'])
        today = now // DAY
        baseline = [v for d, v in daily.items() if today - 30 <= d < today]
        median = statistics.median(baseline) if len(baseline) >= w['min_days'] else None
        prior = [v for d, v in daily.items() if d < today]
        history = [{'day': d * DAY, 'cents': v} for d, v in sorted(daily.items())]
        return {**w, 'current': current, 'history': history, 'history_days': len(daily),
                'baseline_days': len(baseline), 'median30': median,
                'drop_percent_actual': round(100 * (1 - current['cents'] / median), 2) if current and median else None,
                'prior_low': min(prior, default=None),
                'best': {str(n): min((v for d, v in daily.items() if d >= today - n + 1), default=None)
                         for n in (30, 90, 365)},
                'observed_low': min(daily.values(), default=None),
                'sources': list(latest.values()),
                # Jede Messung je Händler (letzte 400 Tage) für Verlauf und Trend auf der Seite
                'series': self.series(rows, now)}

    @staticmethod
    def series(rows, now):
        out = {}
        for r in rows:
            if r['available'] and r['observed'] >= now - 400 * DAY:
                out.setdefault(r['merchant'], []).append([r['observed'], r['cents']])
        return out

    def evaluate(self, c, wid, now):
        w = json.loads(c.execute('SELECT config FROM watches WHERE id=?', (wid,)).fetchone()[0])
        s = self.summary(c, w, now)
        cur = s['current']
        if not w['enabled'] or not cur:
            return
        price = cur['cents']
        checks, reasons = [], []
        if w['target_cents'] is not None:
            checks.append(price <= w['target_cents'])
            if checks[-1]:
                reasons.append('Zielpreis erreicht')
        if w['drop_percent'] is not None:
            checks.append(s['median30'] is not None and 100 * (1 - price / s['median30']) >= w['drop_percent'])
            if checks[-1]:
                reasons.append(f"{s['drop_percent_actual']} % unter 30-Tage-Median der Tagesbestpreise")
        if w['new_low']:
            checks.append(s['history_days'] - 1 >= w['min_days'] and s['prior_low'] is not None and price < s['prior_low'])
            if checks[-1]:
                reasons.append('Neuer beobachteter Bestpreis')
        match = bool(checks) and (all(checks) if w['mode'] == 'all' else any(checks))
        state = c.execute('SELECT * FROM alert_state WHERE watch=?', (wid,)).fetchone()
        if not match:
            if state and price >= state['last_price'] * 1.03:
                c.execute('UPDATE alert_state SET armed=1 WHERE watch=?', (wid,))
            return
        if state and (now - state['last_at'] < w['cooldown_hours'] * 3600 or
                      (not state['armed'] and price > state['last_price'] * 0.99)):
            return
        versand = 'inkl. Versand' if cur['shipping_known'] else 'Versand nicht angegeben'
        text = (f"🏷 {w['name']} · {w['variant']}\n{price / 100:.2f} € {versand} · {cur['merchant']}"
                f"\n{' · '.join(reasons)}\n{cur['url']}\nQuelle: {cur['source']}"
                + (f" · Aktion: {cur['campaign']}" if cur['campaign'] else ''))
        c.execute('INSERT INTO alerts(watch,created,cents,text) VALUES (?,?,?,?)', (wid, now, price, text))
        c.execute('INSERT INTO alert_state VALUES (?,?,?,0) ON CONFLICT(watch) DO UPDATE SET '
                  'last_at=excluded.last_at,last_price=excluded.last_price,armed=0', (wid, now, price))

    def dashboard(self, now=None):
        now = int(time.time()) if now is None else now
        with closing(self.connect()) as c:
            return {'updated': now, 'products': [self.summary(c, json.loads(r[0]), now)
                    for r in c.execute('SELECT config FROM watches ORDER BY id')]}

    def feed(self, after=0):
        with closing(self.connect()) as c:
            rows = [dict(r) for r in c.execute('SELECT * FROM alerts WHERE id>? ORDER BY id LIMIT 200', (after,))]
            return {'cursor': rows[-1]['id'] if rows else after, 'ereignisse': [
                {'id': r['id'], 'art': 'deal', 'titel': 'Preisbeobachtung', 'text': r['text'],
                 'created': r['created'], 'expires': r['created'] + 6 * 3600} for r in rows]}

    def dump(self):
        """Gesamter Stand als JSON-fähiges Dict, damit die Historie ohne NAS im Repo leben kann."""
        with closing(self.connect()) as c:
            return {'offers': [dict(r) for r in c.execute('SELECT * FROM offers ORDER BY watch,observed')],
                    'alerts': [dict(r) for r in c.execute('SELECT * FROM alerts ORDER BY id')],
                    'alert_state': [dict(r) for r in c.execute('SELECT * FROM alert_state ORDER BY watch')]}

    def restore(self, data):
        """Lädt einen mit dump() gesicherten Stand. Produkte müssen vorher per save() existieren."""
        known = set()
        with closing(self.connect()) as c, c:
            known = {r[0] for r in c.execute('SELECT id FROM watches')}
            for r in data.get('offers', []):
                if r['watch'] in known:
                    c.execute('INSERT OR IGNORE INTO offers(watch,source,merchant,observed,cents,available,url,'
                              'campaign,shipping_known) VALUES (?,?,?,?,?,?,?,?,?)',
                              (r['watch'], r['source'], r['merchant'], r['observed'], r['cents'], r['available'],
                               r['url'], r.get('campaign', ''), r.get('shipping_known', 1)))
            for r in data.get('alerts', []):
                c.execute('INSERT OR IGNORE INTO alerts(id,watch,created,cents,text) VALUES (?,?,?,?,?)',
                          (r['id'], r['watch'], r['created'], r['cents'], r['text']))
            for r in data.get('alert_state', []):
                c.execute('INSERT OR REPLACE INTO alert_state VALUES (?,?,?,?)',
                          (r['watch'], r['last_at'], r['last_price'], r['armed']))
