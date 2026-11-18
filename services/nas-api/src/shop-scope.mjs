// 请求只能选择已注册的店，不会将店铺参数拼到 SQL、磁盘路径或凭据变量里。
const scopes={
 intel:Object.freeze({shopId:'intel',dataSchema:'intel_live',accessSchema:'intel_access',writeLock:76}),
 gigabyte:Object.freeze({shopId:'gigabyte',dataSchema:'gigabyte_live',accessSchema:'gigabyte_access',writeLock:77,
  envPrefix:'NAS_GIGABYTE_',role:'diy_api_gigabyte_production'}),
 jonsbo:Object.freeze({shopId:'jonsbo',dataSchema:'jonsbo_live',accessSchema:'jonsbo_access',writeLock:78,
  envPrefix:'NAS_JONSBO_',role:'diy_api_jonsbo_production'})
};
export const liveScopes=Object.freeze(scopes);

export function scopedDatabase(pool,shopId,{groupAccess=true}={}){
 if(!Object.hasOwn(scopes,shopId))throw Error('unsupported shop scope');
 const scope=scopes[shopId],access=groupAccess?scope.accessSchema:'nas_business';
 if(!groupAccess&&shopId!=='intel')throw Error('shop requires separate access scope');
 // 重用原查询模板，只替换代码中写死的命名区前缀（包括 GUC 和 regprocedure）。
 // 来自 HTTP 的条件、文档和商家主键始终通过 PG 参数传递。
 const query=(target,sql,args)=>{
  const statement=sql.replace(/\bintel_live\./g,scope.dataSchema+'.').replace(/\bnas_business\./g,access+'.');
  return target.query(statement,args);
 };
 return {
  query:(sql,args)=>query(pool,sql,args),
  async connect(){
   const db=await pool.connect();
   return {query:(sql,args)=>query(db,sql,args),release:()=>db.release()};
  }
 };
}

// 同店的不同写路径复用相同锁，其他店的同名 ID 不会争用该锁。
export function shopLock(db,shopId,seed,key){
 return db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,$2))',
  [shopId==='intel'?key:JSON.stringify([shopId,key]),seed]);
}
