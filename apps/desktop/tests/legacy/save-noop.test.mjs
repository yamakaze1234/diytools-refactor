import * as scopeHelpers from '../../public/workbench/scoped-save.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import {captureEditorState,cloneEditorState} from '../../public/workbench/editor-performance.js';

const app=await fs.readFile(new URL('../../public/workbench/app.js',import.meta.url),'utf8');
// Keep these existing undo/retry fixtures on the complete-workspace branch.
const fullBranch={fullWorkspace:true,pruneDetails(){},compactWorkspace:async()=>false,setTimeout:()=>0};
test('gesture undone before autosave does not send a full workspace or increment revision',async()=>{
 const acceptedState={revision:8,updatedAt:'2026-10-12T00:00:00Z',configs:[{id:'a',name:'original'}],templates:[],sourceCatalog:[],costSource:[],caseGallery:[],shopSettings:{},logs:[]};
 const state=cloneEditorState(acceptedState);state.configs[0].name='changed';state.configs[0].name='original';let requests=0,images=0;
 const node={textContent:''},context={...fullBranch,state,acceptedState,dirty:true,ordinaryPending:null,batchPromise:null,batchPending:null,savePromise:null,conflict:false,captureEditorState,$:()=>node,scheduleImageSave(){images++;},request(){requests++;throw Error('No request expected');}};
 const code=app.slice(app.indexOf('async function save(){'),app.indexOf('async function sendBatchPending('));
 Object.assign(context,scopeHelpers);if(!('acceptedState' in context))context.acceptedState=null;vm.runInNewContext(code+'\nglobalThis.saveNow=save;',context);await context.saveNow();
 assert.equal(requests,0);assert.equal(context.dirty,false);assert.equal(context.savePromise,null);assert.equal(state.revision,8);assert.match(node.textContent,/已保存/);assert.equal(images,1);
});
