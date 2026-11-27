import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from deals import Store
import worker


class IntegrationTest(unittest.TestCase):
    def test_worker_config_to_snapshot_and_feed_without_network(self):
        import base64
        with tempfile.TemporaryDirectory() as d:
            folder=Path(d)
            s=Store(folder/'deals.db')
            w={'id':'monitor','name':'Samsung','variant':'1234567890123','target_cents':10000,
               'sources':{'idealo':'https://www.idealo.de/product'}}
            cfg={'content':base64.b64encode(json.dumps({'products':[w]}).encode()).decode()}
            offer={'watch':'monitor','variant':w['variant'],'source':'idealo','merchant':'Shop',
                   'price_cents':9000,'shipping_cents':0,'observed':100000,'currency':'EUR',
                   'condition':'new','available':True,'url':'https://example.com/monitor'}
            with patch.object(worker,'request',return_value=cfg), patch.object(worker.time,'time',return_value=100000), \
                 patch.object(worker.portals,'get',return_value='fixture'), \
                 patch.object(worker.portals,'extract',return_value=[offer]), patch.dict(os.environ,{'DEALS_PUBLISH':'false'}):
                worker.cycle(s,folder)
            dashboard=json.loads((folder/'dashboard.json').read_text())
            feed=json.loads((folder/'feed.json').read_text())
            self.assertEqual(dashboard['products'][0]['current']['cents'],9000)
            self.assertEqual(len(feed['events']),1)
            self.assertTrue(dashboard['sources_status'][0]['ok'])

    def test_active_bot_melder_dedup_and_expiry(self):
        with tempfile.TemporaryDirectory() as d:
            f=Path(d)/'feed.json'
            f.write_text(json.dumps({'at':10000,'events':[{'id':1,'created':10000,'text':'Deal'}]}))
            kv={}
            db=types.SimpleNamespace(kv=lambda k,default=None:kv.get(k,default),kv_setzen=lambda k,v:kv.__setitem__(k,v))
            melder=types.SimpleNamespace(melde=Mock(),zurueckziehen=Mock())
            package=types.ModuleType('fixturebot')
            package.daten=types.SimpleNamespace(db=db)
            package.melder=melder
            spec=importlib.util.spec_from_file_location('fixturebot.deals',Path(__file__).resolve().parents[1]/'integration/skbot_deals.py')
            module=importlib.util.module_from_spec(spec)
            with patch.dict(sys.modules,{'fixturebot':package}),patch.dict(os.environ,{'DEALS_FEED_PATH':str(f)}):
                spec.loader.exec_module(module)
                with patch.object(module.time,'time',return_value=10001):
                    module.abholen(); module.abholen()
                melder.melde.assert_called_once_with('deals','deals:1','Deal',stufe='sofort',zustellen_jetzt=False)
                with patch.object(module.time,'time',return_value=20000):
                    module.abholen()
                melder.zurueckziehen.assert_called_once_with('deals:1')


if __name__=='__main__':
    unittest.main()
