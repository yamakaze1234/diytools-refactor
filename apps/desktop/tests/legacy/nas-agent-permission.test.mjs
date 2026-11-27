import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createServer} from 'node:http';
import {createNasAgentWorkflow} from '../../public/workbench/nas-agent-workflow.js';

test('NAS 提交前撤权阻止新请求，已发送的原回执仍可按编号核对', async t => {
  const shop='intel',operationId=crypto.randomUUID(),head={revision:'a'.repeat(64)};
  const changes=[{id:'配置一',expected_version:'1'}];
  const revision=parseInt(createHash('sha256').update(JSON.stringify([[shop,head.revision]])).digest('hex').slice(0,13),16);
  const receipt={operation_id:operationId,shop_id:shop,kind:'configurations',changes:[
    {configuration_id:changes[0].id,shop_id:shop,operation_id:operationId,archived:false,version:'2'}
  ]};
  let writes=0,lookups=0,receiptAvailable=false;
  const server=createServer((req,res)=>{
    res.setHeader('Content-Type','application/json');
    if(req.method==='POST'){writes++;res.end(JSON.stringify(receipt));return;}
    if(req.url==='/receipts/'+operationId){
      lookups++;res.statusCode=receiptAvailable?200:404;
      res.end(JSON.stringify(receiptAvailable?receipt:{code:'NOT_FOUND'}));return;
    }
    res.statusCode=404;res.end('{}');
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const url='http://127.0.0.1:'+server.address().port;
  let allowWrite=true;
  const client={
    workspaceIndex:async()=>head,
    async workspaceReceipt(id){
      const response=await fetch(url+'/receipts/'+id),value=await response.json();
      if(!response.ok)throw Object.assign(Error(value.code),{code:value.code,status:response.status});
      return value;
    },
    async workspaceWrite(_kind,body){
      return (await fetch(url+'/configurations',{method:'POST',body:JSON.stringify(body)})).json();
    }
  };
  const execute=createNasAgentWorkflow({
    blocked:()=>false,lock:()=>()=>{},refresh:async()=>true,
    access:async()=>({client,assertWritable(){},assertDrafts:async()=>{}}),
    async native(action,payload){
      assert.equal(action,'preflight');assert.deepEqual(payload,{id:'job',shopId:shop});
      if(!allowWrite)throw Object.assign(Error('已撤权'),{code:'PERMISSION_REVOKED'});
    }
  });
  const job={id:'job',method:'changes.apply',params:{operationId,plan:{shop,revision,ids:['配置一'],changes}}};
  allowWrite=false;
  await assert.rejects(execute(job),{code:'PERMISSION_REVOKED'});
  assert.deepEqual([writes,lookups],[0,0]);
  job.params.nasRetry=true;
  await assert.rejects(execute(job),{code:'PERMISSION_REVOKED'});
  assert.deepEqual([writes,lookups],[0,1]);
  // 用真实回环 HTTP 计数：显式恢复并开放一次提交，此后关闭权限仍只查这一份回执。
  allowWrite=true;
  assert.equal((await execute(job)).nasSave,'saved');
  assert.deepEqual([writes,lookups],[1,2]);
  receiptAvailable=true;allowWrite=false;
  assert.deepEqual((await execute(job)).receipt,receipt);
  assert.deepEqual([writes,lookups],[1,3]);
});
