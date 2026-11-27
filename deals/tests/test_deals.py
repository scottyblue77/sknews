import json
import tempfile
import unittest
from pathlib import Path
import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from deals import Store, DAY
from portals import extract

NOW = 20000 * DAY + 3600


class DealsTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.s = Store(Path(self.tmp.name) / 'prices.db')
        self.w = self.s.save({'id': 'camera', 'name': 'Camera', 'variant': '1234567890123',
                             'target_cents': 8000, 'drop_percent': 15, 'new_low': True})

    def tearDown(self):
        self.tmp.cleanup()

    def offer(self, price=10000, shipping=0, observed=NOW, **kw):
        return {'watch':'camera', 'variant':self.w['variant'], 'source':'idealo', 'merchant':'Shop',
                'price_cents':price, 'shipping_cents':shipping, 'observed':observed,
                'currency':'EUR', 'condition':'new', 'available':True, 'url':'https://example.com/product', **kw}

    def alerts(self):
        return self.s.feed()['ereignisse']

    def test_checkout_shipping_prevents_fake_target(self):
        self.s.ingest([self.offer(7900, 600)], now=NOW)
        self.assertFalse(self.alerts())
        self.assertEqual(self.s.dashboard(NOW)['products'][0]['current']['cents'],8500)

    def test_history_baseline_and_new_low(self):
        self.w.update(target_cents=None, mode='all')
        self.s.save(self.w)
        self.s.ingest([self.offer(observed=NOW-d*DAY) for d in range(1,31)], now=NOW, historical=True)
        self.assertFalse(self.alerts())
        self.s.ingest([self.offer(8000)], now=NOW)
        self.assertEqual(len(self.alerts()),1)
        self.assertIn('20.0 %',self.alerts()[0]['text'])

    def test_frequency_does_not_inflate_history(self):
        self.s.ingest([self.offer(observed=NOW-n*60) for n in range(100)], now=NOW)
        self.s.ingest([self.offer(8500,observed=NOW+1)], now=NOW+1)
        self.assertFalse(self.alerts())

    def test_dedup_restart_cooldown_and_lower_price(self):
        self.s.ingest([self.offer(7900)], now=NOW)
        self.s = Store(self.s.path)
        self.s.ingest([self.offer(7900,observed=NOW+25*3600)], now=NOW+25*3600)
        self.assertEqual(len(self.alerts()),1)
        self.s.ingest([self.offer(7500,observed=NOW+26*3600)], now=NOW+26*3600)
        self.assertEqual(len(self.alerts()),2)

    def test_reject_variant_future_unknown_shipping_and_noninteger(self):
        for override in ({'variant':'other'},{'observed':NOW+120},{'shipping_cents':None},
                         {'price_cents':79.9},{'price_cents':True},{'condition':'used'}):
            with self.subTest(override=override), self.assertRaises(ValueError):
                self.s.ingest([{**self.offer(),**override}],now=NOW)

    def test_stale_stock_and_currency(self):
        self.s.ingest([self.offer(7900,available=False)],now=NOW)
        self.assertFalse(self.alerts())
        with self.assertRaises(ValueError):
            self.s.ingest([self.offer(currency='USD')],now=NOW)
        self.s.ingest([self.offer(7900,observed=NOW-7*3600)],now=NOW,historical=True)
        self.assertIsNone(self.s.dashboard(NOW)['products'][0]['current'])

    def test_batch_rollback_and_identity_immutable(self):
        with self.assertRaises(ValueError):
            self.s.ingest([self.offer(7900),self.offer(variant='wrong')],now=NOW)
        self.assertFalse(self.s.dashboard(NOW)['products'][0]['history'])
        with self.assertRaises(ValueError):
            self.s.save({**self.w,'variant':'different'})

    def test_portal_structured_data_and_missing_fields(self):
        offer = {'@type':'Offer','price':'79.99','priceCurrency':'EUR',
                 'availability':'https://schema.org/InStock','itemCondition':'https://schema.org/NewCondition',
                 'seller':{'name':'Shop'},'shippingDetails':{'shippingDestination':{'addressCountry':'DE'},
                 'shippingRate':{'currency':'EUR','value':'4.99'}}}
        def html(o):
            return '<script type="application/ld+json">'+json.dumps({'@type':'Product','gtin13':self.w['variant'],'offers':o})+'</script>'
        rows = extract(html(offer), self.w, 'billiger', 'https://www.billiger.de/product', NOW)
        self.s.ingest(rows,now=NOW)
        self.assertEqual(self.s.dashboard(NOW)['products'][0]['current']['cents'],8498)
        for patch in ({'shippingDetails':{}},{'@type':'AggregateOffer'},{'itemCondition':None}):
            with self.assertRaises(ValueError):
                extract(html({**offer,**patch}),self.w,'billiger','https://www.billiger.de/product',NOW)


if __name__ == '__main__':
    unittest.main()
