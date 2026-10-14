/** 图片导出命名与排序：保持配置顺序、编号和压缩包名称一致。 */
// Export a copy in numeric configuration order without reordering saved data.
/** 将待导出配置整理为稳定的输出顺序。 */
export function orderedImageConfigs(configs){
 const groups=new Map();
 for(const c of configs){const key=JSON.stringify([c.shopId,c.productId||c.product||c.spu||'']);if(!groups.has(key))groups.set(key,[]);groups.get(key).push(c);}
 const number=c=>/^配置\s*(\d+)(?:\D|$)/.exec(c.name||'')?.[1];
 return [...groups.values()].flatMap(rows=>rows.map((c,i)=>({c,i})).sort((a,b)=>{
  const x=number(a.c),y=number(b.c);
  if(x!==undefined&&y!==undefined)return Number(x)-Number(y)||a.i-b.i;
  if(x!==undefined||y!==undefined)return x!==undefined?-1:1;
  return a.i-b.i;
 }).map(v=>v.c));
}
/** 为排序后的配置生成带序号的图片条目。 */
export function numberedImageEntries(configs,layout=null){
 const ordered=orderedImageConfigs(configs),groups=new Map(),used=new Set();
 const key=c=>JSON.stringify([c.shopId,c.productId||c.product||c.spu||'']);
 // 多链接导出按链接建目录；同名链接加序号，避免在 Windows 上合并。
 for(const c of ordered){if(groups.has(key(c)))continue;let label=String(c.product||'未命名链接').slice(0,80),folder=imageFolderName(label,layout),n=1;while(used.has(folder.toLowerCase()))folder=imageFolderName(`${label}_${++n}`,layout);used.add(folder.toLowerCase());groups.set(key(c),folder);}
 return ordered.map((config,i)=>({config,name:`${layout&&groups.size>1?groups.get(key(config))+'/':''}${i+1}.png`}));
}

/** 文件夹只使用链接名称和图种；非法路径字符替换，避免被解释成子目录。 */
export function imageFolderName(link,layout){
 const safe=String(link||'未命名链接').trim().replace(/[<>:"/\\|?*\x00-\x1f]/g,'_').replace(/[. ]+$/g,'').slice(0,90)||'未命名链接';
 return `${safe}_${layout==='square'?'sku图':'配置图'}`;
}
/** 根据配置所属链接和图片版式生成压缩包名称。 */
export function imageArchiveName(configs,layout){
 const links=new Map();for(const c of configs){const key=JSON.stringify([c.shopId,c.productId||c.product||c.spu||'']);if(!links.has(key))links.set(key,String(c.product||'未命名链接').trim()||'未命名链接');}
 const names=[...links.values()],label=names.length>1?`${names[0]}等${names.length}个链接`:names[0]||'未命名链接';
 const safe=label.replace(/[<>:"/\\|?*\x00-\x1f]/g,'_').replace(/[. ]+$/g,'').slice(0,100)||'未命名链接';
 return imageFolderName(safe,layout)+'.zip';
}
