"""浏览器专用离线 ERP：真实 JSONL/后台队列，网关只修改进程内字典。"""
import os
from pathlib import Path
import sys
import time
from types import SimpleNamespace

root=Path(__file__).resolve().parents[4]
sys.path.insert(0,str(root/'services/erp-worker'))
from session import Session
from main import serve
from test_matching import FakeGateway


class Gateway(FakeGateway):
    def __init__(self, directory):
        super().__init__(directory,('8000','8001','8002','8003'))
        for i,row in enumerate(self.platform):row['spu']='900'+str(i)
        self.products={str(i):{'goodsId':str(i),'name':'ERP 配件'+str(i),'isPackage':False,'bom':{}} for i in [1001,1002,1003,1004,1005,9001]}
        self.fail_reads=0
        self.delay=0.18

    def read(self,operation,payload,timeout):
        if operation=='search_goods':
            rows=[{'goodsId':'9001','name':'固定电源线'}]
            return {'rows':rows,'total':len(rows)}
        if operation=='refresh_product' and self.fail_reads:
            self.fail_reads-=1;raise ConnectionError('offline mock read failure')
        return super().read(operation,payload,timeout)

    def write(self,operation,payload,timeout):
        time.sleep(self.delay)
        if operation=='create_package':
            # 每次新建返回不同编号，避免 mock 把独立套餐错误复用为同一商品。
            response=super().write(operation,payload,timeout)
            gid=str(9100+len([r for r in self.writes if r[0]=='create_package']))
            self.products[gid]=self.products.pop('91');self.products[gid]['goodsId']=gid
            response['goodsId']=gid;return response
        return super().write(operation,payload,timeout)


gateway=Gateway(os.environ['DIYTOOLS_ERP_OPERATIONS'])


class FixtureSession(Session):
    def handle(self,request):
        if request.get('action')=='fixture_control':
            options=request.get('payload',{})
            if 'failReads' in options:gateway.fail_reads=options['failReads']
            if 'failWrite' in options:gateway.fail=options['failWrite']
            # 调整已匹配的合成套餐，用于界面重复预览及二次确认验收。
            if 'adjustMatchedBom' in options:
                row=next(row for row in gateway.platform if row['sku']==options['adjustMatchedBom'])
                gateway.products[row['goodsId']]['bom']['1001']=2
            return {'writes':gateway.writes,'reads':gateway.calls}
        return super().handle(request)


session=FixtureSession(config={'domain':'https://erp.example.invalid/'},
    client_factory=lambda config:SimpleNamespace(user='offline-mock',client=SimpleNamespace(close=lambda:None),config={},cookies=''),
    matching_factory=lambda erp,domain:gateway)
# 单独协议描述符保证后台 SDK 消音不会吞掉前台状态响应。
with os.fdopen(os.dup(sys.stdout.fileno()),'w',encoding='utf-8',buffering=1) as protocol:
    serve(output_stream=protocol,session=session)
