import fs from 'node:fs';
import {performance} from 'node:perf_hooks';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {ensureActualParts} from '../../public/workbench/actual-parts.js';
import {cloneEditorState,captureEditorState,mergeEditorState} from '../../public/workbench/editor-performance.js';
import {captureSaveSnapshot,saveSnapshotIds,acknowledgeSaveScope,declareSaveScope,changeSaveScope,saveScopeStatus,unsupportedSaveRootChanges,sameCapturedBusinessState} from '../../public/workbench/scoped-save.js';
import {ordinarySaveChanges} from '../../public/workbench/batch-save.js';
import {sameEditingState} from '../../public/workbench/workspace-ui-merge.js';

const input=process.argv[2]||fileURLToPath(new URL('../../../../sandbox/migration-review/20261011/source-state.json',import.meta.url));
function freeze(value){if(value&&typeof value==='object'&&!Object.isFrozen(value)){Object.freeze(value);for(const item of Object.values(value))freeze(item);}return value;}
const bytes=fs.readFileSync(input),source=freeze(JSON.parse(bytes)),base=cloneEditorState(source);
for(const row of base.configs)ensureActualParts(row);
freeze(base);
const live=cloneEditorState(base),target=live.configs.find(row=>!row.deletedAt);
const confirmed=captureSaveSnapshot(live,base);acknowledgeSaveScope(live,base,confirmed,false);
declareSaveScope(live,base,[target.id]);target.name+=' scoped benchmark';changeSaveScope(live,base,[target.id]);
const results={source:input,sourceSha256:createHash('sha256').update(bytes).digest('hex'),sourceFrozen:true,baseFrozen:true,node:process.version,configs:live.configs.length,logs:live.logs.length,targetId:target.id,scope:saveScopeStatus(live)};
const measure=(name,fn)=>{const samples=[];for(let i=0;i<5;i++){const start=performance.now();fn();samples.push(+(performance.now()-start).toFixed(2));}results[name]={samplesMs:samples,medianMs:[...samples].sort((a,b)=>a-b)[2]};};
measure('beforeFullCapture',()=>captureEditorState(live,base));
measure('afterScopedCapture',()=>captureSaveSnapshot(live,base));
function prepare(snapshot,ids=null){if(unsupportedSaveRootChanges(base,snapshot).length||sameCapturedBusinessState(base,snapshot))throw Error('invalid benchmark edit');if(ordinarySaveChanges(base,snapshot,ids)?.length!==1)throw Error('capture did not select one change');}
measure('beforeSavePreparation',()=>prepare(captureEditorState(live,base)));
measure('afterSavePreparation',()=>{const snapshot=captureSaveSnapshot(live,base);prepare(snapshot,saveSnapshotIds(snapshot));});
const snapshot=captureSaveSnapshot(live,base),saved=structuredClone(snapshot.configs.find(row=>row.id===target.id)),remote={...base,configs:base.configs.map(row=>row.id===target.id?saved:row)};
measure('unchangedReceiptComparison',()=>sameEditingState(snapshot,remote));
saved.parts[0].lineId='benchmark-materialized';
measure('normalizedReceiptFullMergeRemaining',()=>mergeEditorState(snapshot,live,remote));
console.log(JSON.stringify(results,null,2));
