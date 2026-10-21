import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {setProductTheme,applyProductThemes,productPosterConfig} from '../../public/workbench/shops.js';
import {blankConfig,importTemplateConfigs} from '../../public/workbench/core.js';
import {sourceImageEntries} from '../../public/workbench/source-sync-data.js';

const row=(id,productId,theme='dark',shopId='intel')=>({id,productId,shopId,theme,palette:{bg:theme==='dark'?'#112233':'#ffffff'},modules:[],parts:[{slot:'CPU',name:'old'}],actualParts:[],addons:[],benefits:[],installment:0});

test('链接主题切换、序列化重开和配件修改不改变其他链接或自定义配色',()=>{
 const a=row('a','one'),b=row('b','one'),other=row('c','two','light');
 setProductTheme([a,b],'dark');
 const configs=JSON.parse(JSON.stringify([a,b,other]));configs[0].parts[0].name='new';
 assert.deepEqual(applyProductThemes(configs),[]);
 assert.equal(configs[0].palette.bg,'#112233');assert.equal(configs[0].productTheme,'dark');
 assert.deepEqual(configs[2],other);
 setProductTheme(configs.slice(0,2),'light');setProductTheme(configs.slice(0,2),'dark');
 assert.equal(configs[0].palette.bg,'#112233');assert.equal(configs[2].theme,'light');
});

test('旧配置各自主题保留，链接主题不跨店铺传播且不改删除记录',()=>{
 const configs=[row('a','p'),row('b','p','light'),row('c','p','light','jonsbo'),{...row('d','p'),deletedAt:'old'}];
 assert.deepEqual(applyProductThemes(configs),[]);
 configs[0].productTheme='dark';applyProductThemes(configs);
 assert.equal(configs[1].theme,'dark');assert.equal(configs[2].theme,'light');assert.equal(configs[3].productTheme,undefined);
});

test('新增及模板导入遵循目标链接，工具导出读取持久链接主题且不修改源数据',()=>{
 const saved=row('a','p');saved.productTheme='dark';
 const product={id:'p',shopId:'intel',name:'link',configs:[saved],installment:0};
 const fresh=blankConfig(null,product);assert.equal(fresh.theme,'dark');assert.equal(fresh.productTheme,'dark');assert.equal(fresh.palette.bg,'#112233');
 const template=row('t','template','light');template.productTheme='light';
 const [imported]=importTemplateConfigs([template],product);
 const before=structuredClone(imported),resolved=productPosterConfig(imported);
 assert.equal(resolved.theme,'dark');assert.deepEqual(imported,before);
 for(const entry of sourceImageEntries([imported]))assert.equal(productPosterConfig(entry.config).theme,'dark');
 const [independent]=importTemplateConfigs([template],{...product,configs:[]});assert.equal(independent.productTheme,undefined);
});

test('界面重绘不再按店铺覆盖主题，点击仅更新当前链接，渲染器统一读取链接主题',()=>{
 const app=readFileSync(new URL('../../public/workbench/app.js',import.meta.url),'utf8');
 assert.doesNotMatch(app,/applyPosterTheme\([^;]*currentSettings\(\)\.posterTheme/);
 assert.doesNotMatch(app,/currentSettings\(\)\.posterTheme\s*=/);
 assert.match(app,/setProductTheme\(currentProduct\(\)\.configs,b\.dataset\.theme\)/);
 const poster=readFileSync(new URL('../../public/workbench/poster.js',import.meta.url),'utf8');
 assert.match(poster,/c=productPosterConfig\(c\)/);
});
