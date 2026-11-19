"""Place in SK-KI-OS app/deals.py. Reads worker feed; respects existing Melder policy."""
import json
import os
import time
from pathlib import Path
from . import daten, melder


def aktiv():
    return bool(os.environ.get('DEALS_FEED_PATH'))


def abholen():
    now = int(time.time())
    try:
        feed = json.loads(Path(os.environ['DEALS_FEED_PATH']).read_text())
        events = feed['events'] if now - feed['at'] <= 2 * 3600 else []
    except (OSError, ValueError, KeyError):
        events = []
    keys = {f"deals:{e['id']}" for e in events if e['created'] + 6 * 3600 >= now}
    for old in daten.db.kv('deals_pending_keys', []) or []:
        if old not in keys:
            melder.zurueckziehen(old)
    daten.db.kv_setzen('deals_pending_keys', sorted(keys))
    for e in events:
        key = f"deals:{e['id']}"
        # No silent first-run suppression: feed contains recent, actionable alerts only.
        if e['created'] + 6 * 3600 < now or daten.db.kv(key):
            continue
        melder.melde('deals', key, e['text'], stufe='sofort', zustellen_jetzt=False)
        daten.db.kv_setzen(key, True)
