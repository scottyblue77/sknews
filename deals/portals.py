"""Conservative public JSON-LD adapter. Incomplete data => no observation, visible error.

Official partner APIs need account-specific adapters. This module is not such an API.
"""
import json
import urllib.request
import urllib.robotparser
from html.parser import HTMLParser
from urllib.parse import urlsplit

HOSTS = {'idealo': {'www.idealo.de', 'idealo.de'},
         'geizhals': {'geizhals.de', 'www.geizhals.de'},
         'billiger': {'www.billiger.de', 'billiger.de'},
         'guenstiger': {'www.guenstiger.de', 'guenstiger.de'}}
UA = 'SKNews-Deals/1.0'


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise ValueError('Weiterleitung: kanonische Produkt-URL hinterlegen')


def get(url, source):
    p = urlsplit(url)
    if p.scheme != 'https' or p.hostname not in HOSTS[source] or p.port not in (None, 443) or p.username:
        raise ValueError('Nur HTTPS-Produkt-URLs des ausgewählten Portals erlaubt')
    opener = urllib.request.build_opener(NoRedirect())
    def read(u):
        with opener.open(urllib.request.Request(u, headers={'User-Agent': UA}), timeout=20) as r:
            raw = r.read(2_000_001)
            if len(raw) > 2_000_000:
                raise ValueError('Antwort zu groß')
            return raw.decode('utf-8')
    # No permissive fallback on errors, no CAPTCHA bypass.
    rp = urllib.robotparser.RobotFileParser()
    rp.parse(read(f'https://{p.netloc}/robots.txt').splitlines())
    if not rp.can_fetch(UA, url):
        raise ValueError('robots.txt erlaubt diesen Abruf nicht')
    return read(url)


class Scripts(HTMLParser):
    def __init__(self):
        super().__init__()
        self.active = False
        self.parts = []
        self.documents = []

    def handle_starttag(self, tag, attrs):
        if tag == 'script' and dict(attrs).get('type', '').lower() == 'application/ld+json':
            self.active, self.parts = True, []

    def handle_data(self, data):
        if self.active:
            self.parts.append(data)

    def handle_endtag(self, tag):
        if tag == 'script' and self.active:
            self.active = False
            try:
                self.documents.append(json.loads(''.join(self.parts)))
            except ValueError:
                pass


def nodes(value):
    if isinstance(value, list):
        for v in value:
            yield from nodes(v)
    elif isinstance(value, dict):
        yield value
        for v in value.values():
            if isinstance(v, (dict, list)):
                yield from nodes(v)


def money(value):
    from decimal import Decimal
    x = Decimal(str(value)) * 100
    if not x.is_finite() or x != x.to_integral_value() or x < 0:
        raise ValueError('Ungültiger Geldbetrag')
    return int(x)


def extract(html, w, source, page_url, now):
    parser = Scripts()
    parser.feed(html)
    result = []
    for product in nodes(parser.documents):
        types = product.get('@type', [])
        types = [types] if isinstance(types, str) else types
        if 'Product' not in types:
            continue
        identities = {str(product[k]) for k in ('gtin', 'gtin8', 'gtin12', 'gtin13', 'gtin14') if k in product}
        if w['variant'] not in identities:
            continue
        offers = product.get('offers', [])
        offers = [offers] if isinstance(offers, dict) else offers
        for o in offers:
            # Aggregate lowPrice is insufficient: shipping, stock and merchant unknown.
            if o.get('@type') != 'Offer' or o.get('priceCurrency') != 'EUR':
                continue
            seller = o.get('seller') or {}
            shipping = o.get('shippingDetails') or {}
            if isinstance(shipping, list):
                shipping = next((x for x in shipping if (x.get('shippingDestination') or {}).get('addressCountry') == 'DE'), {})
            if (shipping.get('shippingDestination') or {}).get('addressCountry') != 'DE':
                continue
            rate = shipping.get('shippingRate') or {}
            if not seller.get('name') or rate.get('currency') != 'EUR' or 'value' not in rate:
                continue
            if o.get('itemCondition') != 'https://schema.org/NewCondition':
                continue
            if o.get('availability') not in ('https://schema.org/InStock', 'https://schema.org/OutOfStock'):
                continue
            result.append({'watch': w['id'], 'variant': w['variant'], 'source': source,
                           'merchant': seller['name'], 'observed': now, 'price_cents': money(o['price']),
                           'shipping_cents': money(rate['value']), 'currency': 'EUR', 'condition': 'new',
                           'available': o['availability'].endswith('/InStock'), 'url': o.get('url') or page_url})
    if not result:
        raise ValueError('Keine vollständig passenden Angebote mit GTIN, Neuware und DE-Versand gefunden; Partner-API/Adapter nötig')
    return result
