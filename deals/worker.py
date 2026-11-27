"""NAS worker: GitHub watchlist -> portal adapters -> SQLite -> dashboard snapshot/feed.

Never sends Telegram itself, never commits credentials. Publication is opt-in.
"""
import base64
import json
import os
import time
import urllib.error
import urllib.request
from contextlib import closing
from pathlib import Path

from deals import Store
import portals


def request(url, data=None, token=''):
    headers = {'User-Agent': 'SKNews-Deals/1.0', 'Accept': 'application/vnd.github+json'}
    if token:
        headers['Authorization'] = 'Bearer ' + token
    if data is not None:
        headers['Content-Type'] = 'application/json'
    req = urllib.request.Request(url, data=json.dumps(data).encode() if data is not None else None,
                                 headers=headers, method='PUT' if data is not None else 'GET')
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)


def atomic(path, value):
    path = Path(path)
    tmp = path.with_suffix('.tmp')
    tmp.write_text(json.dumps(value, ensure_ascii=False), encoding='utf-8')
    os.chmod(tmp, 0o600)
    tmp.replace(path)


def cycle(store, folder):
    now = int(time.time())
    repo = os.environ.get('GITHUB_REPO', 'scottyblue77/sknews')
    api = f'https://api.github.com/repos/{repo}/contents/'
    token = os.environ.get('DEALS_GITHUB_TOKEN', '')
    config = request(api + 'config/deals.json', token=token)
    config = json.loads(base64.b64decode(config['content']))
    active = set()
    statuses = []
    collected = []
    for w in config['products']:
        store.save(w)
        active.add(w['id'])
        if not w.get('enabled', True):
            continue
        for source, page in w.get('sources', {}).items():
            if source not in portals.HOSTS:
                raise ValueError('Unbekanntes Portal')
            try:
                offers = portals.extract(portals.get(page, source), w, source, page, now)
                collected.extend(offers)
                statuses.append({'watch': w['id'], 'source': source, 'ok': True, 'at': now})
            except Exception as e:
                # Only controlled class name + explicit data issue; never emit auth/HTTP bodies.
                message = str(e) if isinstance(e, ValueError) else type(e).__name__
                statuses.append({'watch': w['id'], 'source': source, 'ok': False, 'at': now, 'error': message})
    # Evaluate once, after all portals, so an early expensive offer cannot hide a later better one.
    if collected:
        store.ingest(collected, now=now)
    # Remove from active watchlist without destroying historical records.
    with closing(store.connect()) as c:
        previous_watches = [json.loads(r[0]) for r in c.execute('SELECT config FROM watches')]
    for w in previous_watches:
        if w['id'] not in active:
            store.save({**w, 'enabled': False})
    snapshot = store.dashboard(now)
    snapshot['products'] = [w for w in snapshot['products'] if w['id'] in active]
    snapshot['sources_status'] = statuses
    atomic(folder / 'dashboard.json', snapshot)
    # Shared local feed, no listening port; adapter in active SK-bot reads it.
    with closing(store.connect()) as c:
        rows = [dict(r) for r in c.execute('SELECT * FROM alerts WHERE created>=? ORDER BY id', (now - 6 * 3600,))]
    current = {w['id']: w['current'] for w in snapshot['products'] if w['enabled']}
    rows = [r for r in rows if current.get(r['watch']) and current[r['watch']]['cents'] <= r['cents']]
    atomic(folder / 'feed.json', {'events': rows, 'at': now})
    if os.environ.get('DEALS_PUBLISH') == 'true':
        # Watchlist + price history are public in this repository. Explicit opt-in.
        path = api + 'docs/data/deals.json'
        try:
            previous = request(path, token=token)
        except urllib.error.HTTPError as e:
            if e.code != 404:
                raise
            previous = {}
        data = {'message': 'Deals-Daten aktualisiert', 'branch': 'main',
                'content': base64.b64encode(json.dumps(snapshot, ensure_ascii=False).encode()).decode()}
        if previous.get('sha'):
            data['sha'] = previous['sha']
        request(path, data, token)


if __name__ == '__main__':
    folder = Path(os.environ.get('DEALS_DATA', '/data'))
    folder.mkdir(parents=True, exist_ok=True)
    store = Store(folder / 'deals.db')
    while True:
        try:
            cycle(store, folder)
            atomic(folder / 'health.json', {'ok': True, 'at': int(time.time())})
        except Exception as e:
            atomic(folder / 'health.json', {'ok': False, 'at': int(time.time()), 'error': type(e).__name__})
        time.sleep(max(900, int(os.environ.get('DEALS_INTERVAL_SECONDS', '1800'))))
