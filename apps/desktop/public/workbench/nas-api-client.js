/** NAS 接口客户端：桌面经原生桥接，浏览器的显式调用方提供当前令牌。 */
export class NasApiError extends Error{
 constructor(code,status=0,details=null){super(code);this.name='NasApiError';this.code=code;this.status=status;this.details=details;}
}

// 固定三个正式店铺；旧正式与试验接口只在没有新能力表时沿用英特尔合同。
export const nasShopIds=Object.freeze(['intel','gigabyte','jonsbo']);
export function nasOperationsCapability(me,shop){
 if(!nasShopIds.includes(shop)||!Array.isArray(me?.shops)||!me.shops.some(row=>row?.shop_id===shop&&row.role==='operations'))return null;
 if(me.shop_capabilities!==undefined){
  const entry=Object.hasOwn(me.shop_capabilities||{},shop)?me.shop_capabilities[shop]:null;
  return entry?.data_source===shop+'_live'?entry:null;
 }
 return shop==='intel'&&me.data_source==='intel_live'?me:null;
}

// 仅由用户点“重试原提交”调用。404 不意味着未提交：原请求仍可能在途，必须由服务用同编号去重。
export const receiptNotFound=error=>error?.status===404&&error.code==='NOT_FOUND';
export const receiptLookupError=error=>receiptNotFound(error)?new NasApiError('RECEIPT_NOT_FOUND',404):error;
// 重放时鉴权、权限或临时失败不能证明原请求未落库；只有不可通过的原版本条件可结束此次尝试。
export const originalVersionRejected=error=>error?.status===409&&error.code==='VERSION_CONFLICT';
// 这些受限接口在写入前检查安装条件，事务已回滚；其它5xx仍视为提交结果未知。
export const migrationNotInstalled=error=>error?.status===503&&['NAS_GLOBAL_TAX_NOT_INSTALLED','NAS_GLOBAL_UPGRADE_NOT_INSTALLED'].includes(error.code);

/** 每次请求读取当前登录令牌；禁止自动重试，避免未来写请求出现重复提交。 */
export function createNasApiClient({baseUrl,getToken,fetchImpl=globalThis.fetch,timeoutMs=15000,nativeRequest,shopId='intel'}){
 if(!nasShopIds.includes(shopId))throw new NasApiError('INVALID_SHOP');
 const native=typeof nativeRequest==='function';
 let base;
 if(!native){
  try{base=new URL(baseUrl);}catch{throw new NasApiError('INVALID_API_URL');}
  if(base.protocol!=='https:'||base.username||base.password||base.search||base.hash)throw new NasApiError('INVALID_API_URL');
  if(typeof getToken!=='function'||typeof fetchImpl!=='function')throw new NasApiError('INVALID_CLIENT_OPTIONS');
  base.pathname=base.pathname.replace(/\/+$/,'')+'/';
 }
 if(!Number.isInteger(timeoutMs)||timeoutMs<1)throw new NasApiError('INVALID_CLIENT_OPTIONS');
 let identityHeader=null;
 const segment=value=>{
  if(typeof value!=='string'||!value||value.length>256||/[\x00-\x1f]/.test(value)||value==='.'||value==='..')throw new NasApiError('INVALID_IDENTIFIER');
  return encodeURIComponent(value);
 };
 const request=async(path,parameters={},method='GET',data)=>{
  const headers={};
  if(native&&identityHeader&&path!=='me')headers['x-workbench-nas-owner']=identityHeader;
  if(!native){
   const token=await getToken();
   if(typeof token!=='string'||!token||/[\r\n]/.test(token))throw new NasApiError('UNAUTHENTICATED',401);
   headers.authorization='Bearer '+token;
  }
  const search=new URLSearchParams();
  for(const [key,value] of Object.entries(parameters))if(value!==undefined)search.set(key,String(value));
  const route=(path==='native-upload'?'upload':'api/v1/'+path)+(search.size?'?'+search:'');
  const options={method,headers,redirect:'error',cache:'no-store'};
  if(data!==undefined){headers['content-type']='application/json';options.body=JSON.stringify(data);}
  const write=method!=='GET';
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),timeoutMs);
  try{
   // 拒绝重定向，避免服务器重定向到其他地址时暴露原账号令牌。
   const response=await (native?nativeRequest('/'+route,{...options,signal:controller.signal}):fetchImpl(new URL(route,base),{...options,signal:controller.signal}));
   const body=await response.json();
   if(!response.ok||body?.ok!==true){
    const code=typeof body?.error==='string'&&/^[A-Z_]{1,64}$/.test(body.error)?body.error:'INVALID_API_RESPONSE';
    if(write&&!migrationNotInstalled({code,status:response.status})&&(response.status>=500||(response.ok&&body?.ok!==true)))throw new NasApiError('SAVE_STATUS_UNKNOWN',response.status);
    throw new NasApiError(code,response.status,body?.details||null);
   }
   return body;
  }catch(error){
   if(error instanceof NasApiError)throw error;
   throw new NasApiError(write?'SAVE_STATUS_UNKNOWN':controller.signal.aborted?'REQUEST_TIMEOUT':'NETWORK_OR_RESPONSE_ERROR');
  }finally{clearTimeout(timer);}
 };
 const scope=(role,shop)=>{
  if(!['operations','sales'].includes(role))throw new NasApiError('INVALID_ROLE');
  segment(shop);
  return {path:role+'/configurations',parameters:{shop_id:shop}};
 };
 return {
  bindIdentity(workspace,uid){
   if(!native)return;
   segment(workspace);segment(uid);
   identityHeader=encodeURIComponent(JSON.stringify([workspace,uid]));
  },
  me:()=>request('me'),
  async workspaceIndex(){return (await request('operations/workspace-index',{shop_id:shopId})).data;},
  async workspaceCatalog(){return (await request('operations/workspace-catalog',{shop_id:shopId})).data;},
  async workspaceWrite(kind,body){
   if(!['configurations','costs','settings','quotations'].includes(kind))throw new NasApiError('INVALID_RESOURCE');
   return (await request('operations/workspace/'+kind,{shop_id:shopId},'POST',body)).data;
  },
  async workspaceReceipt(op){return (await request('operations/workspace/receipts/'+segment(op),{shop_id:shopId})).data;},
  async quotation(id){return (await request('operations/workspace/quotations/'+segment(id),{shop_id:shopId})).data;},
  async activity(){return (await request('operations/workspace/activity',{shop_id:shopId})).data;},
  async activityPage({page,pageSize,from,to}){
   return (await request('operations/workspace/activity',{shop_id:shopId,page,page_size:pageSize,from:from||undefined,to:to||undefined})).data;
  },
  async profit(action,body){
   if(!['start','status','history','reset'].includes(action))throw new NasApiError('INVALID_ACTION');
   return (await request('operations/workspace/profit/'+action,{shop_id:shopId},'POST',body)).data;
  },
  async sourceUsage(sources,goods){return (await request('operations/workspace/source-usage',{shop_id:shopId},'POST',{sources,goods})).data;},
  async priceHistory(action,body){
   if(!['list','detail','day','handle'].includes(action))throw new NasApiError('INVALID_ACTION');
   return (await request('operations/workspace/price-history/'+action,{shop_id:shopId},'POST',body)).data;
  },
  async importPreview(images){return (await request('operations/workspace/import-preview',{shop_id:shopId},'POST',{images})).data;},
  async catalog(kind,id=null){
   if(!['sources','addons','gallery','templates','shared-sources'].includes(kind))throw new NasApiError('INVALID_RESOURCE');
   return (await request('operations/catalog/'+kind+(id?'/'+segment(id):''),{shop_id:shopId})).data;
  },
  async saveCatalog(kind,id,action,body){
   if(!['sources','addons','gallery','templates','shared-sources'].includes(kind)||!['create','replace','archive','restore','copy','apply'].includes(action))throw new NasApiError('INVALID_ACTION');
   const leaf=action==='create'?'':'/'+segment(id)+(action==='replace'?'':'/'+action);
   return (await request('operations/catalog/'+kind+leaf,{shop_id:shopId},action==='replace'?'PUT':'POST',body)).data;
  },
  async catalogReceipt(operationId){return (await request('operations/catalog/receipts/'+segment(operationId),{shop_id:shopId})).data;},
  async uploadImage(data){
   if(!native)throw new NasApiError('IMAGE_UPLOAD_DISABLED',405);
   return (await request('native-upload',{},'POST',{...data,shopId})).data;
  },
  async list({shop=shopId,role='operations',limit=50,offset=0,search='',archived=false}={}){
   if(!Number.isInteger(limit)||limit<1||limit>100||!Number.isInteger(offset)||offset<0||offset>1000000||typeof search!=='string'||search.length>200)throw new NasApiError('INVALID_QUERY');
   const {path,parameters}=scope(role,shop);
   return (await request(path,{...parameters,limit,offset,search,archived:archived?true:undefined})).data;
  },
  async detail(id,{shop=shopId,role='operations',archived=false}={}){
   const {path,parameters}=scope(role,shop);
   return (await request(path+'/'+segment(id),{...parameters,archived:archived?true:undefined})).data;
  },
  async addons(id,{shop=shopId,role='operations'}={}){
   const {path,parameters}=scope(role,shop);
   return (await request(path+'/'+segment(id)+'/addons',parameters)).data;
  },
  async save(action,id,body,{shop=shopId}={}){
   const {path,parameters}=scope('operations',shop);
   if(!['create','replace','design','archive','restore'].includes(action))throw new NasApiError('INVALID_ACTION');
   const suffix=action==='create'?'':'/'+segment(id)+(['design','archive','restore'].includes(action)?'/'+action:'');
   return (await request(path+suffix,parameters,['replace','design'].includes(action)?'PUT':'POST',body)).data;
  },
  async receipt(operationId,{shop=shopId}={}){
   return (await request('operations/save-receipts/'+segment(operationId),{shop_id:shop})).data;
  },
  async resource(kind,id,{shop=shopId}={}){
   if(!['sources','costs','templates','gallery'].includes(kind))throw new NasApiError('INVALID_RESOURCE');
   return (await request('operations/'+kind+'/'+segment(id),{shop_id:shop})).data;
  },
 };
}
