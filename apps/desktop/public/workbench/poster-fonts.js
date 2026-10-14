/** 海报字体加载：集中解析字体选择并等待内置字体就绪，减少预览与导出差异。 */
export const POSTER_BODY_FONT='阿里巴巴普惠体';
export const POSTER_TITLE_FONT='抖音美好体';
export const POSTER_FONTS=[POSTER_BODY_FONT,POSTER_TITLE_FONT];
/** 解析配置或文字区域的字体设置，回退到可用的默认字体。 */
export function posterFontFamily(value,key=''){
 return POSTER_FONTS.includes(value)?value:key==='header.version'||key.endsWith('.title')?POSTER_TITLE_FONT:POSTER_BODY_FONT;
}
// Resolve legacy fonts on a presentation copy: existing records and sync revisions stay intact.
/** 生成带统一字体信息的海报渲染配置。 */
export function withPosterFonts(config){
 const c={...config,fontFamily:posterFontFamily(config.fontFamily),modules:(config.modules||[]).map(m=>({...m,fontFamily:posterFontFamily(m.fontFamily)}))};
 for(const field of ['textStyles','skuTextStyles']){
  c[field]={};
  for(const [key,style] of Object.entries(config[field]||{}))c[field][key]={...style,fontFamily:posterFontFamily(style.fontFamily,key),...(style.ranges?{ranges:style.ranges.map(r=>({...r,style:{...r.style,...(r.style?.fontFamily?{fontFamily:posterFontFamily(r.style.fontFamily,key)}:{})}}))}:{})};
  for(const key of ['header.version','header.title',...c.modules.map(m=>`${m.id}.title`)])c[field][key]={...c[field][key],fontFamily:posterFontFamily(c[field][key]?.fontFamily,key)};
 }
 return c;
}
let loading;
/** 等待绘图所需字体加载完成，供预览和导出共用。 */
export function ensurePosterFonts(){
 if(!loading)loading=Promise.all([
  [POSTER_BODY_FONT,'AlibabaPuHuiTi-3-55-Regular.ttf','400'],
  [POSTER_BODY_FONT,'AlibabaPuHuiTi-3-65-Medium.ttf','500'],
  [POSTER_BODY_FONT,'AlibabaPuHuiTi-3-85-Bold.ttf','600 900'],
  [POSTER_TITLE_FONT,'DouyinSans.otf','100 900'],
 ].map(async([family,file,weight])=>{
  const face=new FontFace(family,`url("${new URL('./assets/fonts/'+file,import.meta.url)}")`,{weight});
  await face.load();document.fonts.add(face);
 })).catch(error=>{loading=null;throw new Error('模板字体载入失败，请检查程序文件是否完整',{cause:error});});
 return loading;
}
