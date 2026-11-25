"""套餐队列离线验收：仅使用内存 ERP，写前直接检查磁盘 pendingStep。"""
import copy
import json
from pathlib import Path
import tempfile
import threading
import time
import unittest
from matching import MatchingService, MatchError, build_bom, decide
from operation_lock import OperationLock, OperationBusy


def snapshot(sku='100', **changes):
    return {'configId':'c'+sku,'name':'配置'+sku,'shopId':'76','spu':'900','sku':sku,'saved':True,
            'actualParts':[{'goodsId':'1','qty':1,'name':'CPU'}], 'extras':[], **changes}


class FakeGateway:
    concurrent_reads = True
    sku_package_search = True
    def __init__(self, root, skus=('100',)):
        self.root = Path(root)
        self.platform = [{'shopId':'76','spu':'900','sku':sku,'goodsId':None,'onSale':True,'name':'平台名'+sku} for sku in skus]
        self.products = {'1':{'goodsId':'1','name':'CPU','isPackage':False,'bom':{}}}
        self.calls, self.writes, self.fail, self.pause, self.at_step = [], [], None, None, threading.Event()

    def package(self, goods='90', name='76-100-AUTO', parts=None):
        self.products[goods] = {'goodsId':goods,'name':name,'isPackage':True,'bom':parts or {'1':1}}

    def read(self, operation, payload, timeout):
        self.calls.append((operation, copy.deepcopy(payload), timeout))
        if operation=='refresh_product':return {'complete':True}
        if operation=='platform_goods':
            rows=[r for r in self.platform if r['shopId']==payload['shopId'] and (r['spu']==payload['spu'] if 'spu' in payload else r['sku']==payload['sku'])]
            return {'rows':copy.deepcopy(rows),'total':len(rows)}
        if operation=='find_packages':
            query = payload.get('sku', payload.get('name'))
            rows=[{'goodsId':r['goodsId'],'name':r['name']} for r in self.products.values() if query in r['name']]
            return {'rows':rows,'total':len(rows)}
        product=self.products[payload['goodsId']]
        if operation=='product_info':return {k:v for k,v in product.items() if k!='bom'}
        if operation=='bom':return {'items':[{'goodsId':key,'qty':qty} for key,qty in product['bom'].items()]}
        raise AssertionError(operation)

    def write(self, operation, payload, timeout):
        self.writes.append((operation,copy.deepcopy(payload),timeout))
        receipts=[json.loads(path.read_text(encoding='utf-8')) for path in self.root.glob('job-*.json')]
        assert any(row.get('pendingStep',{}).get('operation')==operation for receipt in receipts for row in receipt['items'] if row.get('pendingStep'))
        if self.pause and operation==self.pause[0]:
            self.at_step.set();self.pause[1].wait(5)
        result={'confirmed':True}
        if operation=='get_code':result['code']='AUTO-TEST'
        if operation=='create_package':
            self.products['91']={'goodsId':'91','name':payload['name'],'isPackage':False,'bom':{}}
            result['goodsId']='91'
        if operation=='save_bom':self.products[payload['goodsId']]['bom']={r['goodsId']:r['qty'] for r in payload['items']}
        if operation=='set_bom_type':self.products[payload['goodsId']]['isPackage']=True
        if operation=='link_sku':
            for row in self.platform:
                if row['shopId']==payload['shopId'] and row['sku']==payload['sku']:row['goodsId']=payload['goodsId']
        if operation==self.fail:raise TimeoutError('mock unknown write')
        return result


class MatchingTests(unittest.TestCase):
    def fixture(self, skus=('100',), clock=time.time):
        temporary=tempfile.TemporaryDirectory();self.addCleanup(temporary.cleanup)
        gateway=FakeGateway(temporary.name,skus)
        service=MatchingService(gateway,temporary.name,'test-owner',clock)
        self.addCleanup(lambda:service.thread.join(6) if service.thread else None)
        return service,gateway

    def wait(self, service, phase=None):
        service.thread.join(6);self.assertFalse(service.thread.is_alive())
        job=service.status()['job']
        if phase:self.assertEqual(job['phase'],phase,job)
        return job

    def preview(self, service, items=None, mode='normal'):
        service.preview({'items':items or [snapshot()],'mode':mode})
        return self.wait(service,'preview')

    def execute(self, service, job, rematch=False):
        service.execute({'jobId':job['id'],'previewDigest':job['previewDigest'],'confirmRematch':rematch})
        return self.wait(service)

    def test_bom_merge_exclude_extras_and_single(self):
        self.assertEqual(build_bom([{'goodsId':'1','qty':2},{'special':True},{'name':'【写配置用/不会出货】X'}],
                                   [{'goodsId':'1','qty':3},{'goodsId':'2','qty':1}]),{'1':5,'2':1})
        self.assertEqual(build_bom([{'goodsId':'1','qty':1}],[]),{'1':1})
        for parts,extras in [([], [{'goodsId':'1','qty':1}]),([{'special':True}],[]),([{'goodsId':'1','qty':True}],[]),([{'goodsId':'1','qty':0}],[])]:
            with self.assertRaises(MatchError):build_bom(parts,extras)

    def test_decision_all_branches(self):
        expected={'1':1};matching={'goodsId':'90','isPackage':True,'bom':expected}
        different={**matching,'bom':{'1':2}}
        self.assertEqual(decide(expected,matching,[])['action'],'already')
        self.assertEqual(decide(expected,different,[])['action'],'conflict')
        update=decide(expected,different,[],True)
        self.assertEqual((update['action'],update['goodsId'],update['originalBom']),('update','90',{'1':2}))
        self.assertEqual(decide(expected,None,[matching])['action'],'reuse')
        self.assertEqual(decide(expected,None,[])['action'],'create')
        for candidates in [[matching,matching],[different],[{**matching,'isPackage':False}]]:
            self.assertEqual(decide(expected,None,candidates)['action'],'conflict')
        self.assertEqual(decide(expected,{**different,'isPackage':False},[],True)['action'],'conflict')

    def test_single_item_always_runs_six_package_steps_and_readback(self):
        service,gateway=self.fixture();job=self.preview(service)
        self.assertTrue(job['items'][0]['nameChanged'])
        self.assertFalse(gateway.writes)
        result=self.execute(service,job)
        self.assertEqual(result['phase'],'done');self.assertEqual(result['items'][0]['state'],'verified')
        self.assertEqual([r[0] for r in gateway.writes],['get_code','create_package','save_bom','set_bom_type','link_sku','repair_link'])
        self.assertEqual(gateway.writes[0][1]['categoryId'],315);self.assertEqual(gateway.writes[1][1]['categoryId'],406)
        self.assertEqual(gateway.writes[1][1]['name'],'76-100-AUTO')
        self.assertTrue(all(call[2]==(120 if call[0]=='refresh_product' else 20) for call in gateway.calls))
        self.assertTrue(all(call[2]==20 for call in gateway.writes))

    def test_reuse_already_and_rematch_do_not_rebind_or_resave(self):
        for mode in ['reuse','already','update','conflict']:
            with self.subTest(mode=mode):
                service,gateway=self.fixture();gateway.package(name='100-AUTO',parts={'1':2} if mode in {'update','conflict'} else {'1':1})
                if mode!='reuse':gateway.platform[0]['goodsId']='90'
                job=self.preview(service,mode='rematch' if mode=='update' else 'normal')
                self.assertEqual(job['items'][0]['action'],mode)
                if mode=='conflict':
                    with self.assertRaises(MatchError):self.execute(service,job)
                    self.assertFalse(gateway.writes);continue
                result=self.execute(service,job,mode=='update');self.assertEqual(result['phase'],'done')
                self.assertEqual([row[0] for row in gateway.writes],{'reuse':['link_sku'],'already':[],'update':['save_bom']}[mode])

    def test_unknown_write_stops_rest_and_recovery_is_read_only(self):
        service,gateway=self.fixture(('100','101'));gateway.package(parts={'1':2});gateway.platform[0]['goodsId']='90'
        job=self.preview(service,[snapshot(),snapshot('101')],mode='rematch');gateway.fail='save_bom'
        result=self.execute(service,job,True)
        self.assertEqual(result['phase'],'needs_review');self.assertEqual(len(gateway.writes),1)
        self.assertEqual(result['items'][0]['pendingStep']['operation'],'save_bom')
        reopened=MatchingService(gateway,service.root,'test-owner')
        self.assertEqual(reopened.status()['job']['phase'],'needs_review')
        reopened.recover({'jobId':job['id']});result=self.wait(reopened,'partial')
        self.assertEqual(result['items'][0]['state'],'verified');self.assertEqual(result['items'][1]['state'],'not_run')
        self.assertEqual(len(gateway.writes),1)

    def test_duplicate_identity_offsale_and_unsaved_block(self):
        for change in ['duplicate','offsale','shop','spu']:
            service,gateway=self.fixture()
            if change=='duplicate':gateway.platform.append(copy.deepcopy(gateway.platform[0]))
            if change=='offsale':gateway.platform[0]['onSale']=False
            if change=='shop':gateway.platform[0]['shopId']='32'
            if change=='spu':gateway.platform[0]['spu']='901'
            job=self.preview(service);self.assertEqual(job['items'][0]['action'],'conflict');self.assertFalse(gateway.writes)
        for items in [[snapshot(saved=False)],[snapshot(),snapshot()]]:
            service,_=self.fixture()
            with self.assertRaises(MatchError):service.preview({'items':items})

    def test_preview_expiry_and_cross_worker_lock(self):
        service,gateway=self.fixture(clock=lambda:100)
        job=self.preview(service);service.clock=lambda:1901
        with self.assertRaises(MatchError):self.execute(service,job)
        with OperationLock(service.root):
            with self.assertRaises(MatchError) as error:service.preview({'items':[snapshot()]})
            self.assertEqual(error.exception.code,'ERP_OPERATION_BUSY')
            with self.assertRaises(OperationBusy):
                with OperationLock(service.root):pass
        self.assertFalse(gateway.writes)

    def test_background_freezes_snapshot_and_stops_after_current_item(self):
        service,gateway=self.fixture(('100','101'));release=threading.Event();gateway.pause=('get_code',release)
        items=[snapshot(),snapshot('101')];job=self.preview(service,items)
        items[0]['actualParts'][0]['qty']=99
        service.execute({'jobId':job['id'],'previewDigest':job['previewDigest']})
        self.assertTrue(gateway.at_step.wait(2));self.assertTrue(service.status()['job']['active'])
        self.assertEqual(service.status()['job']['items'][0]['expected'],{'1':1})
        service.cancel();release.set();result=self.wait(service,'stopped')
        self.assertEqual(result['items'][0]['state'],'verified');self.assertEqual(len(gateway.writes),6)

    def test_repeated_recovery_never_unprotects_confirmed_but_unverified_write(self):
        service,gateway=self.fixture();job=self.preview(service)
        original=gateway.read
        def read(operation,payload,timeout):
            value=original(operation,payload,timeout)
            if operation=='platform_goods' and gateway.writes:
                for row in value['rows']:row['goodsId']=None
            return value
        gateway.read=read
        result=self.execute(service,job);self.assertEqual(result['phase'],'needs_review')
        count=len(gateway.writes)
        for _ in range(3):
            service.recover({'jobId':job['id']});result=self.wait(service,'needs_review')
            self.assertEqual(result['items'][0]['state'],'needs_review')
            with self.assertRaises(MatchError):service.preview({'items':[snapshot()]})
        gateway.read=lambda *args,**kwargs:(_ for _ in ()).throw(ConnectionError())
        service.recover({'jobId':job['id']});self.wait(service,'needs_review')
        self.assertEqual(len(gateway.writes),count)

    def test_large_preview_is_paged_and_does_not_return_internal_snapshot(self):
        service,gateway=self.fixture(tuple(str(100+i) for i in range(300)))
        # 大批次状态边界在内存验证，落盘顺序由其它写步骤测试单独验证。
        service._save=lambda:None
        items=[snapshot(str(100+i),name='配置名'*500) for i in range(300)]
        job=self.preview(service,items)
        self.assertEqual((job['total'],len(job['items'])),(300,50))
        self.assertLess(len(json.dumps(job,ensure_ascii=False).encode()),2*1024*1024)
        self.assertNotIn('snapshot',job['items'][0]);self.assertNotIn('steps',job['items'][0])
        self.assertEqual(service.status(250)['job']['items'][0]['configId'],'c350')

    def test_only_network_reads_retry_twice_and_live_nonshipping_name_is_excluded(self):
        service,gateway=self.fixture();attempts=[];original=gateway.read
        def read(operation,payload,timeout):
            if operation=='refresh_product':
                attempts.append(timeout)
                if len(attempts)<3:raise ConnectionError()
            return original(operation,payload,timeout)
        gateway.read=read;self.preview(service);self.assertEqual(attempts,[120]*3)
        service,gateway=self.fixture();gateway.products['1']['name']='【写配置用/不会出货】占位'
        self.assertEqual(self.preview(service)['items'][0]['action'],'conflict');self.assertFalse(gateway.writes)

    def test_shared_preview_reads_filtered_status_and_two_durable_receipts(self):
        service,gateway=self.fixture(('100','101'))
        gateway.package(parts={'1':2})
        gateway.platform[0]['goodsId']='90'
        saves=[]
        original=service._save
        def save():
            saves.append(service.job['phase'])
            original()
        service._save=save
        service.preview({'items':[snapshot(),snapshot('101')]})
        job=self.wait(service,'preview')
        self.assertEqual(saves,['previewing','preview'])
        counts=job['actionCounts']
        self.assertEqual((job['mode'],counts),('rematch',{'update':1,'create':1}))
        self.assertEqual([p for op,p,_ in gateway.calls if op=='platform_goods'],[{'shopId':'76','spu':'900'}])
        self.assertEqual([p for op,p,_ in gateway.calls if op=='find_packages'],[{'sku':'101'}])
        self.assertEqual([p['goodsId'] for op,p,_ in gateway.calls if op=='product_info'].count('1'),1)
        filtered=service.status(action_filter='create')['job']
        self.assertEqual((filtered['filteredTotal'],filtered['total'],filtered['items'][0]['configId']),(1,2,'c101'))
        self.assertEqual(job['items'][0]['componentNames'],{'1':'CPU'})
        with self.assertRaises(MatchError):self.execute(service,job)
        self.assertEqual(gateway.writes,[])

    def test_concurrent_component_reads_with_safe_errors_and_snapshot_order(self):
        service,gateway=self.fixture(('100','101'))
        # 屏障确保两个不同配件实际同时读取；一行失败不会改变另一行结果。
        barrier=threading.Barrier(2,timeout=2)
        original=gateway.read
        def read(operation,payload,timeout):
            if operation=='product_info':
                barrier.wait()
                if payload['goodsId']=='2':
                    raise PermissionError('SENSITIVE-RAW-RESPONSE')
            return original(operation,payload,timeout)
        gateway.read=read
        job=self.preview(service,[snapshot(),snapshot('101',actualParts=[{'goodsId':'2','qty':1}])])
        self.assertEqual([i['action'] for i in job['items']],['create','conflict'])
        self.assertEqual(job['items'][1]['reason'],'配件信息核验失败（登录失效）。')
        self.assertNotIn('SENSITIVE',json.dumps(job))
        self.assertFalse(gateway.writes)

    def test_shop_wide_sku_ambiguity_still_checked_before_write(self):
        service,gateway=self.fixture()
        gateway.platform.append({**gateway.platform[0],'spu':'901'})
        job=self.preview(service)
        self.assertEqual(job['items'][0]['action'],'create')
        self.assertEqual(self.execute(service,job)['phase'],'failed')
        self.assertFalse(gateway.writes)

    def test_old_adapter_queries_both_names_and_does_not_create_duplicate(self):
        service,gateway=self.fixture()
        gateway.sku_package_search=False
        gateway.concurrent_reads=False
        gateway.package(name='100-AUTO')
        job=self.preview(service)
        self.assertEqual(job['items'][0]['action'],'reuse')
        self.assertEqual(sorted(p['name'] for op,p,_ in gateway.calls if op=='find_packages'),['100-AUTO','76-100-AUTO'])

    def test_cost_reader_process_shares_operation_lock(self):
        import os,subprocess,sys
        service,_=self.fixture();root=Path(__file__).resolve().parents[1]
        env={**os.environ,'DIYTOOLS_ERP_OPERATIONS':str(service.root),'PYTHONPATH':str(root/'erp-worker')}
        with OperationLock(service.root):
            process=subprocess.run([sys.executable,str(root/'cost-reader/main.py')],input=b'{"id":"blocked","action":"sql_cost_file","settings":{}}\n',capture_output=True,env=env,timeout=10)
        self.assertEqual(json.loads(process.stdout)['error']['code'],'ERP_OPERATION_BUSY')

if __name__=='__main__':unittest.main()
