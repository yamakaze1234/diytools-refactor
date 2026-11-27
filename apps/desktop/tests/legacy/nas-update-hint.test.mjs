import test from 'node:test';
import assert from 'node:assert/strict';
import {createNasUpdateHint} from '../../public/workbench/nas-update-hint.js';

test('同店其他人先保存、本机随后保存时，回读本机回执仍保留他人的更新提醒',()=>{
 const hint=createNasUpdateHint();
 const audit=(hour,id,version)=>({kind:'configurations',resource_id:id,next_version:version,created_at:`2026-01-01T${hour}:00:00Z`});
 const first=audit('09','旧记录','5'),other=audit('10','远端配置','6'),mine=audit('11','本机配置','7');
 const read=(activity,poll)=>hint.observe({updatedAt:activity[0].created_at,activity},poll);
 read([first],false);
 hint.saved({configuration_id:'本机配置',version:'7'});
 read([mine,other,first],false);
 assert.equal(hint.time(),null);
 read([mine,other,first],true);
 assert.equal(hint.time(),other.created_at);
 // 同一批的自动编号也属于本机操作，不能覆盖已经显示的远端提醒时间。
 hint.saved({kind:'configurations',changes:[{configuration_id:'本机配置',version:'8',reordered:[{configuration_id:'编号配置',version:'3'}]}]});
 read([audit('13','编号配置','3'),audit('12','本机配置','8'),mine,other],true);
 assert.equal(hint.time(),other.created_at);
});
