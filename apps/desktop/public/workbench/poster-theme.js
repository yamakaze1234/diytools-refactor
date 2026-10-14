/** 服务承诺区域的店铺主题颜色入口，避免渲染和编辑器各自定义不一致的默认值。 */
// Shared service-strip defaults for new configurations, theme switching and rendering.
/** 读取指定店铺和主题下的服务区背景色。 */
export const shopServiceColor=(shopId,theme)=>shopId==='jonsbo'?(theme==='dark'?'#484a50':'#35383d'):shopId==='gigabyte'?(theme==='dark'?'#2b2d30':'#deebf7'):theme==='dark'?'#194779':'#173e76';
/** 读取服务区对应的文字色。 */
export const shopServiceTextColor=(shopId,theme)=>shopId==='gigabyte'?'#ff6400':'#ffffff';
