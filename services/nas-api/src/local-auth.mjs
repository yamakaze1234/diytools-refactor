// 只使用 NAS 数据库验证会话。访问令牌和续期令牌分别保存 SHA-256 摘要。
import {createHash,randomBytes,scrypt as derive,timingSafeEqual} from 'node:crypto';
import {promisify} from 'node:util';
import {Fault,requireValue} from './config.mjs';
import {authenticateLegacyPassword} from './auth.mjs';

const scrypt=promisify(derive);
const scryptOptions={N:32768,r:8,p:3,maxmem:64*1024*1024};
const accessSeconds=2*60*60;
const fakeSalt=randomBytes(16);
const token=(prefix)=>prefix+randomBytes(32).toString('base64url');
const digest=value=>createHash('sha256').update(value).digest();
const validAccess=value=>typeof value==='string'&&/^nasa_[A-Za-z0-9_-]{43}$/.test(value);
const validRefresh=value=>typeof value==='string'&&/^nasr_[A-Za-z0-9_-]{43}$/.test(value);
const denied=()=>new Fault('UNAUTHENTICATED',401);

export function normalizeUsername(value){
 requireValue(typeof value==='string'&&value.trim()&&Buffer.byteLength(value.trim())<=192&&!/[\x00-\x1f\x7f]/.test(value));
 return value.trim().toLowerCase();
}
function validPassword(value){
 requireValue(typeof value==='string'&&Buffer.byteLength(value)>0&&Buffer.byteLength(value)<=4096);
}

export async function hashPassword(password,salt=randomBytes(16)){
 validPassword(password);
 return {salt,hash:await scrypt(password,salt,32,scryptOptions)};
}

async function matchesPassword(account,password){
 const {hash}=await hashPassword(password,account?.password_salt??fakeSalt);
 return Boolean(account?.enabled&&timingSafeEqual(hash,account.password_hash));
}

function loginLimiter(now){
 const windowMs=60000,windows=new Map();
 return (source,key)=>{
  const time=now();
  for(const [item,bucket] of windows)if(bucket.until<=time)windows.delete(item);
  for(const [name,limit] of [[JSON.stringify([source]),60],[JSON.stringify([source,key]),8]]){
   if(!windows.has(name)){
    requireValue(windows.size<4096,'AUTH_RATE_LIMITED',429);
    windows.set(name,{until:time+windowMs,count:0});
   }
   requireValue(++windows.get(name).count<=limit,'AUTH_RATE_LIMITED',429);
  }
 };
}

export function createLocalAuth(db,config,{legacy=authenticateLegacyPassword,now=Date.now}={}){
 const limit=loginLimiter(now);
 let activeLogins=0;
 const accountFor=async username=>(await db.query(`
   SELECT a.uid,a.password_salt,a.password_hash,m.enabled
   FROM nas_auth.accounts a JOIN nas_auth.members m USING(workspace_id,uid)
   WHERE a.workspace_id=$1 AND a.username_key=$2`,[config.workspace,username])).rows[0];

 async function enroll(username,key,password){
  // 过渡期只迁还没有本地凭据的 UID。原服务核验过的身份仍须存在于本地成员表。
  const member=await legacy(config,username,password);
  const {salt,hash}=await hashPassword(password);
  const {rows:[account]}=await db.query(`
   INSERT INTO nas_auth.accounts(workspace_id,uid,username_key,member_id,display_name,password_salt,password_hash)
   SELECT workspace_id,uid,$3,$4,$5,$6,$7 FROM nas_auth.members
   WHERE workspace_id=$1 AND uid=$2 AND enabled
   ON CONFLICT DO NOTHING RETURNING uid,password_hash`,
  [config.workspace,member.uid,key,member.memberId,member.name,salt,hash]);
  if(account)return account;
  // 两台设备同时登记同一原账号时，后到者可使用已登记的原密码登录。
  const existing=await accountFor(key);
  if(existing?.uid!==member.uid||!await matchesPassword(existing,password))throw denied();
  return existing;
 }

 async function issue(account){
  const access=token('nasa_'),refresh=token('nasr_');
  const {rows:[session]}=await db.query(`
   INSERT INTO nas_auth.sessions(workspace_id,uid,access_hash,refresh_hash,credential_salt,access_until,refresh_until)
   SELECT a.workspace_id,a.uid,$3,$4,a.password_salt,now()+interval '2 hours',now()+interval '30 days'
   FROM nas_auth.accounts a JOIN nas_auth.members m USING(workspace_id,uid)
   WHERE a.workspace_id=$1 AND a.uid=$2 AND m.enabled AND a.password_hash=$5 RETURNING uid`,
  [config.workspace,account.uid,digest(access),digest(refresh),account.password_hash]);
  if(!session)throw denied();
  // 正常登录时收拢该成员已过期的设备会话，保留仍有效的其他设备。
  await db.query('DELETE FROM nas_auth.sessions WHERE workspace_id=$1 AND uid=$2 AND refresh_until<=now()',
   [config.workspace,account.uid]);
  return {token_type:'Bearer',access_token:access,refresh_token:refresh,sub:session.uid,expires_in:accessSeconds};
 }

 async function login(body,source){
  const key=normalizeUsername(body?.username),password=body.password;
  validPassword(password);
  limit(source,key);
  requireValue(activeLogins<2,'AUTH_RATE_LIMITED',429);
  ++activeLogins;
  try{
   let account=await accountFor(key);
   if(!account&&config.authMode==='migration')account=await enroll(body.username.trim(),key,password);
   else if(!await matchesPassword(account,password))throw denied();
   return await issue(account);
  }finally{--activeLogins;}
 }

 async function refresh(body){
  const refresh=body?.refresh_token;
  requireValue(validRefresh(refresh)&&body.grant_type==='refresh_token','UNAUTHENTICATED',401);
  const access=token('nasa_'),next=token('nasr_');
  // 原续期凭据只能消费一次。上一次摘要只可用于退出时撤销同时轮换的会话。
  const {rows:[result]}=await db.query(`
   UPDATE nas_auth.sessions s SET previous_refresh_hash=s.refresh_hash,
     refresh_hash=$3,access_hash=$4,access_until=now()+interval '2 hours'
   FROM nas_auth.accounts a JOIN nas_auth.members m USING(workspace_id,uid)
   WHERE s.workspace_id=$1 AND s.refresh_hash=$2 AND s.refresh_until>now()
     AND a.workspace_id=s.workspace_id AND a.uid=s.uid AND a.password_salt=s.credential_salt AND m.enabled RETURNING s.uid`,
  [config.workspace,digest(refresh),digest(next),digest(access)]);
  if(!result)throw denied();
  return {token_type:'Bearer',access_token:access,refresh_token:next,sub:result.uid,expires_in:accessSeconds};
 }

 async function logout(body){
  const refresh=body?.refresh_token;
  requireValue(validRefresh(refresh),'UNAUTHENTICATED',401);
  await db.query(`
   DELETE FROM nas_auth.sessions
   WHERE workspace_id=$1 AND (refresh_hash=$2 OR previous_refresh_hash=$2)`,
  [config.workspace,digest(refresh)]);
  return {};
 }

 async function authenticate(header){
  const access=typeof header==='string'?header.slice(7):null;
  requireValue(typeof header==='string'&&header.startsWith('Bearer ')&&validAccess(access),'UNAUTHENTICATED',401);
  const {rows:[member]}=await db.query(`
   SELECT s.uid,s.workspace_id AS "workspaceId",a.member_id AS "memberId",a.display_name AS name
   FROM nas_auth.sessions s JOIN nas_auth.accounts a USING(workspace_id,uid)
   JOIN nas_auth.members m USING(workspace_id,uid)
   WHERE s.workspace_id=$1 AND s.access_hash=$2 AND s.access_until>now() AND s.refresh_until>now()
    AND a.password_salt=s.credential_salt AND m.enabled`,
  [config.workspace,digest(access)]);
  if(!member)throw denied();
  return member;
 }
 return {authenticate,login,refresh,logout};
}
