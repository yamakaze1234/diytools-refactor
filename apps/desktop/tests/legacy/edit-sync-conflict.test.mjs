import test from 'node:test';
import assert from 'node:assert/strict';
import {mergeEditingState} from '../../public/workbench/workspace-ui-merge.js';
import {projectWorkspace,applyWorkspace} from '../../public/workbench/cloud-projection.js';
import {setConfigCost} from '../../public/workbench/config-cost.js';

const fixture=()=>({configs:[{id:'a',parts:[{slot:'CPU',goodsId:'g',name:'CPU',qty:1,tax:100,taxOverride:null}],actualParts:[],price:200}],costSource:[{goodsId:'g',name:'CPU',tax:100}],sourceCatalog:[],templates:[],caseGallery:[],shopSettings:{}});
test('实际云物化删除空覆盖值时，独立改价不误报冲突且不修改输入',()=>{
 const base=fixture(),local=structuredClone(base),remote=applyWorkspace(base,projectWorkspace(base));
 assert.equal(Object.hasOwn(remote.configs[0].parts[0],'taxOverride'),false);
 setConfigCost(local.configs[0].parts[0],125);
 const originals=structuredClone([base,local,remote]);
 const result=mergeEditingState(base,local,remote);
 assert.equal(result.conflict,false);assert.equal(result.state.configs[0].parts[0].taxOverride.value,125);
 assert.deepEqual([base,local,remote],originals);
});
test('双方独立价格不同或真实重置竞争仍报告冲突',()=>{
 for(const reset of [false,true]){
  const base=fixture();if(reset)setConfigCost(base.configs[0].parts[0],110);
  const local=structuredClone(base),remote=structuredClone(base);
  if(reset)local.configs[0].parts[0].taxOverride=null;else setConfigCost(local.configs[0].parts[0],120);
  setConfigCost(remote.configs[0].parts[0],130);
  assert.equal(mergeEditingState(base,local,remote).conflict,true);
 }
});
