// 以库存查询的大分类为准；历史工作台标签也沿用同一套归类规则。
const erpCategories=new Map(Object.entries({
 '处理器':'CPU', '主板':'主板', '显卡':'显卡', '内存':'内存', '固态硬盘':'硬盘',
 '散热器':'散热', '散热风扇':'风扇', '机箱':'机箱', '电源':'电源',
 '线材':'其他配件', '灯光灯效':'其他配件', '其他':'其他配件',
 '其他配件':'其他配件', '线材/扩展':'其他配件', 'cpu':'CPU', '硬盘':'硬盘', '风扇':'风扇', '散热':'散热',
}));
const normalize=value=>String(value??'').normalize('NFKC').toLowerCase().trim();
const categoryPatterns=[
 // 附件名称常带适配的硬件型号，先识别商品本身。
 ['其他配件',/副屏|监控屏|发光层|定制.{0,8}马甲|灯条|灯板|灯带|灯效配件|^灯效$|灯光灯效|控制器|竖装支架|线材|模组线|电源线|供电线|编织线|同步线|分接线|延长线|转接线|显卡支架|转接|扩展|集线器|数据线|连接线|hub\b|riser|cable/i],
 ['散热',/散热(?!风扇)|水冷|风冷|冷排|cooler|heatsink/i],
 ['风扇',/正叶|反叶|积木扇|风扇|fan\b/i],
 ['机箱',/机箱|chassis|\bcase\b/i],
 ['电源',/电源|power supply|\bpsu\b|\b\d{3,4}\s*w\b/i],
 ['CPU',/cpu|处理器|酷睿|锐龙|奔腾|赛扬|epyc|xeon|ryzen|\b\d{4,5}(?:kf|k|f|x3d|x)\b|\b\d{3}k(?:f|\s*plus)?\b|ultra\s*[3579]|\b[ir][3579][\s-]*\d{4,5}/i],
 ['主板',/主板|motherboard|\b[abhxyz]\d{3}[mi]?\b/i],
 ['显卡',/显卡|独显|geforce|radeon|\b(?:rtx|gtx|rx|arc)\s*[-a-z]?\s*\d{3,4}/i],
 ['内存',/内存|ddr\s*[345]|dimm|memory|海力士|(?:^|[^a-z0-9])d[45](?=[^a-z]|$)/i],
 ['硬盘',/硬盘|固态|机械盘|sata|存储|ssd|nvme|\bhdd\b|硬碟/i],
];

// 精确枚举优先；历史分类和缺分类商品可按名称补识别。
export function categoryFromName(value){
 const name=normalize(value);
 return categoryPatterns.find(([,pattern])=>pattern.test(name))?.[0];
}
export function categoryFromErp(value){
 return erpCategories.get(normalize(value))||categoryFromName(value);
}

/** 按新到旧查找 ERP 大类；明确清空后改用部位或名称，不再取更老的分类。 */
export function observedErpCategory(...values){
 for(const value of values){
  if(value===null)return undefined;
  if(value===undefined)continue;
  const category=categoryFromErp(value);
  if(category)return category;
 }
}
