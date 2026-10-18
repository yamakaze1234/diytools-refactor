/** 容量是每一件 ERP 商品的规格；套装先合计，再乘配置中的商品数量。 */
export const capacityLabels={vramGb:'显卡显存',memoryGb:'内存容量',storageGb:'存储容量'};
export function autoCapacity(text){
 const s=String(text||'').normalize('NFKC').toUpperCase();
 const kit=s.match(/(?:^|[^A-Z0-9.])(\d+(?:\.\d+)?)\s*(TB|GB|T|G)\s*[X×*]\s*(\d{1,2})(?!\d)/);
 const reverse=s.match(/(?:^|[^A-Z0-9.])(\d{1,2})\s*[X×*]\s*(\d+(?:\.\d+)?)\s*(TB|GB|T|G)(?![A-Z])/);
 if(kit&&Number(kit[3])<=16)return Number(kit[1])*(kit[2].startsWith('T')?1024:1)*Number(kit[3]);
 if(reverse&&Number(reverse[1])<=16)return Number(reverse[2])*(reverse[3].startsWith('T')?1024:1)*Number(reverse[1]);
 const matches=[...s.matchAll(/(?:^|[^A-Z0-9.])(\d+(?:\.\d+)?)\s*(TB|GB|T|G)(?![A-Z])/g)];
 if(!matches.length)return null;const m=matches.at(-1);return Number(m[1])*(m[2].startsWith('T')?1024:1);
}
export function validateCapacities(value){
 if(value==null)return undefined;if(typeof value!=='object'||Array.isArray(value))throw Error('容量设置格式无效');
 const result={};for(const [key,label]of Object.entries(capacityLabels)){const raw=value[key];if(raw==null||raw==='')continue;const n=Number(raw);if(!Number.isFinite(n)||n<=0||n>1048576)throw Error(`${label}须为大于0的GB数值`);result[key]=n;}
 return Object.keys(result).length?result:undefined;
}
export function partCapacity(part,key){const n=part?.capacityOverrides?.[key];return Number.isFinite(n)&&n>0?n:autoCapacity(part?.name);}
export const capacityText=(gb,qty=1)=>gb==null?'':((gb*Math.max(1,Number(qty)||1))%1024===0?`${gb*Math.max(1,Number(qty)||1)/1024}T`:`${Number((gb*Math.max(1,Number(qty)||1)).toFixed(2))}G`);
export function copyCapacity(source,part){if(source.capacityOverrides)part.capacityOverrides=structuredClone(source.capacityOverrides);else delete part.capacityOverrides;}
