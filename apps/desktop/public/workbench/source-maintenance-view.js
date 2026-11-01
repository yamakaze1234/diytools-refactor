// 仅决定维护表单的显示范围；隐藏控件仍保留原值，不改动识别和保存规则。
const categoryKind=value=>({CPU:'cpu','处理器':'cpu','主板':'board','机箱':'case','显卡':'vramGb','内存':'memoryGb','硬盘':'storageGb','固态':'storageGb','固态硬盘':'storageGb','机械硬盘':'storageGb','存储':'storageGb','散热':'other','散热器':'other','风扇':'other','电源':'other'}[String(value||'').trim().toUpperCase()]);
export function maintenanceKind(row,configs=[],costs=[]){
 if(row.specialComponent)return 'other';
 const cost=row.goodsId?costs.find(item=>item.goodsId===row.goodsId):null;
 const explicit=categoryKind(row.erpCategory)||categoryKind(cost?.erpCategory)||categoryKind(row.slot);
 if(explicit)return explicit;
 const used=new Set();
 for(const config of configs){if(config.deletedAt||(config.shopId||'intel')!==(row.shopId||'intel'))continue;for(const part of [...config.parts||[],...config.actualParts||[]])if((row.sourceId&&part.sourceId===row.sourceId)||(!part.sourceId&&row.goodsId&&part.goodsId===row.goodsId)){const kind=categoryKind(part.slot);if(kind)used.add(kind);}}
 if(used.size===1)return [...used][0];
 const name=[row.erpName,row.name,cost?.name].filter(Boolean).join(' ').normalize('NFKC');
 if(/散热|风扇|水冷|电源|控制器|转接|线材/i.test(name))return 'other';
 if(/机箱/i.test(name))return 'case';
 if(/主板|(?:^|[^A-Z0-9])[ABHXZ]\d{3}[A-Z]?(?:\b|[- ])/i.test(name))return 'board';
 if(/显卡|RTX|GTX|RADEON|\bRX\s*\d{3,4}|\bARC\s*[AB]\d{3}/i.test(name))return 'vramGb';
 if(/硬盘|固态|SSD|NVME|SATA/i.test(name))return 'storageGb';
 if(/内存|DDR[345]|海力士/i.test(name))return 'memoryGb';
 if(/CPU|处理器|酷睿|锐龙|\bRYZEN|\bULTRA\s*[3579]|\bI[3579][ -]?\d{4,5}|\b\d{4,5}(?:KF|K|F|X3D|X)\b|\b\d{3}K(?:F|\s*PLUS)?\b/i.test(name))return 'cpu';
 const facts=row.hardwareFacts||{};
 if(facts.caseBoards||facts.caseType)return 'case';if(facts.boardType)return 'board';if(facts.cpuName)return 'cpu';
 return 'other';
}
const hardwareCopy={
 cpu:['CPU 简称识别','默认自动识别。识别有误时填写人工名称；清空后恢复自动。','人工名称会保留，价格同步不会覆盖。'],
 board:['主板板型识别','默认自动识别。识别有误时选择实际板型；选择“自动识别”恢复自动。','人工板型会保留，价格同步不会覆盖。'],
 case:['机箱支持板型','默认读取已维护的机箱资料。识别有误时勾选支持的主板板型，可多选。','取消全部勾选恢复自动；人工设置会保留，价格同步不会覆盖。']
};
export function updateMaintenanceVisibility(root,row,configs=[],costs=[]){
 const kind=maintenanceKind(row,configs,costs);
 for(const el of root.querySelectorAll('[data-maintenance-kind]'))el.hidden=el.dataset.maintenanceKind!==kind;
 const hardware=root.querySelector('#source-hardware'),capacity=root.querySelector('#source-capacity');
 if(hardware){const copy=hardwareCopy[kind];hardware.hidden=!copy;if(copy){hardware.querySelector('legend').textContent=copy[0];hardware.querySelector('.hardware-intro').textContent=copy[1];hardware.querySelector('.hardware-footnote').textContent=copy[2];}}
 if(capacity)capacity.hidden=!['vramGb','memoryGb','storageGb'].includes(kind);
}
