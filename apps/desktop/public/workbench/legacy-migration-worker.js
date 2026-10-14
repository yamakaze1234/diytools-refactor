/** 在独立线程复用共享投影；不读取目录、凭据或网络。 */
import {buildLegacyMigrationPlan} from './legacy-migration-plan.js';
self.onmessage = event => {
  try { self.postMessage({ok:true,plan:buildLegacyMigrationPlan(event.data)}); }
  catch(error) { self.postMessage({ok:false,error:error instanceof Error?error.message:'旧版资料核对失败，请重新选择目录。'}); }
};
