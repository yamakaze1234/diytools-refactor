import fs from 'node:fs';
import {performance} from 'node:perf_hooks';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import {cloneEditorState,mergeEditorState,mergeEditorStateAsync,prepareSavedReceipt,applySavedReceiptDraft,captureConfigHistorySnapshot,withoutActivityLogs} from '../../public/workbench/editor-performance.js';
import {normalizeWorkspaceState} from '../../public/workbench/shops.js';
import {prepareWorkspaceState} from '../../public/workbench/workspace-state-apply.js';
import {sameValue,sameEditingStateAsync} from '../../public/workbench/workspace-ui-merge.js';
import {ensureActualParts} from '../../public/workbench/actual-parts.js';

// Frozen pre-change algorithm, retained here as a field/conflict/order oracle
// and an independently repeatable baseline for the double clone cost.
function legacyMerge(base,local,remote){
 const clone=structuredClone,same=sameValue,result=clone(remote);let conflict=false;
 const withoutNewLineId=(base,row)=>{const value={...row};if(base.lineId==null)delete value.lineId;return value;};
 const merge=(b,l,r)=>{
  if([b,l,r].every(v=>v&&typeof v==='object'&&!Array.isArray(v)&&'goodsId' in v)&&[b,l,r].some(v=>'stockAvailable' in v)) [b,l,r]=[b,l,r].map(v=>({...v,stockAvailable:v.stockAvailable??null}));
  if(same(l,b))return clone(r);if(same(r,b)||same(l,r))return clone(l);
  if(b&&l&&r&&typeof b==='object'&&typeof l==='object'&&typeof r==='object'&&!Array.isArray(l)&&!Array.isArray(r)){
   if('goodsId' in b&&(l.goodsId!==b.goodsId||r.goodsId!==b.goodsId)&&!same(withoutNewLineId(b,l),withoutNewLineId(b,b))&&!same(withoutNewLineId(b,r),withoutNewLineId(b,b))){conflict=true;return clone(l);}
   const v={};for(const k of new Set([...Object.keys(b),...Object.keys(l),...Object.keys(r)])){const value=merge(b[k],l[k],r[k]);if(value!==undefined)v[k]=value;}return v;
  }
  if(Array.isArray(b)&&Array.isArray(l)&&Array.isArray(r)){
   const key=['id','lineId','slot','sourceId','goodsId'].find(k=>[b,l,r].every(rows=>rows.every(row=>row&&typeof row==='object'&&row[k]!=null)&&new Set(rows.map(row=>row[k])).size===rows.length));
   if(key){const bm=new Map(b.map(v=>[v[key],v])),lm=new Map(l.map(v=>[v[key],v])),rm=new Map(r.map(v=>[v[key],v]));return [...new Set([...rm.keys(),...lm.keys(),...bm.keys()])].map(id=>merge(bm.get(id),lm.get(id),rm.get(id))).filter(Boolean);}
  }
  conflict=true;return clone(l);
 };
 for(const [name,key] of Object.entries({configs:'id',templates:'id',sourceCatalog:'sourceId',costSource:'goodsId',caseGallery:'id'})){const b=new Map((base[name]||[]).map(r=>[r[key],r])),l=new Map((local[name]||[]).map(r=>[r[key],r])),r=new Map((remote[name]||[]).map(r=>[r[key],r]));result[name]=[...new Set([...r.keys(),...l.keys(),...b.keys()])].map(id=>merge(b.get(id),l.get(id),r.get(id))).filter(Boolean);}
 result.shopSettings=merge(base.shopSettings,local.shopSettings,remote.shopSettings);return {state:result,conflict};
}
const input=process.argv[2]||fileURLToPath(new URL('../../../../sandbox/migration-review/20261011/source-state.json',import.meta.url));
const bytes=fs.readFileSync(input),source=JSON.parse(bytes),base=cloneEditorState(source);
for(const config of base.configs)ensureActualParts(config);
const sourceCount=base.configs.length,count=Number(process.argv[3]||sourceCount);
if(!Number.isInteger(count)||count<sourceCount||count>8000)throw Error('Synthetic config count must be between source count and 8000');
for(let i=sourceCount;i<count;i++){const row=structuredClone(base.configs[i%sourceCount]);row.id+=`:benchmark:${i}`;base.configs.push(row);}
function freeze(value){if(value&&typeof value==='object'&&!Object.isFrozen(value)){Object.freeze(value);for(const item of Object.values(value))freeze(item);}return value;}
freeze(source);freeze(base);
const live=cloneEditorState(base),remote={...base,configs:base.configs.slice()};
remote.configs[0]=structuredClone(base.configs[0]);remote.configs[0].parts[0].lineId='benchmark-materialized';
live.configs.at(-1).name+=' flight input';
const freshRemote=cloneEditorState(remote),unchangedFreshRemote=cloneEditorState(base),expected=legacyMerge(withoutActivityLogs(base),withoutActivityLogs(live),withoutActivityLogs(remote));
freeze(remote);freeze(freshRemote);freeze(unchangedFreshRemote);
assert.deepEqual(withoutActivityLogs(mergeEditorState(base,live,remote).state),expected.state);
assert.deepEqual(withoutActivityLogs((await mergeEditorStateAsync(base,live,remote,{ownLocalRows:true})).state),expected.state);
assert.deepEqual(withoutActivityLogs((await mergeEditorStateAsync(base,live,freshRemote,{ownLocalRows:true})).state),expected.state);
const refreshInput=count===sourceCount?source:{...source,configs:base.configs};
const ui={active:base.configs[0].id,activeShopId:base.configs[0].shopId,selected:new Set([base.configs[0].id])};
const history=base.configs.slice(0,5).map(config=>captureConfigHistorySnapshot(base,ui,[config.id]));
const trackedFiles=['state-work.js','workspace-ui-merge.js','editor-performance.js','workspace-state-apply.js','shops.js','source.js','app.js'];
const implementationSha256=Object.fromEntries(trackedFiles.map(name=>[name,createHash('sha256').update(fs.readFileSync(new URL(`../../public/workbench/${name}`,import.meta.url))).digest('hex')]));
const results={measuredAt:new Date().toISOString(),command:`node apps/desktop/tests/legacy/state-apply.bench.mjs "${input}" ${count}`,source:input,sourceSha256:createHash('sha256').update(bytes).digest('hex'),implementationSha256,sourceFrozen:true,baseFrozen:true,syntheticExpanded:count!==sourceCount,node:process.version,configs:base.configs.length,logs:base.logs.length,budgetMs:8,scope:'Node pure-state preparation; excludes API/JSON parsing, renderAll, DOM, image rendering and native UI',gapDefinition:'Maximum work between yield callback resumes and next yield invocation, including work outside generators; 8ms is a cooperative budget, not a hard limit on atomic rows or phases',historyScope:'5 scoped undo snapshots, no redo',measurements:{}};
const median=rows=>[...rows].sort((a,b)=>a-b)[Math.floor(rows.length/2)];
async function measure(name,run,setup,verify){
 const samples=[];
 for(let i=0;i<5;i++){
  const fixture=setup?.(),slices=[];let yields=0,start=performance.now(),last=start;
  const options={budgetMs:8,onSlice:ms=>slices.push(ms),yieldWork:async()=>{slices.push(performance.now()-last);yields++;await new Promise(resolve=>setTimeout(resolve,0));last=performance.now();}};
  const result=await run(options,fixture);slices.push(performance.now()-last);
  samples.push({elapsedMs:+(performance.now()-start).toFixed(2),maxWorkGapMs:+Math.max(...slices).toFixed(2),yields});
  verify?.(result);
 }
 results.measurements[name]={samples,medianElapsedMs:median(samples.map(row=>row.elapsedMs)),medianMaxWorkGapMs:median(samples.map(row=>row.maxWorkGapMs))};
}
await measure('legacyFullMerge',()=>legacyMerge(withoutActivityLogs(base),withoutActivityLogs(live),withoutActivityLogs(remote)));
await measure('optimizedFullMerge',()=>mergeEditorState(base,live,remote));
await measure('normalizedIncrementalReceipt',options=>mergeEditorStateAsync(base,live,remote,{...options,ownLocalRows:true}));
await measure('freshFullRemoteReceipt',options=>mergeEditorStateAsync(base,live,freshRemote,{...options,ownLocalRows:true}));
await measure('unchangedFullReceiptComparison',options=>sameEditingStateAsync(base,unchangedFreshRemote,options));
await measure('freshFullReceiptWithScopedHistory',options=>prepareSavedReceipt(base,freshRemote,{getState:()=>live,getCounter:()=>1,getStacks:()=>[history,[]],options}));
await measure('freshFullReceiptWithScopedHistoryAndDraftCommit',async(options,draft)=>{
 const {live:merged}=await prepareSavedReceipt(base,freshRemote,{getState:()=>draft,getCounter:()=>1,getStacks:()=>[history,[]],options});
 return applySavedReceiptDraft(draft,merged.state,base);
},()=>cloneEditorState(live),committed=>assert.deepEqual(withoutActivityLogs(committed),expected.state));
await measure('normalizationWithoutArchiveCopy',()=>normalizeWorkspaceState(refreshInput));
await measure('completeRefreshPreparation',options=>prepareWorkspaceState(refreshInput,[],options));
assert.equal(createHash('sha256').update(fs.readFileSync(input)).digest('hex'),results.sourceSha256);
console.log(JSON.stringify(results,null,2));
