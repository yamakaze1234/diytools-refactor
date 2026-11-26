import {observedErpCategory,categoryFromName} from './component-category.js';
// 统一按配件类型控制维护表单的显示范围。
const categoryKind=value=>({CPU:'cpu','处理器':'cpu','主板':'board','机箱':'case','显卡':'vramGb','内存':'memoryGb','硬盘':'storageGb','固态':'storageGb','固态硬盘':'storageGb','机械硬盘':'storageGb','存储':'storageGb','散热':'other','其他配件':'other','散热器':'other','风扇':'other','电源':'other'}[String(value||'').trim().toUpperCase()]);
export function maintenanceKind(row,configs=[],costs=[]){
 if(row.specialComponent)return 'other';
 const cost=row.goodsId?costs.find(item=>item.goodsId===row.goodsId):null;
 const explicit=categoryKind(observedErpCategory(cost?.erpCategory,row.erpCategory));
 if(explicit)return explicit;
 const used=new Set();
 for(const config of configs){if(config.deletedAt||(config.shopId||'intel')!==(row.shopId||'intel'))continue;for(const part of [...config.parts||[],...config.actualParts||[]])if((row.sourceId&&part.sourceId===row.sourceId)||(!part.sourceId&&row.goodsId&&part.goodsId===row.goodsId)){const kind=categoryKind(part.slot);if(kind)used.add(kind);}}
 if(used.size===1)return [...used][0];
 const kind=categoryKind(row.slot)||categoryKind(categoryFromName([cost?.name,row.erpName,row.name].filter(Boolean).join(' ')));
 if(kind)return kind;
 if(row.hardwareOverrides?.gpuName)return 'vramGb';
 // 新建时允许直接维护简称；名称尚未能识别时，保存后仍能找到已填的维护项。
 if(row.hardwareOverrides?.caseBoards?.length)return 'case';
 if(row.hardwareOverrides?.boardType)return 'board';
 if(row.hardwareOverrides?.cpuName)return 'cpu';
 const capacities=Object.keys(row.capacityOverrides||{}).filter(key=>['vramGb','memoryGb','storageGb'].includes(key)&&row.capacityOverrides[key]>0);
 if(capacities.length===1)return capacities[0];
 const facts=row.hardwareFacts||{};
 if(facts.caseBoards||facts.caseType)return 'case';if(facts.boardType)return 'board';if(facts.cpuName)return 'cpu';
 return 'other';
}
const hardwareCopy={
 vramGb:['显卡简称识别','自动识别不准确时填写显卡简称，生成配置简称时优先使用人工值。','清空恢复自动识别；人工简称会保留，价格同步不会覆盖。'],
 cpu:['CPU 简称识别','默认自动识别。识别有误时填写人工名称；清空后恢复自动。','人工名称会保留，价格同步不会覆盖。'],
 board:['主板板型识别','默认自动识别。识别有误时选择实际板型；选择“自动识别”恢复自动。','人工板型会保留，价格同步不会覆盖。'],
 case:['机箱支持板型','默认读取已维护的机箱资料。识别有误时勾选支持的主板板型，可多选。','取消全部勾选恢复自动；人工设置会保留，价格同步不会覆盖。']
};
export function updateMaintenanceVisibility(root,row,configs=[],costs=[],{isNew=false}={}){
 const kind=maintenanceKind(row,configs,costs);
 // 新建尚无完整 ERP 或名称，先展示全部可选维护项，不让自动识别将表单隐藏为空白。
 const showAll=isNew&&!row.specialComponent;
 const showColor=!row.specialComponent&&kind!=='storageGb';
 for(const el of root.querySelectorAll('[data-maintenance-kind]')){
  el.hidden=el.dataset.maintenanceKind==='color'?!showColor:!showAll&&el.dataset.maintenanceKind!==kind;
 }
 const hardware=root.querySelector('#source-hardware'),capacity=root.querySelector('#source-capacity');
 if(hardware){
  const copy=showAll?['配件识别资料','只填写当前配件需要的项目；留空使用自动识别。','人工设置会保留，价格同步不会覆盖。']:
   hardwareCopy[kind]??(showColor?['颜色识别','识别有误时选择配件的实际颜色。','选择“自动识别”可取消人工颜色。']:null);
  hardware.hidden=!copy;
  if(copy){hardware.querySelector('legend').textContent=copy[0];hardware.querySelector('.hardware-intro').textContent=copy[1];hardware.querySelector('.hardware-footnote').textContent=copy[2];}
 }
 if(capacity)capacity.hidden=!showAll&&!['vramGb','memoryGb','storageGb'].includes(kind);
}
