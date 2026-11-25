"""本地套餐匹配协议、只读预览与持久逐步队列；ERP 调用完全由本机适配器提供。"""
from concurrent.futures import ThreadPoolExecutor, as_completed
from collections import Counter
import copy
import hashlib
import json
import os
from pathlib import Path
import re
import threading
import time
import uuid
from operation_lock import OperationLock, OperationBusy

SHOPS = {'76', '32', '33'}
ACTIVE = {'previewing', 'running', 'recovering', 'stopping'}
MARKER = '【写配置用/不会出货】'
READS = {'platform_goods', 'refresh_product', 'find_packages', 'product_info', 'bom', 'search_goods'}
WRITES = {'get_code', 'create_package', 'save_bom', 'set_bom_type', 'link_sku', 'repair_link'}


class MatchError(Exception):
    def __init__(self, code, message):
        self.code, self.message = code, message
        super().__init__(message)


def require(condition, message, code='INVALID_REQUEST'):
    if not condition:
        raise MatchError(code, message)


def identifier(value, *, zero=False):
    require(isinstance(value, (str, int)) and not isinstance(value, bool), '商品或平台编号必须是精确整数。')
    result = str(value)
    require(bool(re.fullmatch(r'\d{1,24}', result)) and (zero or int(result) > 0), '商品或平台编号无效。')
    return result if zero else str(int(result))


def quantity(value):
    require(type(value) is int and 1 <= value <= 1000000, '配件数量必须为正整数。')
    return value


def bom(items):
    require(isinstance(items, list) and len(items) <= 500, '配件明细格式无效。')
    result = {}
    for item in items:
        require(isinstance(item, dict), '配件明细格式无效。')
        goods, count = identifier(item.get('goodsId')), quantity(item.get('qty'))
        result[goods] = result.get(goods, 0) + count
        require(result[goods] <= 1000000, '合并后的配件数量超出限制。')
    return dict(sorted(result.items(), key=lambda row: int(row[0])))


def build_bom(parts, extras):
    require(isinstance(parts, list) and isinstance(extras, list), '实际配件和默认附加必须为数组。')
    require(all(isinstance(part,dict) for part in parts+extras), '配件明细格式无效。')
    # 即使默认附加有出货项目，主机自身也必须至少有一项真实出货配件。
    actual = [p for p in parts if isinstance(p, dict) and p.get('special') is not True and MARKER not in str(p.get('erpName') or p.get('name') or '')]
    require(actual, '排除特殊件后没有实际出货配件。')
    return bom(actual + [p for p in extras if MARKER not in str(p.get('erpName') or p.get('name') or '')])


def difference(expected, actual):
    return [{'goodsId':key, 'before':actual.get(key, 0), 'after':expected.get(key, 0)}
            for key in sorted(set(expected) | set(actual), key=int) if expected.get(key, 0) != actual.get(key, 0)]


def decide(expected, linked, candidates, rematch=False):
    """纯判定不写 ERP；重复同名、非套餐和不同 BOM 均交人工核对。"""
    if linked:
        old = linked['bom']
        if old == expected and linked['isPackage'] is True:
            return {'action':'already', 'goodsId':linked['goodsId'], 'originalBom':old, 'diff':[]}
        if rematch and linked['isPackage'] is True:
            return {'action':'update', 'goodsId':linked['goodsId'], 'originalBom':old, 'diff':difference(expected, old)}
        return {'action':'conflict', 'reason':'已关联商品的 BOM 与目标不同；普通匹配不会覆盖。' if not rematch else '已关联商品不是套餐，不能更新。', 'originalBom':old, 'diff':difference(expected, old)}
    if len(candidates) > 1:
        return {'action':'conflict', 'reason':'存在多个同名套餐，请人工核对。', 'diff':[]}
    if candidates:
        candidate = candidates[0]
        if candidate['isPackage'] is True and candidate['bom'] == expected:
            return {'action':'reuse', 'goodsId':candidate['goodsId'], 'originalBom':candidate['bom'], 'diff':[]}
        return {'action':'conflict', 'reason':'同名商品不是套餐或 BOM 不一致，请人工核对。', 'originalBom':candidate['bom'], 'diff':difference(expected, candidate['bom'])}
    return {'action':'create', 'originalBom':{}, 'diff':difference(expected, {})}


def digest(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'), allow_nan=False).encode()).hexdigest()


def unresolved(item):
    # 任何已发出的写步骤在验收前都保持保护；多次核验或读取失败均不能降级成可重试。
    return item['state']!='verified' and bool(item.get('pendingStep') or item.get('steps') or item['state']=='needs_review')


class MatchingService:
    def __init__(self, gateway, root, owner, clock=time.time):
        self.gateway, self.root, self.owner, self.clock = gateway, Path(root), owner, clock
        self.mutex, self.thread, self.stop = threading.RLock(), None, threading.Event()
        self.job = None
        self.root.mkdir(parents=True, exist_ok=True)
        # 进程崩溃后绝不重放任何写入；只恢复回执并提供远端只读核验。
        for path in sorted(self.root.glob('job-*.json'), key=lambda p:p.stat().st_mtime, reverse=True):
            try:
                require(path.stat().st_size <= 32*1024*1024 and not path.is_symlink(), '回执文件无效。')
                job = json.loads(path.read_text(encoding='utf-8'))
                require(job.get('format') == 1 and re.fullmatch(r'[a-f0-9]{32}', job.get('id','')), '回执格式无效。')
                if job.get('phase') in ACTIVE or any(row.get('pendingStep') for row in job['items']):
                    job['phase'] = 'needs_review'
                    job['message'] = '上次操作未确认完成，仅可只读核验，不自动续写。'
                self.job = job
                break
            except Exception:
                raise MatchError('RECEIPT_INVALID', '本机匹配回执无法读取，请保留文件并人工核对。') from None

    def _save(self):
        # pendingStep 和完整冻结快照必须先 fsync，再发送唯一一次写请求。
        target = self.root / ('job-' + self.job['id'] + '.json')
        temporary = target.with_suffix('.tmp')
        with temporary.open('w', encoding='utf-8') as stream:
            json.dump(self.job, stream, ensure_ascii=False, allow_nan=False)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, target)

    def status(self, offset=0, limit=50, detail=None, action_filter='all'):
        with self.mutex:
            require(type(offset) is int and offset>=0 and type(limit) is int and 1<=limit<=50,'回执分页无效。')
            job = copy.deepcopy({key:value for key,value in self.job.items() if key!='items'}) if self.job else None
            if job:
                items=self.job['items']
                job['finished'] = sum(bool(row.get('action')) if job['phase'] in {'previewing','preview'} else row['state'] in {'verified','conflict','failed','not_run'} for row in items)
                job['total'] = len(items)
                job['active'] = job['phase'] in ACTIVE
                job['hasConflicts']=any(row.get('action')=='conflict' for row in items)
                job['unfinishedIds']=[row['configId'] for row in items if row['state']!='verified']
                job['offset']=offset;job['limit']=limit
                # 筛选在全批回执上执行，维持原排序后再分页。
                require(action_filter in ('all','already','create','reuse','update','conflict'), '回执筛选无效。')
                job['actionCounts'] = dict(Counter(row['action'] for row in items if row.get('action')))
                filtered = items if action_filter == 'all' else [row for row in items if row.get('action') == action_filter]
                job['filteredTotal'] = len(filtered)
                visible=[row for row in items if row['configId']==detail] if detail else filtered[offset:offset+limit]
                job['items']=[]
                for row in visible:
                    item={key:copy.deepcopy(value) for key,value in row.items() if key not in {'snapshot','steps','originalBom','pendingStep'}}
                    for key in ['name','platformName','reason']:
                        if key in item:item[key]=str(item[key])[:200]
                    item['pendingStep']={'operation':row['pendingStep']['operation']} if row.get('pendingStep') else None
                    item['expectedTotal']=len(item['expected']);item['diffTotal']=len(item.get('diff',[]))
                    if not detail:
                        item['expected']=dict(list(item['expected'].items())[:40]);item['diff']=item.get('diff',[])[:40]
                        if 'componentNames' in item:
                            item['componentNames'] = {gid:item['componentNames'][gid] for gid in item['expected'] if gid in item['componentNames']}
                    else:item['originalBom']=copy.deepcopy(row.get('originalBom',{}))
                    job['items'].append(item)
            return {'job':job}

    def active(self):
        with self.mutex:
            return bool(self.job and self.job['phase'] in ACTIVE)

    def cancel(self):
        self.stop.set()
        return self.status()

    def _read(self, operation, **payload):
        require(operation in READS, '不支持的只读操作。')
        # 只有断连类读取可有限重试；业务校验失败和全部写请求均不自动重试。
        for attempt in range(3):
            try:
                from session import silence_sdk
                with silence_sdk():
                    return self.gateway.read(operation, payload, timeout=120 if operation=='refresh_product' else 20)
            except Exception as error:
                network = isinstance(error, (ConnectionError, TimeoutError)) or type(error).__name__ in {'ConnectError','ConnectTimeout','ReadTimeout','RemoteProtocolError','ReadError','NetworkError'}
                if network and attempt < 2:
                    continue
                # 只把白名单分类传回界面，绝不展示第三方异常文本、响应或请求。
                stage = {'refresh_product':'平台商品刷新', 'product_info':'配件信息核验', 'platform_goods':'平台 SKU 查询',
                         'find_packages':'同名套餐查询', 'bom':'套餐明细查询', 'search_goods':'配件搜索'}[operation]
                category = getattr(error, 'category', None)
                if network:
                    category = '连接超时' if 'Timeout' in type(error).__name__ else '连接中断'
                elif getattr(error, 'status', None) in (401, 403) or isinstance(error, PermissionError):
                    category = '登录失效'
                elif category not in ('登录失效','返回结构异常','数据校验失败'):
                    category = '返回结构异常' if isinstance(error, (KeyError, TypeError)) else '数据校验失败'
                raise MatchError('ERP_READ_FAILED', f'{stage}失败（{category}）。') from None

    def _rows(self, response):
        require(isinstance(response, dict) and isinstance(response.get('rows'), list) and type(response.get('total')) is int and response['total']==len(response['rows']), 'ERP 返回分页不完整。', 'INVALID_RESPONSE')
        return response['rows']

    def _platform_rows(self, shop, spu):
        rows = self._rows(self._read('platform_goods', shopId=shop, spu=spu))
        require(all(isinstance(row, dict) and str(row.get('shopId')) == shop and str(row.get('spu')) == spu for row in rows),
                'ERP 返回了其他店铺或 SPU。', 'IDENTITY_CONFLICT')
        return rows

    def _identity(self, item, preview_rows=None):
        rows = preview_rows if preview_rows is not None else self._platform_rows(item['shopId'], item['spu'])
        exact = [row for row in rows if str(row.get('sku')) == item['sku']]
        # 预览按整页 SPU 唯一命中复用；异常时交叉查询。写前和最终回读始终逐 SKU 独立核验。
        if preview_rows is None or len(exact) != 1:
            sku_rows = self._rows(self._read('platform_goods', shopId=item['shopId'], sku=item['sku']))
            require(len(exact) == 1, '平台 SKU 缺失或重复，无法唯一定位。', 'IDENTITY_CONFLICT')
            require(len(sku_rows) == 1 and all(str(sku_rows[0].get(k)) == item[k] for k in ('shopId','spu','sku')),
                    '同店平台 SKU 存在歧义或 SPU 已变化。', 'IDENTITY_CONFLICT')
            require(sku_rows[0].get('goodsId') == exact[0].get('goodsId') and sku_rows[0].get('onSale') is True,
                    '平台关联或上架状态读取不一致。', 'IDENTITY_CONFLICT')
        require(exact[0].get('onSale') is True, '平台 SKU 已失效或未上架。', 'SKU_UNAVAILABLE')
        return exact[0]

    def _product(self, goods):
        info = self._read('product_info', goodsId=goods)
        require(isinstance(info, dict) and str(info.get('goodsId'))==goods and type(info.get('isPackage')) is bool, 'ERP 商品类型无法核验。', 'INVALID_RESPONSE')
        response = self._read('bom', goodsId=goods)
        require(isinstance(response, dict), 'ERP 套餐明细无效。', 'INVALID_RESPONSE')
        actual = bom(response.get('items'))
        # 空明细的单品仅用于冲突判定；不会走直绑单品写入流程。
        if not actual and not info['isPackage']:
            actual = {goods:1}
        return {**info, 'bom':actual}

    def _inspect(self, item, preview_rows=None):
        remote = self._identity(item, preview_rows)
        goods = remote.get('goodsId')
        linked = self._product(identifier(goods)) if goods not in (None,'',0,'0') else None
        candidates = []
        if not linked:
            names = {item['packageName'], item['sku'] + '-AUTO'}
            # 组件升级前的适配器只支持按全名搜索，保留老契约以免误建重复套餐。
            if getattr(self.gateway, 'sku_package_search', False):
                rows = self._rows(self._read('find_packages', sku=item['sku']))
            else:
                rows = [row for name in sorted(names) for row in self._rows(self._read('find_packages', name=name))]
            seen = {}
            for candidate in rows:
                name = candidate.get('name')
                if name not in names:
                    continue
                gid = identifier(candidate.get('goodsId'))
                if gid in seen:
                    require(seen[gid] == name, '同一套餐编号返回了不同名称。', 'INVALID_RESPONSE')
                    continue
                seen[gid] = name
                product = self._product(gid)
                require(product.get('name') == name, '候选套餐名称已变化，请重新预览。', 'PREVIEW_STALE')
                candidates.append(product)
        return {**decide(item['expected'], linked, candidates, self.job['mode']=='rematch'),
                'platformName':str(remote.get('name') or ''), 'nameChanged':str(remote.get('name') or '')!=item['name']}

    def _launch(self, phase, function):
        require(not self.active(), '同一时间只能运行一批 ERP 任务。', 'ERP_OPERATION_BUSY')
        gate = OperationLock(self.root)
        try:
            gate.__enter__()
        except OperationBusy as error:
            raise MatchError('ERP_OPERATION_BUSY', str(error)) from None
        self.stop.clear()
        self.job['phase'] = phase
        self.job['message']=''
        try:self._save()
        except Exception:
            gate.__exit__(None,None,None)
            self.job['phase']='failed'
            raise MatchError('RECEIPT_INVALID','本机回执未能持久化，尚未发送 ERP 写入。') from None
        def run():
            try:
                function()
            except Exception as error:
                with self.mutex:
                    unknown = any(unresolved(row) for row in self.job['items'])
                    self.job['phase'] = 'needs_review' if unknown else 'failed'
                    self.job['message'] = '写入结果未确认，已停止本批剩余写入；只能只读核验。' if unknown else (error.message if isinstance(error, MatchError) else '本机匹配任务未完成，请重新预览。')
                    self._save()
            finally:
                gate.__exit__(None,None,None)
        self.thread = threading.Thread(target=run, name='erp-matching', daemon=True)
        self.thread.start()
        return self.status()

    def preview(self, payload):
        with self.mutex:
            require(not self.active() and not (self.job and self.job['phase']=='needs_review'), '请先完成当前任务或只读核验未知回执。', 'ERP_OPERATION_BUSY')
            snapshots = payload.get('items')
            require(isinstance(snapshots,list) and 1<=len(snapshots)<=500, '请选择 1–500 套已保存配置。')
            require(payload.get('mode','rematch') in {'normal','rematch'}, '匹配模式无效。')
            items, identities = [], set()
            for snap in snapshots:
                require(isinstance(snap,dict) and snap.get('saved') is True, '存在未保存的本地草稿，请先保存到服务端。', 'UNSAVED_DRAFT')
                require(set(snap)<={'configId','localShopId','shopId','spu','sku','name','saved','savedVersion','actualParts','extras'},'匹配快照包含不支持的字段。')
                require(isinstance(snap.get('configId'),str) and 1<=len(snap['configId'])<=200 and isinstance(snap.get('name'),str) and len(snap['name'])<=2000,'配置名称或身份无效。')
                shop, spu, sku = identifier(snap.get('shopId')), identifier(snap.get('spu'),zero=True), identifier(snap.get('sku'),zero=True)
                require(shop in SHOPS, 'ERP 店铺只能选择已确认的 76 / 32 / 33。')
                require((shop,sku) not in identities, '多套配置使用同一店铺 SKU，请先修正。', 'IDENTITY_CONFLICT')
                identities.add((shop,sku))
                expected = build_bom(snap.get('actualParts'),snap.get('extras',[]))
                items.append({'configId':str(snap.get('configId','')), 'name':str(snap.get('name','')), 'shopId':shop,'spu':spu,'sku':sku,
                              'snapshot':copy.deepcopy(snap), 'packageName':shop+'-'+sku+'-AUTO', 'expected':expected,'state':'pending','pendingStep':None,'steps':[]})
            require(sum(len(row['expected']) for row in items)<=10000, '本批配件明细超过允许范围。')
            self.job = {'format':1,'id':uuid.uuid4().hex,'owner':self.owner,'mode':payload.get('mode','rematch'),'phase':'idle','createdAt':self.clock(),'expiresAt':self.clock()+1800,'items':items,'message':''}
            return self._launch('previewing', self._preview_batch)

    def _component_name(self, gid):
        info = self._read('product_info', goodsId=gid)
        require(isinstance(info, dict) and str(info.get('goodsId')) == gid and isinstance(info.get('name'), str) and info['name'].strip(),
                '配件信息核验失败（数据校验失败）。', 'INVALID_RESPONSE')
        return info['name']

    def _preview_item(self, item, components, platform):
        # 先提交依赖查询后才调度行任务，避免线程在等待尚未调度的工作时耗尽。
        resolved = []
        for key in ('actualParts', 'extras'):
            parts = []
            for part in item['snapshot'].get(key, []):
                if part.get('special') is True or MARKER in str(part.get('erpName') or part.get('name') or ''):
                    parts.append(part)
                else:
                    gid = identifier(part.get('goodsId'))
                    parts.append({**part, 'erpName':components[gid].result()})
            resolved.append(parts)
        expected = build_bom(*resolved)
        names = {identifier(part['goodsId']):part['erpName'][:200] for parts in resolved for part in parts
                 if part.get('special') is not True and part.get('erpName') and MARKER not in part['erpName'] and str(part.get('goodsId')) in expected}
        decision = self._inspect({**item, 'expected':expected}, platform.result())
        return {**decision, 'expected':expected, 'componentNames':names}

    def _preview_batch(self):
        items = self.job['items']
        groups = list(dict.fromkeys((item['shopId'], item['spu']) for item in items))
        # 刷新会触发 ERP 拉取平台商品，始终串行且在查询前完成。
        for shop, spu in groups:
            if self.stop.is_set():
                break
            result = self._read('refresh_product', shopId=shop, spu=spu)
            require(isinstance(result, dict) and result.get('complete') is True, '平台商品刷新失败（数据校验失败）。')
        # 旧组件未声明并发安全时继续串行读取。
        workers = 6 if getattr(self.gateway, 'concurrent_reads', False) else 1
        with ThreadPoolExecutor(max_workers=workers, thread_name_prefix='erp-preview') as pool:
            def submit(function, *args):
                # 取消后不启动排队中的任何 ERP 读取。
                def run():
                    if not self.stop.is_set():
                        return function(*args)
                return pool.submit(run)
            parts = dict.fromkeys(gid for item in items for gid in item['expected'])
            components = {gid:submit(self._component_name, gid) for gid in parts}
            platforms = {key:submit(self._platform_rows, *key) for key in groups}
            futures = {submit(self._preview_item, item, components, platforms[(item['shopId'], item['spu'])]):item for item in items}
            for future in as_completed(futures):
                if self.stop.is_set():
                    break
                item = futures[future]
                try:
                    result = future.result()
                    if result is None:
                        continue
                    result['state'] = 'conflict' if result['action']=='conflict' else 'previewed'
                except MatchError as error:
                    result = {'action':'conflict', 'state':'conflict', 'reason':error.message, 'diff':[]}
                with self.mutex:
                    item.update(result)
        # 预览中间态只用于实时进度；整批结束时一次性冻结快照并持久化。
        with self.mutex:
            if self.stop.is_set():
                self.job['phase'] = 'stopped'
            else:
                self.job['expiresAt'] = self.clock() + 1800
                self.job['previewDigest'] = digest({'items':items, 'mode':self.job['mode'], 'expiresAt':self.job['expiresAt']})
                self.job['phase'] = 'preview'
            self._save()

    def _write(self,item,operation,**payload):
        require(operation in WRITES,'不支持的 ERP 写操作。')
        with self.mutex:
            item['pendingStep']={'operation':operation,'payload':payload,'at':self.clock()}
            self._save()
        # 此处只能调用一次。任何异常或不明确回执都让 pendingStep 留在磁盘。
        from session import silence_sdk
        with silence_sdk():
            response=self.gateway.write(operation,payload,timeout=20)
        require(isinstance(response,dict) and response.get('confirmed') is True,'ERP 写入回执尚未确认。','WRITE_UNKNOWN')
        require(set(response)<={'confirmed','goodsId','code'},'ERP 写入回执包含不支持的字段。','WRITE_UNKNOWN')
        if operation=='create_package':identifier(response.get('goodsId'))
        if operation=='get_code':require(isinstance(response.get('code'),str) and response['code'].strip() and len(response['code'])<=200,'ERP 商品编码回执无效。','WRITE_UNKNOWN')
        with self.mutex:
            item['steps'].append({'operation':operation,'result':response})
            item['pendingStep']=None
            if operation=='create_package':item['goodsId']=identifier(response.get('goodsId'))
            self._save()
        return response

    def _verified(self,item):
        remote=self._identity(item)
        goods=remote.get('goodsId')
        if goods in (None,'',0,'0'):return False
        product=self._product(identifier(goods))
        return product['isPackage'] is True and product['bom']==item['expected'] and (not item.get('goodsId') or identifier(goods)==item['goodsId'])

    def execute(self,payload):
        with self.mutex:
            require(self.job and self.job['phase']=='preview' and payload.get('jobId')==self.job['id'] and payload.get('previewDigest')==self.job.get('previewDigest') and self.clock()<self.job['expiresAt'], '预览已过期或摘要不一致，请重新预览。','PREVIEW_EXPIRED')
            require(self.job['owner']==self.owner,'ERP 账号已变化，请重新预览。')
            require(not any(row['action']=='conflict' for row in self.job['items']), '预览存在冲突，请排除冲突配置后重新预览。')
            require(not any(row['action']=='update' for row in self.job['items']) or payload.get('confirmRematch') is True, '重新匹配必须明确确认更新原套餐。')
            def execute():
                for item in self.job['items']:
                    if self.stop.is_set():
                        self.job['phase']='stopped';self._save();return
                    # 写前再读：预览后平台关联、套餐身份或原 BOM 漂移时不发送写入。
                    current=self._inspect(item)
                    require(all(current.get(key)==item.get(key) for key in ['action','goodsId','originalBom']), '预览后 ERP 状态已变化，已停止本批，请重新预览。','PREVIEW_STALE')
                    item['state']='running';self._save()
                    action=item['action']
                    if action=='create':
                        code=self._write(item,'get_code',categoryId=315).get('code')
                        require(isinstance(code,str) and code.strip(), 'ERP 商品编码回执无效。','WRITE_UNKNOWN')
                        self._write(item,'create_package',code=code,name=item['packageName'],categoryId=406)
                        created=self._product(item['goodsId'])
                        require(created.get('name')==item['packageName'] and created['isPackage'] is False and created['bom']=={item['goodsId']:1},'创建套餐的身份或初始内容无法核验。','VERIFY_FAILED')
                    if action in {'create','update'}:
                        self._write(item,'save_bom',goodsId=item['goodsId'],items=[{'goodsId':key,'qty':qty} for key,qty in item['expected'].items()])
                    if action=='create':self._write(item,'set_bom_type',goodsId=item['goodsId'],bomType='group')
                    if action in {'create','reuse'}:
                        require(self._product(item['goodsId'])['bom']==item['expected'],'关联前套餐 BOM 已变化。','PREVIEW_STALE')
                        self._write(item,'link_sku',shopId=item['shopId'],spu=item['spu'],sku=item['sku'],goodsId=item['goodsId'])
                        if action=='create':self._write(item,'repair_link',shopId=item['shopId'],sku=item['sku'])
                    require(self._verified(item),'平台 SKU 关联或套餐 BOM 回读不一致，请只读核验。','VERIFY_FAILED')
                    with self.mutex:
                        item['state']='verified';self._save()
                self.job['phase']='done';self._save()
            return self._launch('running',execute)

    def recover(self,payload):
        with self.mutex:
            require(self.job and self.job['phase'] in {'needs_review','failed','stopped','partial'} and payload.get('jobId')==self.job['id'], '没有可核验的回执。')
            require(self.job['owner']==self.owner,'请使用原 ERP 账号核验回执。')
            def recover():
                for item in self.job['items']:
                    if self._verified(item):
                        item['pendingStep']=None;item['state']='verified'
                    elif unresolved(item):
                        item['state']='needs_review'
                    else:item['state']='not_run'
                    self._save()
                self.job['phase']='needs_review' if any(row['state']=='needs_review' for row in self.job['items']) else 'done' if all(row['state']=='verified' for row in self.job['items']) else 'partial'
                self._save()
            return self._launch('recovering',recover)
