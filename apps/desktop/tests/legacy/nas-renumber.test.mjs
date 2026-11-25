/** 编号回执离线验收，保留用户文案、样式和未确认请求。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {createNasDraftController} from '../../public/workbench/nas-draft-controller.js';
import {applyNasRenumber} from '../../public/workbench/nas-renumber-receipt.js';
import {NasApiError} from '../../public/workbench/nas-api-client.js';
import {buildNasOperationPlan,createNasOperationQueue} from '../../public/workbench/nas-operation-plan.js';

const long='header.subtitle';
const original={id:'c',shopId:'intel',name:'配置五',shortName:'配置五 A',posterSubtitle:'配置五 A',parts:[],actualParts:[],addons:[],
 textStyles:{[long]:{text:'第五套长图',fontSize:16},other:{color:'#00f'}},skuTextStyles:{[long]:{text:'配置五 A',size:12}}};
const row={configuration_id:'c',before:'配置五',name:'配置2',previous_version:'1',version:'2',
 before_fields:{shortName:'配置五 A',posterSubtitle:'配置五 A',textSubtitle:'第五套长图',skuTextSubtitle:'配置五 A'},
 after_fields:{shortName:'配置2 A',textSubtitle:'第二套长图'}};
function fixture(){
 const map=new Map(),storage={get length(){return map.size;},key:i=>[...map.keys()][i],getItem:key=>map.get(key),
  setItem:(k,v)=>map.set(k,v),removeItem:k=>map.delete(k)};
 const client={detail:async()=>({version:'1',dependencies:{sources:{},costs:{}},document:structuredClone(original)}),
  me:async()=>({workspace_id:'w',uid:'u',data_source:'intel_live',configuration_writes:true,shops:[{shop_id:'intel',role:'operations'}]}),
  save:async()=>{throw new NasApiError('SAVE_STATUS_UNKNOWN');}};
 return {controller:()=>createNasDraftController({client,storage,endpointId:'device',shopId:'intel'}),map};
}
test('删除和恢复回执逐字段接续，保留手改简称、自定义海报文字和样式',async()=>{
 const f=fixture(),controller=f.controller();await controller.open('c');
 const edited=structuredClone(original);edited.shortName='手动简称';edited.skuTextStyles[long].text='手写 SKU';edited.textStyles[long].fontSize=24;
 controller.edit(edited);assert.equal(controller.acceptRenumber(row),true);
 const saved=controller.read();
 assert.equal(saved.base.shortName,'配置2 A');assert.equal(saved.base.textStyles[long].text,'第二套长图');
 assert.equal(Object.hasOwn(saved.base,'posterSubtitle'),false);assert.deepEqual(saved.base.skuTextStyles[long],{size:12});
 assert.equal(saved.document.name,'配置2');assert.equal(saved.document.shortName,'手动简称');
 assert.deepEqual(saved.document.textStyles[long],{text:'第二套长图',fontSize:24});assert.deepEqual(saved.document.textStyles.other,{color:'#00f'});
 assert.equal(Object.hasOwn(saved.document,'posterSubtitle'),false);assert.equal(saved.document.skuTextStyles[long].text,'手写 SKU');
 assert.equal(controller.acceptRenumber(row),false);
 const undo={...row,before:row.name,name:row.before,previous_version:'2',version:'3',before_fields:row.after_fields,after_fields:row.before_fields};
 assert.equal(controller.acceptRenumber(undo),true);
 assert.deepEqual(controller.read().base,original);assert.deepEqual(controller.read().document,edited);
 assert.deepEqual(controller.abandonForRemote().document,original);
});
test('关闭窗口的存储草稿接续版本，缺省、null 与空串分别处理；未知提交保留原文',async()=>{
 const f=fixture(),a=f.controller();await a.open('c');a.edit({...structuredClone(original),price:99,posterSubtitle:''});
 const b=f.controller();await b.verify();
 const next={...row,after_fields:{shortName:'',textSubtitle:null}};
 assert.equal(b.acceptRenumber(next),true);
 const [saved]=[...f.map.values()].map(JSON.parse);assert.equal(saved.version,'2');
 assert.equal(saved.document.shortName,'');assert.equal(saved.document.posterSubtitle,'');assert.equal(saved.document.price,99);
 assert.equal(saved.document.textStyles[long].text,null);assert.equal(Object.hasOwn(saved.document.skuTextStyles[long],'text'),false);
 const reopened=f.controller();await reopened.open('c');
 await assert.rejects(reopened.save(),{code:'SAVE_STATUS_UNKNOWN'});const pending=reopened.read();
 assert.equal(reopened.acceptRenumber({...row,before:row.name,previous_version:'2',version:'3'}),false);assert.deepEqual(reopened.read(),pending);
});
test('旧回执只同步 name，残缺的新回执不能推进或部分写入内存',()=>{
 const doc=structuredClone(original),old={configuration_id:'c',before:'配置五',name:'配置2',previous_version:'1',version:'2'};
 applyNasRenumber(doc,old);assert.deepEqual(doc,{...original,name:'配置2'});
 assert.throws(()=>applyNasRenumber(doc,{...row,after_fields:undefined}),{code:'INVALID_API_RESPONSE'});
 assert.deepEqual(doc,{...original,name:'配置2'});
});
test('分批删除引起的编号同步到未发送的替换正文，同时保留待提交的自定义样式文字',async()=>{
 const changes=Array.from({length:100},(_,i)=>({id:'remove'+i,action:'archive',expected_version:'1'}));
 const doc=structuredClone(original);doc.skuTextStyles[long].text='本批自定义';
 changes.push({id:'c',action:'replace',expected_version:'1',document:doc});
 let stored;const sent=[];
 const storage={get:async()=>structuredClone(stored),put:async(_,v)=>{stored=structuredClone(v);}};
 const client={async workspaceWrite(kind,body){
  sent.push(structuredClone(body));
  return {shop_id:'intel',kind,operation_id:body.operation_id,changes:body.changes.map((entry,index)=>({
   configuration_id:entry.id,archived:entry.action==='archive',version:'3',reordered:sent.length===1&&index===0?[row]:[]
  }))};
 }};
 const queue=createNasOperationQueue({client,storage,key:'rename',shopId:'intel'});await queue.add(buildNasOperationPlan('configurations',changes));await queue.submit();
 const [later]=sent[1].changes;assert.equal(later.expected_version,'2');assert.equal(later.document.shortName,'配置2 A');
 assert.equal(Object.hasOwn(later.document,'posterSubtitle'),false);
 assert.equal(later.document.textStyles[long].text,'第二套长图');assert.equal(later.document.skuTextStyles[long].text,'本批自定义');
});
