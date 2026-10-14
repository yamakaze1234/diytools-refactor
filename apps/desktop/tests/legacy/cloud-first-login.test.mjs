// 全新成员工作区：使用空持久基线启动真实同步引擎，先下载现有云记录，全程不生成上传。
import test from 'node:test';
import assert from 'node:assert/strict';
import {createCloudEngine} from '../../public/workbench/cloud-engine.js';
import {projectWorkspace} from '../../public/workbench/cloud-projection.js';

test('fresh bound workspace downloads existing cloud state without pushing',async()=>{
 const member={uid:'fresh-member',workspaceId:'team'};
 let snapshot={cloudVersion:1,state:{revision:0,configs:[],templates:[],sourceCatalog:[],costSource:[],caseGallery:[],shopSettings:{}},document:{format:1,...member,deviceId:'new-device',cursor:0,localRevision:0,records:[],outbox:[],materializedProjection:[],origin:'empty-workspace'}};
 const remoteState={configs:[{id:'existing',name:'云端配置',shopId:'intel',price:100,parts:[],actualParts:[],addons:[]}],templates:[],sourceCatalog:[],costSource:[],caseGallery:[],shopSettings:{}};
 const rows=[...projectWorkspace(remoteState),{type:'workspace_meta',id:'root',data:{format:2,counts:{configuration:1},createdAt:'2026-01-01T00:00:00Z'}}].map((r,i)=>({...r,seq:i+1,version:1}));
 const calls=[];
 const engine=createCloudEngine({load:async()=>structuredClone(snapshot),commit:async request=>{
  assert.deepEqual(request.document.outbox,[]);
  snapshot={state:{...structuredClone(request.state),revision:snapshot.state.revision+1},cloudVersion:snapshot.cloudVersion+1,document:structuredClone(request.document)};
  return {revision:snapshot.state.revision,cloudVersion:snapshot.cloudVersion};
 },call:async request=>{
  calls.push(request.action);
  assert.ok(['sync.snapshot','sync.pull'].includes(request.action),'首次空库不能发送云端写请求');
  if(request.action==='sync.snapshot'){
   const records=[...rows].sort((a,b)=>a.type.localeCompare(b.type)||a.id.localeCompare(b.id));
   const last=records.at(-1);
   return {ok:true,checkpointSeq:rows.length,nextCursor:[last.type,last.id],hasMore:false,records};
  }
  const changes=rows.filter(r=>r.seq>request.payload.cursor);
  return {ok:true,headSeq:rows.length,nextCursor:rows.length,hasMore:false,changes};
 }});
 await engine.run({member,upload:true});
 assert.equal(calls[0],'sync.snapshot');
 assert.ok(calls.length>0);
 assert.deepEqual(snapshot.document.outbox,[]);
 assert.equal(snapshot.state.configs[0].id,'existing');
 assert.equal(snapshot.state.configs[0].name,'云端配置');
});
