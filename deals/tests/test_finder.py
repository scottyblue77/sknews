import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import finder
from deals import Store, DAY

NOW = 20000 * DAY + 3600
W = {'id': 'g9', 'name': 'Samsung G9 57', 'variant': '8806094972313', 'model': 'LS57CG954NUXEN',
     'target_cents': None, 'drop_percent': None, 'new_low': True, 'min_days': 7}


def ld(product):
    return '<html><script type="application/ld+json">' + json.dumps(product) + '</script></html>'


def product(**kw):
    p = {'@type': 'Product', 'name': 'Samsung Odyssey Neo G9', 'gtin13': '8806094972313',
         'offers': {'@type': 'Offer', 'price': '1599.00', 'priceCurrency': 'EUR',
                    'availability': 'https://schema.org/InStock'}}
    p.update(kw)
    return p


class StructuredTest(unittest.TestCase):
    def test_gtin_match_and_unknown_shipping(self):
        rows = finder.structured(ld(product()), W, 'https://www.shop.de/p/1', NOW)
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]['price_cents'], 159900)
        self.assertTrue(rows[0]['shipping_unknown'])
        self.assertEqual(rows[0]['merchant'], 'shop.de')

    def test_other_variant_rejected_even_if_name_matches(self):
        p = product(gtin13='8806094972320', name='Samsung LS57CG954NUXEN')
        self.assertEqual(finder.structured(ld(p), W, 'https://www.shop.de/p/1', NOW), [])

    def test_model_number_without_gtin(self):
        p = product(mpn='LS57CG954NUXEN')
        del p['gtin13']
        self.assertEqual(len(finder.structured(ld(p), W, 'https://www.shop.de/p/1', NOW)), 1)
        p['mpn'] = 'LS57CG952NUXEN'
        p['name'] = 'Samsung Odyssey'
        self.assertEqual(finder.structured(ld(p), W, 'https://www.shop.de/p/1', NOW), [])

    def test_shipping_used_condition_and_aggregate(self):
        o = {'@type': 'Offer', 'price': 1599, 'priceCurrency': 'EUR', 'availability': 'https://schema.org/InStock',
             'shippingDetails': {'shippingDestination': {'addressCountry': 'DE'},
                                 'shippingRate': {'value': '0', 'currency': 'EUR'}}}
        rows = finder.structured(ld(product(offers=o)), W, 'https://www.shop.de/p/1', NOW)
        self.assertFalse(rows[0]['shipping_unknown'])
        self.assertEqual(rows[0]['shipping_cents'], 0)
        used = dict(o, itemCondition='https://schema.org/UsedCondition')
        self.assertEqual(finder.structured(ld(product(offers=used)), W, 'https://www.shop.de/p/1', NOW), [])
        agg = {'@type': 'AggregateOffer', 'lowPrice': 1000, 'priceCurrency': 'EUR'}
        self.assertEqual(finder.structured(ld(product(offers=agg)), W, 'https://www.shop.de/p/1', NOW), [])

    def test_euro_parsing(self):
        self.assertEqual(finder.euro('1.299,00 €'), 129900)
        self.assertEqual(finder.euro('1299,-'), 129900)
        self.assertEqual(finder.euro('€ 999'), 99900)
        self.assertIsNone(finder.euro('ab 999 € mtl.'))


class KiTest(unittest.TestCase):
    PAGE = ('<html><title>Samsung LS57CG954NUXEN</title><body><p>Samsung Odyssey Neo G9 LS57CG954NUXEN</p>'
            '<p>Jetzt nur 1.549,00 €</p><p>Versand kostenlos</p></body></html>')

    def test_verbatim_price_accepted(self):
        answer = {'passt': True, 'preis': '1.549,00 €', 'versand': 'kostenlos', 'lieferbar': True, 'neuware': True,
                  'haendler': 'Shop'}
        with patch.object(finder, 'gemini', return_value=answer):
            rows, why = finder.ki_read(self.PAGE, W, 'https://www.shop.de/p', NOW, 'key')
        self.assertIsNone(why)
        self.assertEqual((rows[0]['price_cents'], rows[0]['shipping_cents'], rows[0]['source']), (154900, 0, 'ki'))

    def test_invented_price_rejected(self):
        answer = {'passt': True, 'preis': '1.199,00 €', 'versand': None, 'lieferbar': True, 'neuware': True}
        with patch.object(finder, 'gemini', return_value=answer):
            rows, why = finder.ki_read(self.PAGE, W, 'https://www.shop.de/p', NOW, 'key')
        self.assertEqual(rows, [])
        self.assertIn('wörtlich', why)

    def test_page_without_product_never_asks_ki(self):
        with patch.object(finder, 'gemini') as g:
            rows, _ = finder.ki_read('<p>Anderer Monitor 999 €</p>', W, 'https://www.shop.de/p', NOW, 'key')
        g.assert_not_called()
        self.assertEqual(rows, [])

    def test_plausibility_drops_accessory_price(self):
        rows = [{'source': 'web', 'price_cents': 159900}, {'source': 'web', 'price_cents': 162000},
                {'source': 'web', 'price_cents': 158000}, {'source': 'ki', 'price_cents': 2999}]
        self.assertEqual(len(finder.plausible(rows)), 3)


class RunTest(unittest.TestCase):
    def test_run_keeps_history_and_writes_snapshot(self):
        with tempfile.TemporaryDirectory() as d:
            d = Path(d)
            cfg, snap, hist = d / 'c.json', d / 's.json', d / 'h.json'
            cfg.write_text(json.dumps({'products': [W]}))
            page = ld(product())
            with patch.multiple(finder, CONFIG=cfg, SNAPSHOT=snap, HISTORY=hist), \
                 patch.object(finder, 'candidates', return_value=['https://www.shop.de/p/1']), \
                 patch.object(finder, 'allowed', return_value=True), \
                 patch.object(finder, 'fetch', return_value=('https://www.shop.de/p/1', page)), \
                 patch.dict('os.environ', {'GEMINI_API_KEY': ''}):
                for day in range(9):
                    finder.run(now=NOW + day * DAY)
                cheaper = ld(product(offers={'@type': 'Offer', 'price': '1399.00', 'priceCurrency': 'EUR',
                                             'availability': 'https://schema.org/InStock'}))
                with patch.object(finder, 'fetch', return_value=('https://www.shop.de/p/1', cheaper)):
                    s = finder.run(now=NOW + 9 * DAY)
            h = json.loads(hist.read_text())
            self.assertEqual(len(h['offers']), 10)
            self.assertEqual(len(h['alerts']), 1)
            self.assertIn('Versand nicht angegeben', h['alerts'][0]['text'])
            self.assertEqual(s['products'][0]['current']['cents'], 139900)
            self.assertEqual(json.loads(snap.read_text())['products'][0]['history_days'], 10)


if __name__ == '__main__':
    unittest.main()
