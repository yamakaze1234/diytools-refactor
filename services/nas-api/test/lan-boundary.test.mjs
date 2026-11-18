// 不启动打包服务；验证内网来源与旧回环诊断边界。
import test from 'node:test';
import assert from 'node:assert/strict';
import {request} from 'node:http';
import {lanAllowed,serve} from '../src/http.mjs';
import {settings} from '../src/config.mjs';

test('实际 TCP 来源仅允许指定局域网，兼容 IPv4 映射地址',()=>{
 const check=lanAllowed('192.168.50.0',24);
 for(const address of ['192.168.50.1','192.168.50.184','::ffff:192.168.50.254'])assert.equal(check(address),true);
 for(const address of ['192.168.51.2','26.1.2.3','127.0.0.1','::1','203.0.113.1','192.168.50.8, 203.0.113.2'])assert.equal(check(address),false);
});

test('宿主网络拒绝让明文离开回环或将 TLS 绑定到其它网段',()=>{
 const base={AUTH_ORIGIN:'https://accounts.example',WORKSPACE_ID:'example',PGDATABASE:'diy_workbench_trial',
  PGUSER:'diy_api_operations',PGPASSWORD:'test-only',PORT:'18080',NAS_TLS_PORT:'18443',NAS_TLS_LAN_CIDR:'192.168.50.0/24',
  NAS_TLS_CERT_FILE:'deliberately-not-opened-cert.pem',NAS_TLS_KEY_FILE:'deliberately-not-opened-key.pem'};
 assert.throws(()=>settings({...base,LISTEN_HOST:'0.0.0.0',NAS_TLS_LISTEN_HOST:'192.168.50.10'}),/INVALID_LAN_TLS_BIND/);
 assert.throws(()=>settings({...base,LISTEN_HOST:'127.0.0.1',NAS_TLS_LISTEN_HOST:'192.168.51.10'}),/INVALID_LAN_TLS_BIND/);
});

test('启用 HTTPS 时旧 HTTP 入口只提供无凭据健康检查',async()=>{
 let authCalls=0;
 const server=serve({store:{},authenticate:()=>{authCalls++;}},null,{healthOnly:true});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 function call(path){
  return new Promise((resolve,reject)=>{
   const req=request({hostname:'127.0.0.1',port:server.address().port,path},response=>{
    response.resume();response.on('end',()=>resolve(response.statusCode));
   });
   req.on('error',reject);req.end();
  });
 }
 try{assert.equal(await call('/healthz'),200);assert.equal(await call('/api/v1/me'),404);assert.equal(authCalls,0);}
 finally{await new Promise(resolve=>server.close(resolve));}
});
