"""Import canonical JSON observations from approved partner-feed exports.

Historical imports intentionally do not create push events.
"""
import argparse
import json
from deals import Store

if __name__ == '__main__':
    p = argparse.ArgumentParser()
    p.add_argument('--db', required=True)
    p.add_argument('--file', required=True)
    p.add_argument('--historical', action='store_true')
    a = p.parse_args()
    with open(a.file, encoding='utf-8') as f:
        rows = json.load(f)
    print(Store(a.db).ingest(rows, historical=a.historical), 'Produkte aktualisiert')
