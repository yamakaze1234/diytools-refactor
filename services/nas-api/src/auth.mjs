// 身份权威来自原工作台session.get，不在NAS保存密码或解析JWT后直接放行。
import {createHash,randomUUID} from 'node:crypto';
import {Fault,requireValue} from './config.mjs';
async function authJson(response){
 const reader=response.body.getReader();let size=0;const parts=[];
 for(;;){
  const {done,value}=await reader.read();if(done)break;
  size+=value.length;
  if(size>32768){await reader.cancel();throw new Fault('AUTH_UNAVAILABLE',503);}
  parts.push(Buffer.from(value));
 }
 return JSON.parse(Buffer.concat(parts).toString('utf8'));
}
export function createAuth(config,{fetchImpl=fetch,now=Date.now}={}){
 const cache=new Map();
 return async function authenticate(header,{fresh=false}={}){
  requireValue(typeof header==='string'&&/^Bearer [^\s]{1,4096}$/.test(header),'UNAUTHENTICATED',401);
  const token=header.slice(7),key=createHash('sha256').update(token).digest('hex');
  const old=cache.get(key);if(!fresh&&old&&old.until>now())return {...old.member};
  if(fresh)cache.delete(key);
  let response,body;
  try{
   response=await fetchImpl(config.authOrigin+'/v1/functions/workbenchApi',{method:'POST',redirect:'error',signal:AbortSignal.timeout(8000),headers:{'content-type':'application/json',authorization:header},body:JSON.stringify({protocolVersion:2,action:'session.get',requestId:randomUUID(),payload:{},accessToken:token})});
   if(response.status===401||response.status===403)throw new Fault('UNAUTHENTICATED',401);
   if(!response.ok)throw new Fault('AUTH_UNAVAILABLE',503);
   body=await authJson(response);
  }catch(e){if(e instanceof Fault)throw e;throw new Fault('AUTH_UNAVAILABLE',503);}
  const valid=s=>typeof s==='string'&&s.length>0&&s.length<=256&&!/[\x00-\x1f]/.test(s);
  requireValue(body.ok===true&&valid(body.uid)&&valid(body.workspaceId)&&!body.isAnonymous&&!body.is_anonymous&&!body.anonymous,'UNAUTHENTICATED',401);
  requireValue(body.workspaceId===config.workspace,'FORBIDDEN',403);
  const member={uid:body.uid,workspaceId:body.workspaceId,memberId:valid(body.memberId)?body.memberId:body.uid,name:valid(body.name)?body.name:''};
  // 最多短暂缓存30秒，停用生效延迟有上限；过期后上游故障不延长授权。
  let ttl=config.sessionCacheMs??30000;
  try{const claims=JSON.parse(Buffer.from(token.split('.')[1],'base64url'));if(Number.isFinite(claims.exp))ttl=Math.min(ttl,claims.exp*1000-now());}catch{}
  if(ttl>0){if(cache.size>=256)cache.delete(cache.keys().next().value);cache.set(key,{member,until:now()+ttl});}
  return {...member};
 };
}

// 只在迁移模式为尚未登记的成员验证一次原密码，旧令牌留在本次请求内。
export async function authenticateLegacyPassword(config,username,password,{fetchImpl=fetch}={}){
 let body;
 try{
  const response=await fetchImpl(config.authOrigin+'/auth/v1/signin',{method:'POST',redirect:'error',signal:AbortSignal.timeout(8000),
   headers:{'content-type':'application/json','x-device-id':randomUUID()},body:JSON.stringify({username,password})});
  if([400,401,403].includes(response.status))throw new Fault('UNAUTHENTICATED',401);
  if(!response.ok)throw new Fault('AUTH_UNAVAILABLE',503);
  body=await authJson(response);
 }catch(error){if(error instanceof Fault)throw error;throw new Fault('AUTH_UNAVAILABLE',503);}
 requireValue(body?.token_type==='Bearer'&&typeof body.access_token==='string'&&typeof body.sub==='string','UNAUTHENTICATED',401);
 const member=await createAuth(config,{fetchImpl})('Bearer '+body.access_token,{fresh:true});
 requireValue(member.uid===body.sub,'UNAUTHENTICATED',401);
 return member;
}
