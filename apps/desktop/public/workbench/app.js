import {mountConfigRecycle} from './recycle-bin-ui.js';
import {commonOverviewFeeRate,overviewFeeRate,readOverviewFeeRate} from './overview-table-model.js';
import {matchingSnapshot,erpMatchingRequest} from './erp-matching-model.js';
import {shopErpExtras} from './erp-default-extras.js';
import {createErpMatchingUi} from './erp-matching-ui.js';
let erpMatching=null;
import {shopSettingsHtml,bindShopSettings} from './shop-settings-ui.js';
import {mountPriceProfit,pricingRuleFields,readPricingRuleFields} from './price-profit-ui.js';
import {installNasWorkspace} from './nas-workspace-ui.js';
import {createNasMainWorkspace,nasMainMode,nasErrorText,nasTimeStamp,projectNasEdits,sameNasDocument,submitNasDraftSet,visibleNasAddons} from './nas-main-workspace.js';
import {createNasUpdateHint,watchNasUpdates} from './nas-update-hint.js';
import {applyNasRenumber} from './nas-renumber-receipt.js';
import {nasConfigConflictHtml} from './nas-conflict-view.js';
import {buildNasOperationPlan,acknowledgeNasPriceDraft} from './nas-operation-plan.js';
import {prepareLegacyNasImport} from './nas-legacy-import.js';
import {createSharedSourcePreview} from './nas-shared-source-preview.js';
import {withCurrentSharedSource} from './shared-source-fields.js';
import {visibleNasCosts} from './nas-cost-overlay.js';
import {posterExtraRows,posterAddonCopyRows,editPosterExtra,addPosterExtra,removePosterAddonCopy,removePosterExtra,setPosterExtraVisible} from './config-extras.js';
import {addonPackInputs,addonPackRows} from './link-addon-packs.js';
import {createAddonPackDrafts,describeAddonDrafts,mergeAddonPackDrafts} from './link-addon-drafts.js';
import {mountAddonBenefits,mountAddonPackEditor,openAddonPackMaintenance} from './link-addon-pack-ui.js';
import {createNasErpUiAdapter,lookupNasSourceProduct} from './nas-erp-ui-adapter.js';
import {createNasAutosave} from './nas-autosave.js';
import {erpCatalogIndex,latestErpName,searchErpParts,splitErpName} from './erp-part-description.js';
import {openSourceSheet} from './source-sheet-ui.js';
import {localDeletedSources,changeLocalDeletedSources,deletedSourceUses,historyReferencesDeletedSource} from './source-sheet-model.js';
import {erpCategoryFields,validateSnapshot as validateErpSnapshot} from './erp-sync.js';
import {createNasDraftStorage} from './nas-draft-storage.js';
const nasMain=nasMainMode(location.search);
const configDraftStorage=globalThis.indexedDB?createNasDraftStorage({legacyStorage:localStorage}):null;
const nasUpdateHint=nasMain?createNasUpdateHint():null;
let stopNasUpdateWatch=null,nasPollDue=false;
const nasWorkspace=nasMain?createNasMainWorkspace({nativeRequest:(path,options)=>fetch('/api/native-nas'+path,options),storage:localStorage,
 onSaved:receipt=>{nasUpdateHint.saved(receipt);scheduleNasDataTime();},
 draftStorage:configDraftStorage,onDraftStorageError:reportDraftWrite,requestedShop:new URLSearchParams(location.search).get('nas_shop')}):null;
async function flushConfigDrafts(){
 try{if(nasWorkspace)await nasWorkspace.flushDrafts();else await configDraftStorage?.flush();}
 catch(error){throw Error(nasErrorText(error));}
}
let nasBusy=false,nasDraftFailure=null,nasSaveSummary=null;
let nasDataTime={updatedAt:null,firstImport:false,state:'checking'},nasDataTimeGeneration=0,nasDataTimeTimer;
let nasAutosave;
import {planIdEdit} from './price-profit-model.js';
import {skuImageMode,skuImageConfig,applySkuImageMode} from './sku-image-mode.js';
import {partHardwareWarning,addonHardwareWarning,hardwareUpgradeSelected,selectHardwareUpgrade,partUpgradeText} from './hardware-upgrade.js';
import './endfield-motion.js';
import {changeActual,changeQuantity,createContinuousWorkbench} from './continuous-workbench.js';
import {taxOverrideLines,taxLineKey} from './tax-override-model.js';
import {createCacheCleanupBridge} from './cache-cleanup.js';
import {resetConfigCost} from './config-cost.js';
let continuousWorkbench=null;
import {saveConflictHtml} from './save-conflict-view.js';
import {createAgentWorkflow} from './agent-workflow.js';
import {createNasAgentWorkflow} from './nas-agent-workflow.js';
import {lockAgentEditor} from './agent-editor-lock.js';
import {openWpsExport} from './wps-export.js';
// 批量图片任务在弹窗之外保留进度与失败项。
import {startImageExportTask} from './image-export-tasks.js';
import {createReactWorkbenchAdapter} from './react-adapter.js';
import {editorModel} from './react-editor-model.js';
import {profitTone} from './profit-tone.js';
// 仅迁移节点所有权，继续调用同一业务 state 与检查点。
const reactWorkbench=createReactWorkbenchAdapter(window.parent,document);
// 工作台页面编排入口：草稿、原始保存基线和只读列表摘要分开管理，所有保存均保留并发保护。
import {createLazyWorkspace,markPartialWorkspace,assertLoadedChanges,completeWorkspaceViews} from './lazy-workspace.js';
import {planCompactRefresh,sameWorkspaceMetadata} from './compact-refresh.js';
import {renderPreviewPoster} from './preview-resolution.js';
import {syncPosterShortName} from './short-name-poster.js';
import {batchRevertPlan,captureBatchRevert,confirmBatchRevert} from './batch-revert.js';
import {createPosterRenderGate} from './poster-render-gate.js';
import {mountWorkspaceResize} from './workspace-resize.js';
import {mountPreviewNavigation} from './preview-navigation.js';
import {markSourceFieldManual} from './source-follow.js';
import {POSTER_FONTS,posterFontFamily} from './poster-fonts.js';
import {openBatchConfigCost} from './batch-config-cost.js';
import {configCostCell,bindConfigCosts,hasConfigCost,configCostNote,updateLinkConfigCosts} from './config-cost.js';
// 桌面工作台编辑入口：state 是当前草稿，acceptedState 是服务端已确认基线。
// save/ordinaryPending 以请求快照和 operationId 保护并发输入、重试与撤销；派生状态另行轮询。
import {linkCardHeading,bindLinkCardMenus,closeLinkCardMenu,cardDisplayColor} from './link-card.js';
import {mountPartSort} from './part-sort.js';
import {bindModuleDrag} from './module-drag.js';
import {bindConfigDrag,moveConfig} from './config-drag.js';
import {moveLink,linkOrderValues,duplicateLinkConfigs,bindLinkDrag} from './link-order.js';
import {insertConfigAfter,planConfigRenumber,applyConfigRenumber,configAfterRemoval} from './config-order.js';
import './font-choice.js';
import {bindScrollPreview,syncScrollHighlight} from './scroll-spy.js';
import {openBatchProfitPrice} from './batch-profit-price.js';
import {createNasOverviewActions} from './nas-overview-actions.js';
import {applyStructuredUpgrade,upgradeAddonSummary} from './upgrade-addon-sync.js';
import {detachAddonFollow} from './addon-data.js';
import {applyPosterView} from './poster-view.js';
import {configCapacityMessage} from './config-capacity.js';
import {mountProductSearch,destroyProductSearch} from './product-search.js';
import {uploadImage as uploadImageFile,readImageFile} from './image-upload.js';
import {rememberImage,clearImageCache} from './image-cache.js';
import {normalizePosterDesign,posterEditorConfig} from './poster-design.js';
import {openStandardProduct} from './product-standard-ui.js';
import {applyStandardProduct,standardId} from './product-standard.js';
import {componentStockView} from './component-stock-view.js';
import {DEFAULT_SERVICE_TEXT,defaultServiceText,saveServiceDefault} from './service-promises.js';
import {actualParts,ensureActualParts} from './actual-parts.js';
import {syncDisplayParts,cloneEditorState,captureEditorState,withoutActivityLogs,mergeEditorState,prepareSavedReceipt,applySavedReceiptDraft,captureHistorySnapshot,captureWorkspaceHistorySnapshot,rebaseWorkspaceHistorySnapshot,captureConfigHistorySnapshot,isConfigHistorySnapshot,compactConfigHistory,sameHistorySnapshot,restoreHistorySnapshot,rebaseHistorySnapshot,historySnapshotBytes} from './editor-performance.js';
import {prepareWorkspaceState} from './workspace-state-apply.js';
import {createSourceIndex} from './component-index.js';
import {saveFullState} from './full-save.js';
import {invalidateSaveScope,declareSaveScope,changeSaveScope,transferSaveScope,captureSaveSnapshot,saveSnapshotIds,acknowledgeSaveScope,sameCapturedBusinessState,unsupportedSaveRootChanges} from './scoped-save.js';
const displayBaseline=new Map();
// 记录展示配件基线，后续编辑只把实际发生变化的展示字段同步到 BOM。
function rememberDisplayParts(ids=null){if(ids===null)invalidateSaveScope(state,'whole display baseline normalization');const targets=ids===null?null:new Set(ids);if(!targets)displayBaseline.clear();for(const c of state.configs){if(targets&&!targets.has(c.id))continue;ensureActualParts(c);displayBaseline.set(c.id,clone(c.parts));}}
// 按指定配置同步展示和实际配件，避免普通编辑扫描全部配置。
function syncDisplayEdits(ids=null){syncDisplayParts(state.configs,displayBaseline,ids);}
import {openLinkParts} from './link-parts.js';
import {validateBatchSources,ordinarySaveChanges} from './batch-save.js';
import {inventoryLinks} from './inventory-export.js';
import {openInventoryCheck} from './inventory-check-ui.js';
import {openPriceChanges} from './price-changes-ui.js';
import {nasPriceHistory} from './nas-price-history.js';
import {validateStockReplacement} from './inventory-check-data.js';
import {isSpecialComponent} from './special-components.js';
import {copyPartPayload,pastePartPayload,overviewProfits} from "./part-transfer.js";
let copiedPart=null,previewNavigation;
import {doubleMemoryUpgrade,displayUpgrade,memoryUpgradeKey} from './memory-upgrade.js';
import {openActivity} from './activity-ui.js';
window.workbenchBeforeQuit=async()=>{if(erpMatching&&!await erpMatching.confirmClose())throw Error("已取消关闭，ERP 匹配继续运行。");if(hostTemplateHasDrafts())throw Error('请先保存主机模板或恢复到已保存版本。');if(window.workbenchSourceEditor?.sheet&&window.workbenchSourceEditor.hasPending())throw Error('请先处理输出源工作表的未保存修改。');await flushConfigDrafts();if(nasMain){if(exportJobs)throw Error('请等待图片导出完成再更新或关闭');if(nasBusy)throw Error('请等 NAS 保存或回执查询结束再关闭');if(nasDraftFailure)throw Error(nasErrorText(nasDraftFailure));if(addonPackDrafts?.hasFailure())throw Error('有加购草稿未写入本机，请先保存加购包。');if(window.workbenchSourceEditor?.hasPending())throw Error('请先处理输出源窗口中的未提交修改。');return;}await window.workbenchPauseCloud?.();if(window.workbenchSourceEditor?.hasPending())await window.workbenchSourceEditor.save();try{await save();}catch(error){if(!confirm('当前修改尚未正常保存。是否将草稿保存到本机恢复文件后退出？\n下次可从恢复文件找回修改。'))throw error;const result=await request('/api/recovery-draft',{method:'POST',body:JSON.stringify(await recoverySnapshot())});if(!result.ok)throw Error('恢复草稿保存失败');}};
import {applySourceSync,SourceChangeSession} from './source-sync-data.js';
import {followPendingSourcePlan,sourceFollowSummary} from './source-follow.js';
import {changedSourceText,editedSourceTextFields,publishSourceSummary} from './source-diff-alert.js';
import {openSavedAddonDecision} from './source-sync-ui.js';
import {selectableComponents} from './component-policy.js';
import {openAddonEditor,addonStatusHtml} from './addon-ui.js';
import {bindWorkspaceSync} from './workspace-sync-ui.js';
import {mergeEditingState,sameEditingState,sameEditingStateAsync} from './workspace-ui-merge.js';
let acceptedState=null,workspaceSyncUi=null;
import {openInventoryExport} from './inventory-export.js';
import {openCaseGallery} from './case-gallery.js';
import {useGalleryImage,validateGallery} from './case-gallery-data.js';
import {openPriceImport,applyPriceImport} from './price-import.js';
import {mergePriceSaveConflict} from './price-save-merge.js';
import {installColorPicker} from './color-picker.js';
let listPinnedProduct=null;
const collapsedZones=new Set();
// 11-19：侧边栏三个区（草稿区 / 链接区 / 主机模板）当前选中哪个；新建链接就建在选中的区。
let selectedZone=['draft','links','templates'].includes(localStorage.getItem('diy-list-zone'))?localStorage.getItem('diy-list-zone'):'links';
const zoneNames={draft:'草稿区',links:'链接区',templates:'主机模板'};
function selectZone(key){selectedZone=key;localStorage.setItem('diy-list-zone',key);}
// 区标题统一黑底，选中的区黄底；主机模板标题由 React 渲染，这里只补样式。
function paintZones(){
 const on=(el,yes)=>{if(!el)return;el.style.setProperty('background',yes?'#f3f134':'#181a19','important');el.style.setProperty('color',yes?'#181a19':'#fff','important');};
 document.querySelectorAll('[data-zone-toggle]').forEach(b=>on(b,b.dataset.zoneToggle===selectedZone));
 const t=$('#template-section-toggle');
 const sec=t?.closest('.template-library-section');if(sec)['border','padding','background','border-radius','box-shadow'].forEach((k,i)=>sec.style.setProperty(k,['0','0','transparent','0','none'][i],'important'));
 if(t){on(t,selectedZone==='templates');['border-radius','margin','width'].forEach((k,i)=>t.style.setProperty(k,['0','0','100%'][i],'important'));t.classList.add('list-zone-heading','list-zone-templates');const open=t.getAttribute('aria-expanded')==='true',arrow=t.querySelector(':scope > span');if(arrow&&!arrow.classList.contains('zone-arrow')){arrow.classList.add('zone-arrow');}if(arrow)arrow.textContent=open?'▼':'▶';t.querySelectorAll(':scope > *').forEach(x=>{x.style.setProperty('color','inherit','important');x.style.setProperty('background','transparent','important');x.style.setProperty('border-color','transparent','important');});
  }
 const add=$('#new-product');if(add)add.title='新建到：'+zoneNames[selectedZone];
}
// 侧边栏：点开链接时是否同时展开配置列表（本机记忆，默认不展开）。
const expandOnOpen=()=>localStorage.getItem('diy-link-expand-on-open')==='1';
const linkCategoryDefaults=['日常主推链接','24期主机专区','竖装主机专区','无卡主机专区'];
const linkCategories=()=>[...new Set([...linkCategoryDefaults,...available().map(c=>c.productCategory).filter(Boolean)])];
const categoryMatches=c=>!$('#link-category-filter').value||($('#link-category-filter').value==='none'?!c.productCategory:c.productCategory===$('#link-category-filter').value.slice(4));
const listedConfigs=()=>ordinaryConfigs(available()).filter(c=>categoryMatches(c)&&[c.product,c.productUrl,c.spu,c.name,c.shortName,c.skuId,...c.parts.map(p=>p.name)].join(' ').toLowerCase().includes($('#search').value.trim().toLowerCase()));
import {openGlobalBatch,openUpgradeDescriptionBatch,applyReplacement,validateReplacement,exportBatchImages} from './global-batch.js';
import {applyBatchContent} from './batch-content.js';
import {openBatchAppearance} from './batch-appearance.js';
import {INSTALLMENT_TERMS,effectivePricingRule,pricing,pricingColumn,deletedWithinRetention,applyProductInstallment} from './pricing.js';
import {mountWpsImport} from './wps-import.js';
import {bindPosterEditor} from './poster-editor.js';
import {costRows,applyManualCosts} from './erp-sync.js';
import {openCostEditor} from './cost-editor.js';
import {bindErpSync} from './erp-ui.js';
import {setSourceDeleted,sourceCatalog,bindSources,alignDisplaySourceNames,replaceSourcePart,syncSource} from './source.js';
import {openSourceEditor} from './source-editor.js';
import {sourceBatch} from './source-batch.js';
import {liveConfigs,deleteConfigs,restoreConfigs,clone,totals,erpUnitCost,copyText,erpFormula,maintenanceUsesLocator,modulesDefault,posterModules,posterParts,posterPalette,applyPosterStyle,slots,normalizeProducts,productGroups,templateConfigs,productTemplate,importTemplateConfigs,blankConfig} from './core.js';
import {renderPoster as drawPoster,defaultPosterWidth} from './poster.js';
import {makeZip} from './zip.js';
import {numberedImageEntries,imageArchiveName} from './image-export-order.js';
import {saveImageFolder} from './folder-export.js';
import {exportSingleImage} from './single-image-export.js';
import {suggestedName} from './legacy-names.js';
import {configurationHardwareSummary,configurationSummaryText,configurationSummaryHtml} from './configuration-summary.js';
import {mountNameFormatPreview,mountNameFormatEntry,openNameFormatBatch,applyNameFormatPlan,validateNameFormatPlan} from './name-format-batch.js';
import {ordinaryConfigs,legacyTemplateConfigs,isLegacyTemplateConfig,templateConfigLabel,migrateSavedTemplates,editableTemplateLibrary,draftLinkFromTemplate} from './template-library.js';
import {mountTemplateArea,renderTemplateSheet} from './template-area.js';
import {applyTemplateAppearance,editTemplate,gpuSpec,newTemplateDraft,rankedTemplateGpus,templateCatalog,templateDirty,templatePart} from './host-template-model.js';
import {readPartFormulas,savePartFormulas,mountPartFormulaEditor} from './part-export-formulas.js';
import {shops,shopById,shopPalette,shopUpgradeColor,shopServiceColor,applyProductThemes,setProductTheme,applyShopIdentity,normalizeWorkspaceStateAsync,settingsFor,sourcesFor,DEFAULT_ERP_SHOP_IDS} from './shops.js';
const $=s=>document.querySelector(s),$$=s=>[...document.querySelectorAll(s)];
const esc=x=>String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const moneyFormatter=new Intl.NumberFormat('zh-CN',{minimumFractionDigits:0,maximumFractionDigits:0});
const money=x=>moneyFormatter.format(Number(x||0));
const financeMoney=n=>n==null?'—':'¥'+n.toLocaleString('zh-CN',{minimumFractionDigits:2,maximumFractionDigits:2});
let session,operator,state,catalog,baseCatalog,active,activeShopId='intel',tab='parts',selected=new Set(),dirty=false,savePromise=null,batchPromise=null,batchPending=null,ordinaryPending=null,timer,previewToken=0,previewResult,history=[],redoHistory=[],restoringHistory=false,conflict=false,copyKind='parts',pendingImages=new Set(),imageRecords=new Map(),selectedModule='parts',changeCounter=0,posterEditor;
window.workbenchHasPendingChanges=()=>Boolean(configDraftStorage?.hasPendingWrites())||hostTemplateHasDrafts()||(nasMain?Boolean(nasBusy||nasDraftFailure||addonPackDrafts?.hasFailure()||window.workbenchSourceEditor?.hasPending()):Boolean(dirty||savePromise||batchPromise||batchPending||ordinaryPending||window.workbenchSourceEditor?.hasPending()));
window.workbenchGetSnapshot=async()=>(await recoverySnapshot()).state;
// 缓存入口必须检查已经落盘的 NAS 草稿，退出前检查并不涵盖这些草稿。
const cacheCleanup=createCacheCleanupBridge({
 flush:async()=>{
  if(!window.workbenchReady)throw Error('工作台尚未就绪。');
  document.activeElement?.blur?.();
  await globalThis.workbenchPriceProfitView?.flush?.();
  if(nasWorkspace)await nasWorkspace.settleDrafts();else await configDraftStorage?.settle();
 },
 inspect:async()=>{
  let blocker=exportJobs?'请等待图片导出完成。':hostTemplateHasDrafts()?'请先保存主机模板或恢复到已保存版本。':window.workbenchSourceEditor?.hasPending()?'请先处理输出源窗口中的未提交修改。':null;
  if(nasMain){
   const byId=new Map(nasWorkspace.drafts().map(row=>[row.id,row]));
   // 写盘失败和旧版价格草稿可能与配置草稿重叠，每套配置只列一次。
   for(const id of [...nasStageFailures.keys(),...nasWorkspace.priceDraft().map(row=>row.id)])if(!byId.has(id))byId.set(id,{id});
   const summaries=new Map(lazyWorkspace.index().summaries.map(row=>[row.id,row]));
   const drafts=[...byId.values()].map(row=>{
    const summary=summaries.get(row.id);
    return {...row,product:row.product||summary?.product,name:row.name||summary?.name,pending:!!row.pending};
   });
   if(nasBusy||drafts.some(row=>row.pending)||nasWorkspace.catalog().pending().length||await nasWorkspace.queue().read())blocker='请先处理正在保存或待确认的提交回执，再清理缓存。';
   const addonDrafts=describeAddonDrafts(currentAddonDrafts(),ordinaryAvailable());
   if(addonDrafts.length&&!blocker)blocker='请先保存或放弃加购包草稿，再清理缓存。';
   return {drafts,blocker,addonDrafts};
  }
  if(savePromise||batchPromise||batchPending||ordinaryPending||conflict)blocker='请先处理正在保存或待确认的提交，再清理缓存。';
  return {drafts:dirty?[{id:'local',name:'本地配置修改'}]:[],blocker};
 },
 save:()=>nasMain?saveAllNasConfigurations():save(),
 discard:async drafts=>{
  clearTimeout(timer);
  if(nasMain){await nasWorkspace.discardLocalDrafts(drafts.map(row=>row.id));nasWorkspace.priceDraft([]);nasStageFailures.clear();nasWriteFailures.clear();nasDraftFailure=null;}
  // 已明确确认放弃，只回到本窗口的已确认基线，不清除其它账号、店铺的草稿。
  state=cloneEditorState(acceptedState);dirty=false;history=[];redoHistory=[];
 },
 locateAddonDraft:async id=>{
  const row=currentAddonDrafts().get(id);
  if(row){
   try{await locateAddonPack(row.pack);}catch(error){toast(nasErrorText(error));}
  }
 },
 discardAddonDrafts,
 clearDerived:()=>{clearImageCache();globalThis.workbenchPriceProfitView?.clearCaches?.();imageRecords.clear();previewResult=null;},
 reload:()=>{window.workbenchReady=false;location.reload();},
});
window.workbenchCacheStatus=()=>cacheCleanup.status();
window.workbenchLocateAddonDraft=id=>cacheCleanup.locateAddonDraft(id);
window.workbenchDiscardAddonDrafts=ids=>cacheCleanup.discardAddonDrafts(ids);
window.workbenchPrepareCacheCleanup=choice=>cacheCleanup.prepare(choice);
window.workbenchReloadAfterCache=()=>cacheCleanup.reload();
const listConfigs=()=>{
 if(fullWorkspace)return state.configs;
 // 摘要维护清单顺序，已加载的详情只替换同 ID 的内容。
 const details=new Map(state.configs.map(c=>[c.id,c]));
 return lazyWorkspace.index().summaries.map(row=>details.get(row.id)||row);
};
const available=()=>liveConfigs(listConfigs()).filter(c=>c.shopId===activeShopId);
const ordinaryAvailable=()=>ordinaryConfigs(available());
// 首次打开回收站后沿用本店回读数，配置结构操作后重新核对。
const archivedCounts=new Map();
const localArchivedConfigs=(shop=activeShopId)=>listConfigs().filter(c=>c.shopId===shop&&c.deletedAt);
const current=()=>state.configs.find(c=>c.id===active&&!c.deletedAt&&c.shopId===activeShopId);
const chosen=()=>available().filter(c=>selected.has(c.id));
const currentProduct=()=>productGroups(available()).find(p=>p.id===current()?.productId);
const currentShop=()=>shopById(activeShopId);
const currentSettings=()=>settingsFor(state,activeShopId);
const currentPricingSettings=()=>({...currentSettings(),linkInstallment:currentProduct()?.installment});
const currentCatalog=()=>sourcesFor(state,activeShopId);
let erpCandidateFlight=null,erpCandidateCache=null;
async function findErpCandidates(query,existing=null){
 // 工作表离线时沿用相同搜索口径，只从本机已经缓存的 ERP 配件读出候选。
 if(!nasMain)return existing?searchErpParts(erpCatalogIndex(state.costSource.map(row=>({...row,name:latestErpName(row)}))),query,existing):[];
 if(!nasWorkspace.canManage()||!nasWorkspace.canPlan()||!nasWorkspace.hasSharedSources())return [];
 if(!erpCandidateCache||Date.now()>=erpCandidateCache.until){
  erpCandidateFlight??=nasWorkspace.readErp('erp-catalog').then(snapshot=>{
   erpCandidateCache={rows:erpCatalogIndex(validateErpSnapshot(snapshot)),until:Date.now()+300000};
   return erpCandidateCache;
  }).finally(()=>{erpCandidateFlight=null;});
  await erpCandidateFlight;
 }
 return searchErpParts(erpCandidateCache.rows,query,existing??new Set(currentCatalog().map(row=>row.goodsId)));
}
async function readSourceSheetTax(goodsId){
 // NAS 当前核算价可能是手改或 ERP 暂代价；建源默认值直接向成本表查询。
 if(!nasMain){
  const cached=state.costSource.find(row=>row.goodsId===goodsId&&!row.nasManualTax&&!row.nasProvisionalTax)?.tax;
  return Number.isFinite(cached)&&cached>=0?cached:null;
 }
 if(!nasWorkspace.canPlan())return null;
 try{
  const prices=await nasWorkspace.readErp('tax-current',[goodsId]);
  const price=prices.rows.find(row=>row.goods_id===goodsId)?.tax;
  return Number.isFinite(price)&&price>=0?price:null;
 }catch(error){
  if(['MEMBER_CHANGED','UNAUTHENTICATED','FORBIDDEN'].includes(error.code))throw error;
  return null;
 }
}
/** 单店建源沿用正式 adopt_erp 目录事务，收到回执后才刷新表格。 */
async function adoptSourceSheetErp(item,{tax,taxMode}){
 const {goodsId,name,erp,stockAvailable,stockIncomingAvailable,sku}=item,shop=activeShopId;
 const found=currentCatalog().find(row=>row.goodsId===goodsId&&!row.deletedAt);
 if(found)return found.sourceId;
 const erpAdoption={...erpCategoryFields(item),name:name.trim(),erp:erp??null,stockAvailable:stockAvailable??null,stockIncomingAvailable:stockIncomingAvailable??null,
  sku:sku??'',...(taxMode==='default_table'?{tableTax:tax}:{}),
  // 在建源事务内同步写本店覆盖，手填或明确清空都不会留下半完成的建源结果。
  ...(taxMode==='manual'||tax==null?{taxOverride:tax}:{})};
 try{
  const receipt=await nasWorkspace.catalog().save('shared-sources',goodsId,'create',{
   document:{id:goodsId,name:item.displayName?.trim()||splitErpName(name).main||name,erpAdoption},
  });
  if(activeShopId!==shop)throw Error('店铺已切换，请重新打开输出源');
  await readNasIndex();await loadNasCatalog('sources');renderAll();scheduleNasDataTime();
  const selected=currentCatalog().find(row=>row.sourceId===receipt.document?.sourceId&&row.goodsId===goodsId);
  if(!selected)throw Error('已确认建源，当前店铺目录尚未读到该配件');
  return selected.sourceId;
 }catch(error){throw Error(nasErrorText(error));}
 finally{syncNasControls();}
}
/** 从正式 ERP 选入新品，只有收到本店目录回执并读回来源后才允许填格。 */
async function adoptErpCandidate(id,slot,item){
 const target=state.configs.find(c=>c.id===id&&!c.deletedAt&&c.shopId===activeShopId),shop=activeShopId;
 if(!nasMain||!nasWorkspace.canManage()||!nasWorkspace.canPlan()||!nasWorkspace.hasSharedSources())throw Error('当前店铺未开放 ERP 建源。');
 if(!target)throw Error('当前配置已切换，请重新选择。');
 const original=JSON.stringify(target.actualParts.find(row=>row.slot===slot)??null);
 const lookup=()=>currentCatalog().find(row=>row.goodsId===item.goodsId&&!row.deletedAt);
 const existing=lookup();if(existing)return existing.sourceId;
 const {goodsId,name,erp,stockAvailable,stockIncomingAvailable,sku}=item;
 const observation={...erpCategoryFields(item),name:name.trim(),erp,stockAvailable,stockIncomingAvailable:stockIncomingAvailable??null,sku:sku??''};
 if(!Number.isFinite(state.costSource.find(row=>row.goodsId===goodsId)?.tax)){
  try{
   const prices=await nasWorkspace.readErp('tax-current',[goodsId]);
   const price=prices.rows.find(row=>row.goods_id===goodsId)?.tax;
   if(Number.isFinite(price)&&price>=0)observation.tableTax=price;
  }catch(error){if(['MEMBER_CHANGED','UNAUTHENTICATED','FORBIDDEN'].includes(error.code))throw error;}
 }
 if(activeShopId!==shop||!state.configs.some(c=>c.id===id&&!c.deletedAt))throw Error('当前配置已切换，请重新选择。');
 let receipt;
 try{
  receipt=await nasWorkspace.catalog().save('shared-sources',goodsId,'create',{
   document:{id:goodsId,name:splitErpName(name).main,erpAdoption:observation},
  });
 }catch(error){throw Error(nasErrorText(error));}
 finally{syncNasControls();}
 await readNasIndex();await loadNasCatalog('sources');scheduleNasDataTime();
 const latest=state.configs.find(c=>c.id===id&&!c.deletedAt&&c.shopId===shop);
 if(latest?.id!==id||JSON.stringify(latest.actualParts.find(row=>row.slot===slot)??null)!==original)
  throw Error('输出源已准备好，当前配置已变化，请重新选入。');
 const selected=currentCatalog().find(row=>row.sourceId===receipt.document?.sourceId&&row.goodsId===goodsId);
 if(!selected)throw Error('已确认建源，当前店铺目录尚未读到可选配件。');
 return selected.sourceId;
}
const collapsedProducts=new Set();
// 搜索期间的展开/收起单独记，换关键词或清空搜索就作废，不改动平时的折叠状态。
const searchCollapse={q:'',products:new Set(),zones:new Set()};
let templateSectionOpen=false,hostTemplateView=null,pendingHostTemplate=null;
const hostTemplateDrafts=new Map();
// 按内容高度调整配件文本框，保持长名称可见。
function fitPartText(input){input.style.height='auto';input.style.height=Math.max(34,input.scrollHeight+2)+'px';}
// 用短时状态提示反馈结果；复用同一节点和计时器，避免消息层堆积。
function toast(message){const el=$('#toast');el.textContent=message;el.setAttribute('popover','manual');el.setAttribute('role','status');el.setAttribute('aria-live','polite');el.classList.remove('hidden');if(el.matches(':popover-open'))el.hidePopover();el.showPopover();clearTimeout(toast.timer);toast.timer=setTimeout(()=>{el.hidePopover();el.classList.add('hidden');},4500);}
// 统一 JSON 请求、超时及登录失效通知；保留 HTTP 状态码供冲突恢复判断。
async function request(url,options={}){if(nasMain)return nasWorkspace.request(url,options);if(options.method==='POST'&&typeof window!=='undefined')await window.workbenchMaintenancePromise;try{const r=await fetch(url,{signal:AbortSignal.timeout(options.method==='POST'&&['/api/state','/api/configs/batch','/api/configs/patch'].includes(url)?120000:45000),...options,headers:{'Content-Type':'application/json',...options.headers}}),j=await r.json();if(!r.ok){const e=Error(j.error||'请求失败');e.status=r.status;if(r.status===401)window.dispatchEvent(new CustomEvent('workspace-auth-error',{detail:e.message}));throw e;}return j;}catch(error){if(error?.name==='TimeoutError'&&options.method==='POST'&&['/api/state','/api/configs/batch','/api/configs/patch'].includes(url)){throw Object.assign(Error('本机保存等待超时，尚未确认是否写入。当前输入已保留，请勿关闭；可查看诊断文本。'),{name:'TimeoutError'});}throw error;}}
const lazyWorkspace=createLazyWorkspace({request});
let fullWorkspace=false,workspaceLoad=null,activationGeneration=0,fullActionBusy=0;
const loadedIds=()=>state.configs.map(c=>c.id);
// 仅在没有草稿和保存请求时淘汰详情，当前编辑项和待处理图片始终保留。
function pruneDetails(){
 if(fullWorkspace||dirty||savePromise||batchPromise||ordinaryPending||batchPending)return;
 const pinned=[active,...pendingImages,...(tab==='parts'&&continuousWorkbench?available().filter(c=>c.productId===current()?.productId).map(c=>c.id):[])];
 const keep=lazyWorkspace.prune(pinned);
 // 来源保存会刷新摘要并清空请求缓存；当前链接的编辑文档仍需保留，不能随空缓存被误淘汰。
 const indexed=new Set(lazyWorkspace.index().summaries.map(c=>c.id));for(const id of pinned)if(indexed.has(id))keep.add(id);
 // An unchanged cache must retain the acknowledged save baseline. Replacing
 // it here invalidates scoped capture on every subsequent keystroke/save.
 if(state.configs.some(c=>!keep.has(c.id))){
  if(nasMain)for(const c of state.configs)if(!keep.has(c.id)){nasWorkspace.release(c.id);displayBaseline.delete(c.id);}
  state.configs=state.configs.filter(c=>keep.has(c.id));acceptedState={...acceptedState,configs:acceptedState.configs.filter(c=>keep.has(c.id))};
 }
 for(const id of displayBaseline.keys())if(!keep.has(id))displayBaseline.delete(id);
}
// 编辑器和 Agent 导出共用 NAS 的显示版式、实际 BOM 与有效成本。
function presentNasConfig(raw,addons,costs,sources,settings){
 const c=clone(raw);c.addons=addons;ensureActualParts(c);c.modules=posterModules(c);c.upgradeWeight??=400;
 if(sources)withCurrentSharedSource(c,sources,{deferText:true});
 visibleNasCosts(c,costs);
 if(!isLegacyTemplateConfig(c)&&!c.fixedInitialFormat)applyPosterView([c],settings?.posterView);
 normalizePosterDesign(c);return c;
}
// 只规范化本次请求的配置，并共用配件索引绑定来源和默认版式。
async function prepareDetails(rows){
 if(nasMain){
  // 当前运行区的资料只在展示层补齐，保留服务端配置快照与本机草稿。
  const costs=new Map((state.costSource||[]).map(row=>[row.goodsId,row]));
  const sources=nasWorkspace.hasSharedSources()?new Map(catalog.map(row=>[row.sourceId,row])):null;
  return rows.map(raw=>{
   const c=presentNasConfig(raw,nasWorkspace.editorAddons(raw.id,raw.addons),costs,sources,currentSettings());
   nasWorkspace.attach(c);return c;
  });
 }
 const prepared=await normalizeWorkspaceStateAsync({dataVersion:lazyWorkspace.index().metadata.dataVersion,configs:rows,templates:[],sourceCatalog:[],costSource:[],caseGallery:[],shopSettings:state.shopSettings},[]);
 const sourceIndex=createSourceIndex(catalog);bindSources(prepared.configs,catalog,sourceIndex);alignDisplaySourceNames(prepared.configs,catalog,sourceIndex);normalizeProducts(prepared.configs);
 for(const c of prepared.configs){c.modules=posterModules(c);c.upgradeWeight??=400;}return prepared.configs;
}
const detailLoads=new Map();
// 获取单套完整配置；重复点击共享请求，旧版本允许一次安全刷新后重试。
async function loadDetail(id){
 // 已载入配置由当前编辑器持有；保存和版本推进不能让连续编辑重新等待加载。
 if(state.configs.some(c=>c.id===id))return;
 if(detailLoads.has(id))return detailLoads.get(id);
 const flight=(async()=>{
 if(savePromise)await savePromise;if(batchPromise)await batchPromise;
 if(state.configs.some(c=>c.id===id))return;
 // 仅版本失效允许自动恢复一次；网络错误、真实冲突不会进入无限重试。
 for(let attempt=0;attempt<2;attempt++){
 const counter=changeCounter,revision=state.revision;
 let raw;
 try{
  if(lazyWorkspace.index().revision!==revision)throw Object.assign(Error('同步版本已变化'),{status:409});
  raw=await lazyWorkspace.load([id]);
 }catch(error){
  if(error.status!==409)throw error;
  if(attempt)throw Error('配置仍在更新，当前输入已保留，请再次点击配置重试');
  let refreshed;
  try{refreshed=await refreshCompactWorkspace();}catch(refreshError){
   if(refreshError.status!==409)throw refreshError;
   throw Error('配置仍在更新，当前输入已保留，请再次点击配置重试');
  }
  if(!refreshed)throw Error('配置仍在更新，当前输入已保留，请再次点击配置重试');
  const target=lazyWorkspace.index().summaries.find(row=>row.id===id);
  if(!target||target.deletedAt)throw Error('该配置已被删除，列表已更新');
  continue;
 }
 const prepared=await prepareDetails(raw);
 if(counter!==changeCounter||revision!==state.revision)throw Error('载入期间配置有新修改，请重试');
 if(!state.configs.some(c=>c.id===id)){state.configs.push(...prepared);acceptedState={...acceptedState,configs:[...acceptedState.configs,...raw]};rememberDisplayParts([id]);}
 return;
 }
 })();
 detailLoads.set(id,flight);
 try{return await flight;}finally{if(detailLoads.get(id)===flight)detailLoads.delete(id);}
}
// 为备份和全局操作构造完整快照，合并已加载草稿并检查等待期间的新输入。
async function completeWorkspaceSnapshot(merge=mergeEditorState){
 const loader=createLazyWorkspace({request}),counter=changeCounter,revision=state.revision;
 await loader.refresh();const remote=await loader.full();
 if(counter!==changeCounter||revision!==state.revision)throw Error('载入期间有新的输入，请完成编辑后重试');
 const {base,local}=fullWorkspace?{base:acceptedState,local:state}:completeWorkspaceViews(acceptedState,state,remote);
 const merged=merge(base,local,remote);return {...merged,baseState:base,remote,counter};
}
// 全局操作先等待完整数据；失败时恢复交互状态，不应用部分数据。
async function ensureFullWorkspace(){
 if(nasMain)throw Error('此批量或资料维护功能暂未接入 NAS。');
 if(fullWorkspace)return;if(workspaceLoad)return workspaceLoad;
 workspaceLoad=(async()=>{const workspace=$('.workspace'),inert=workspace.inert,status=$('#save-status'),previousStatus=status.textContent,loadingStatus='正在载入此操作需要的完整配置…';workspace.inert=true;status.textContent=loadingStatus;
  try{const complete=await completeWorkspaceSnapshot();if(complete.conflict)throw Object.assign(Error('载入期间同一配置已变化，请先处理保存冲突'),{status:409});
   const prepared=await prepareWorkspaceState(complete.state,baseCatalog);if(complete.counter!==changeCounter)throw Error('载入期间有新的输入，请重试');
   const rebased=[history,redoHistory].map(stack=>stack.map(item=>rebaseWorkspaceHistorySnapshot(item,complete.remote)));
   [history,redoHistory].forEach((stack,i)=>{const rows=rebased[i];stack.splice(0,stack.length,...(rows.some(row=>row.conflict)?[]:rows.map(row=>row.snapshot)));});
   state=prepared.state;acceptedState=complete.remote;catalog=prepared.catalog;fullWorkspace=true;rememberDisplayParts();renderAll(null,false);
  }finally{workspace.inert=inert;if(status.textContent===loadingStatus)status.textContent=previousStatus;}})().finally(()=>{workspaceLoad=null;});return workspaceLoad;
}
// 将批量或全局功能包装为先完整载入、再执行，普通配置编辑仍走按需路径。
function fullAction(fn){return async function(...args){fullActionBusy++;try{await ensureFullWorkspace();return await fn.apply(this,args);}catch(error){toast(error.message);throw error;}finally{fullActionBusy--;setTimeout(()=>compactWorkspace().catch(()=>{}),0);}};}
// 在独立加载器中准备新摘要及当前已加载详情，验证前不改动活动工作区。
async function prepareCompactSnapshot(skipUnchanged=false,retainIds=null){
 const loader=createLazyWorkspace({request}),counter=changeCounter,index=await loader.refresh();
 if(skipUnchanged&&index.revision===state.revision)return null;
 // 所有已载入详情都参与比较，避免草稿较多时被缓存容量截断；不加载未点击的其他配置。
 const known=new Set(index.summaries.map(c=>c.id)),ids=(retainIds||loadedIds()).filter(id=>known.has(id)),wanted=active&&!ids.includes(active)&&known.has(active)?[...ids,active]:ids;
 const raw=await loader.load(wanted),prepared=await prepareWorkspaceState({...index.metadata,configs:[],revision:index.revision,updatedAt:index.updatedAt},baseCatalog);
 const detailState=await normalizeWorkspaceStateAsync({dataVersion:index.metadata.dataVersion,configs:raw,templates:[],sourceCatalog:[],costSource:[],caseGallery:[],shopSettings:prepared.state.shopSettings},[]);
 bindSources(detailState.configs,prepared.catalog);alignDisplaySourceNames(detailState.configs,prepared.catalog);normalizeProducts(detailState.configs);for(const c of detailState.configs){c.modules=posterModules(c);c.upgradeWeight??=400;}
 return {index,raw,prepared,configs:detailState.configs,counter};
}
// 安装已核验的紧凑快照，保留可继续编辑的对象引用及独立保存基线。
function applyCompactSnapshot(result){
 const {index,raw,prepared,configs}=result;lazyWorkspace.install(index);lazyWorkspace.confirm(index.revision,index.updatedAt,raw);
 // Keep editor/inspector references alive when compacting or accepting a
 // clean remote refresh. The caller fences this against new local input.
 const retained=applySavedReceiptDraft({configs:state.configs},{configs},{configs:acceptedState.configs}).configs;
 state=markPartialWorkspace(prepared.state);acceptedState=cloneEditorState(state);state.configs=retained;acceptedState.configs=raw;catalog=prepared.catalog;fullWorkspace=false;
 displayBaseline.clear();rememberDisplayParts(loadedIds());
}
// 全量操作结束且没有未保存内容时，回到按需加载模式以减少驻留内存。
let compactionFlight=null;
async function compactWorkspace(){
 if(nasMain)return;
 if(compactionFlight)return compactionFlight;
 const blocked=()=>window.workbenchAgentBusy||!fullWorkspace||workspaceLoad||fullActionBusy||inventoryView||globalThis.workbenchPriceProfitView?.visible()||window.workbenchSourceEditor?.sheet||dirty||savePromise||batchPromise||ordinaryPending||batchPending||conflict||$('#dialog').open||window.workbenchSourceEditor?.hasPending();
 if(blocked())return;
 const beforeState=state,beforeBase=acceptedState,selectedId=active,generation=activationGeneration,stacks=[history.slice(),redoHistory.slice()];
 const compacted=compactConfigHistory(stacks,state);if(!compacted)return;
 // Keep the active preview and pending image work plus at most 16 recent
 // details, rather than reloading every detail hydrated by a global action.
 const keep=new Set([active,...pendingImages].filter(Boolean));
 for(const id of lazyWorkspace.cachedIds().reverse())if(keep.size<16)keep.add(id);
 compactionFlight=(async()=>{
  const result=await prepareCompactSnapshot(false,[...keep]);
  if(blocked()||state!==beforeState||acceptedState!==beforeBase||active!==selectedId||activationGeneration!==generation||result.counter!==changeCounter||result.index.revision!==beforeState.revision||[history,redoHistory].some((stack,i)=>stack.length!==stacks[i].length||stack.some((entry,j)=>entry!==stacks[i][j])))return;
  applyCompactSnapshot(result);[history,redoHistory].forEach((stack,i)=>{stack.splice(0,stack.length,...compacted[i]);trimHistory(stack);});
  pruneDetails();syncHistoryButtons();
  // Active editor objects survive applyCompactSnapshot; do not rebuild input
  // nodes or move the caret when background compaction finishes.
 })().finally(()=>{compactionFlight=null;});return compactionFlight;
}
// 按当前加载模式读取保存回执，补全服务器合并结果，避免把摘要当作配置。
async function savedReceiptState(receipt){
 if(fullWorkspace)return request('/api/state?logs=none');
 const index=await lazyWorkspace.refresh(),ids=loadedIds().filter(id=>index.summaries.some(c=>c.id===id)),configs=await lazyWorkspace.load(ids);
 return {...index.metadata,configs,revision:index.revision,updatedAt:index.updatedAt};
}
// 恢复文件包含完整草稿及比较基线，保证恢复后仍可正确识别并发修改。
async function recoverySnapshot(){const {state,baseState}=await completeWorkspaceSnapshot();return {state,baseState};}
let compactRefresh=null;
// 同步面板不暂存配置草稿，允许同步完成前回读；其他弹窗仍保护尚未提交的输入。
const hasDraftDialog=()=>$('#dialog').open&&!$('#cloud-close');
// 共享一次后台刷新；只在输入、保存和导航检查均通过后更新列表及安全详情。
async function refreshCompactWorkspace(syncDialog=false){
 if(nasMain)return false;
 // 点击和同步通知共享刷新任务；保存回执/待重试请求仍独占自己的基线。
 if(compactRefresh)return compactRefresh;
 // 弹窗可能暂存尚未写入 dirty 的价格或配件输入，按钮获得焦点也不能解除此保护。
 const blocked=()=>window.workbenchAgentBusy||fullWorkspace||workspaceLoad||savePromise||batchPromise||ordinaryPending||batchPending||conflict||(hasDraftDialog()&&!(syncDialog&&$('#erp-inline-shell')))||window.workbenchSourceEditor?.hasPending();
 if(blocked())return false;
 compactRefresh=(async()=>{
  const beforeState=state,beforeBase=acceptedState,beforeIndex=lazyWorkspace.index(),revision=state.revision,ids=loadedIds().join('\0'),selectedId=active;
  const result=await prepareCompactSnapshot(true);if(!result)return true;
  const normalizedBase=dirty?await prepareDetails(beforeBase.configs):[];
  // 等待网络/规范化期间如有输入、保存或切换配置，放弃结果，保留原草稿和光标。
  if(blocked()||state!==beforeState||acceptedState!==beforeBase||state.revision!==revision||result.counter!==changeCounter||ids!==loadedIds().join('\0')||active!==selectedId)return false;
  // 公共字段的本地草稿由完整保存协议负责，不能在安装远端摘要时被替换。
  if(dirty&&!sameWorkspaceMetadata(beforeBase,state))return false;
  const plan=planCompactRefresh({base:beforeBase.configs,local:state.configs,normalizedBase,remote:result.raw,prepared:result.configs,
   metadataChanged:!sameWorkspaceMetadata(beforeIndex.metadata,result.index.metadata),dirty,active,editing:!syncDialog&&Boolean(document.activeElement?.matches('input,textarea,select,[contenteditable="true"]'))});
  if(!plan)return false;
  const remote={...result.index.metadata,configs:result.raw,revision:result.index.revision,updatedAt:result.index.updatedAt};
  // 撤销记录同步调整基线，不能把其他人的新值在下一次撤销时恢复成旧值。
  const rebased=[history,redoHistory].map(stack=>stack.map(item=>rebaseHistorySnapshot(item,beforeBase,remote)));
  applyCompactSnapshot({...result,configs:plan.configs});
  [history,redoHistory].forEach((stack,i)=>{const rows=rebased[i];stack.splice(0,stack.length,...(rows.some(row=>row.conflict)?[]:rows.map(row=>row.snapshot)));});
  for(const id of plan.changed)imageRecords.delete(id);
  selected=new Set([...selected].filter(id=>result.index.summaries.some(row=>row.id===id&&!row.deletedAt)));
  if(active&&!current())active=null;
  syncHistoryButtons();
  // 仅其他配置变化时只重画左侧列表，不碰编辑区、预览、输入框和滚动位置。
  if(plan.keepEditor){const list=$('#config-list'),scroll=list.scrollTop;renderList();list.scrollTop=scroll;}else renderAll();
  return true;
 })().finally(()=>{compactRefresh=null;});
 return compactRefresh;
}
// 判断是否可增量保存；公共资料或配置归属变化回退到完整保存协议。
function compactChanges(base,snapshot){
 const keys=new Set([...Object.keys(base),...Object.keys(snapshot)]);
 for(const key of keys)if(!['configs','revision','updatedAt','logs','shops','dataVersion'].includes(key)&&base[key]!==snapshot[key]&&JSON.stringify(base[key])!==JSON.stringify(snapshot[key]))return null;
 if(base.configs.length!==snapshot.configs.length)return null;
 const originals=new Map(base.configs.map(c=>[c.id,c]));const changes=[];
 for(const after of snapshot.configs){const before=originals.get(after.id);if(!before||before.shopId!==after.shopId||before.productId!==after.productId||before.deletedAt!==after.deletedAt)return null;if(before!==after&&JSON.stringify(before)!==JSON.stringify(after))changes.push({id:after.id,base:before,after});}
 if(changes.length>64)return null;return changes;
}

const uploadImage=async file=>{
 if(!nasMain)return uploadImageFile(file,request);
 if(!nasWorkspace.canUpload())throw Error('当前 NAS 服务没有开放图片上传。');
 const {data,image}=await readImageFile(file);
 const result=await nasWorkspace.catalog().upload(file,data.slice(data.indexOf(',')+1));
 scheduleNasDataTime();
 rememberImage(result.document.url,image);return result.document.url;
};
// 捕获可撤销的业务内容与选择状态，复用上一份未改变的数据。
function historySnapshot(){return captureHistorySnapshot(state,{active,activeShopId,selected},history.at(-1));}
let restoringConfigIds=null;
// 依据撤销和重做栈统一更新编辑区、海报区和总表按钮。
function syncHistoryButtons(){
 $('#undo').disabled=!history.length;$('#redo').disabled=!redoHistory.length;
 $('#poster-undo').disabled=!history.length;$('#poster-redo').disabled=!redoHistory.length;
 globalThis.workbenchPriceProfitView?.historyButtons();
 continuousWorkbench?.syncHistory();
}
// 同时限制撤销步数和估算内存占用，至少保留最近一次可用记录。
function trimHistory(stack){let bytes=stack.reduce((sum,item)=>sum+historySnapshotBytes(item),0);while(stack.length>1&&(stack.length>30||bytes>32*1024*1024))bytes-=historySnapshotBytes(stack.shift());}
// 只压入确有变化的历史快照，避免重复记录浪费内存。
function addCheckpoint(snapshot){if(snapshot&&!sameHistorySnapshot(history.at(-1),snapshot)){history.push(snapshot);trimHistory(history);}syncHistoryButtons();}
// Unknown/batch/global operations keep the conservative whole-workspace path.
// 全局修改需要完整工作区快照，不能对只有摘要的数据建立撤销点。
function checkpoint(){if(!fullWorkspace)throw Error('此操作需要先载入完整配置');invalidateSaveScope(state,'global checkpoint');addCheckpoint(historySnapshot());}
// 普通编辑仅记录目标配置的历史和保存范围。
function checkpointConfig(ids=[active]){declareSaveScope(state,acceptedState,ids);const snapshot=captureConfigHistorySnapshot(state,{active,activeShopId,selected},ids,history.at(-1));if(snapshot)addCheckpoint(snapshot);else checkpoint();}
// 撤销或重做仍通过正常保存与冲突检查，不绕过服务端版本保护。
async function stepHistory(from,to,message){
 if(nasMain&&from.at(-1)?.historyScope==='nas-part-batch'){
  try{await replayNasPartBatch(from.at(-1),message);}
  catch(error){toast(nasErrorText(error));}
  return;
 }
 // 服务端归档的撤销也检查回执版本，不把已删除的配置伪装成本机草稿。
 if(nasMain&&from.at(-1)?.historyScope==='nas-archive'){
  const entry=from.at(-1),undoStack=[...history],redoStack=[...redoHistory],isUndo=from===history;
  try{
   if(entry.action==='archive')await loadNasScope([entry.id]);
   const result=await commitNasConfigs([{id:entry.id,action:entry.action,expected_version:entry.version}],{title:message,selectId:entry.action==='restore'?entry.id:null});
   if(!result)return;
   const saved=nasApplied(result).find(row=>row.configuration_id===entry.id);if(!saved)throw Error('未收到配置回执');
   const src=isUndo?undoStack:redoStack,dst=isUndo?redoStack:undoStack;src.pop();dst.push({...entry,action:entry.action==='restore'?'archive':'restore',version:saved.version});
   history=undoStack;redoHistory=redoStack;syncHistoryButtons();return;
  }catch(error){toast(nasErrorText(error));return;}
 }
 // 每个候选（包括跳过空操作后露出的条目）都先补齐详情；加载失败不消费撤销记录。
 let next,snapshot;while((next=from.at(-1))){
  if(!fullWorkspace){if(isConfigHistorySnapshot(next)){
   const ids=new Set(next.configs.map(c=>c.id));if(next.active&&lazyWorkspace.index().summaries.some(c=>c.id===next.active&&!c.deletedAt))ids.add(next.active);
   for(const id of ids)await loadDetail(id);
  }else await ensureFullWorkspace();}
  // Full hydration may rebase or invalidate the history after a remote update.
  // Never restore the stale entry captured before that asynchronous boundary.
  if(from.at(-1)!==next)continue;
  if(isConfigHistorySnapshot(next)&&next.baseline){
   const rebased=rebaseWorkspaceHistorySnapshot(next,acceptedState);
   if(rebased.conflict){from.length=0;syncHistoryButtons();return;}
   next=rebased.snapshot;from[from.length-1]=next;
  }
  snapshot=next.historyScope==='workspace'?captureWorkspaceHistorySnapshot(state,{active,activeShopId,selected},next):isConfigHistorySnapshot(next)?captureConfigHistorySnapshot(state,{active,activeShopId,selected},next.configs.map(config=>config.id)):historySnapshot();
  if(!snapshot){syncHistoryButtons();return;}from.pop();if(!sameHistorySnapshot(next,snapshot))break;
 }if(!next||!snapshot){syncHistoryButtons();return;}
 const restored=restoreHistorySnapshot(state,next);to.push(snapshot);trimHistory(to);transferSaveScope(state,restored,acceptedState,isConfigHistorySnapshot(next)?next.configs.map(config=>config.id):null);state=restored;
 const ids=isConfigHistorySnapshot(next)?next.configs.map(config=>config.id):null;
 activeShopId=nasMain?nasWorkspace.shop():next.activeShopId||'intel';if(!nasMain)localStorage.setItem('diy-active-shop',activeShopId);
 if(!nasMain){if(ids===null){catalog=sourceCatalog(state.sourceCatalog||baseCatalog);state.costSource=costRows(catalog,state.costSource||[]);bindSources(state.configs,catalog);alignDisplaySourceNames(state.configs,catalog);}else{const targets=new Set(ids),configs=state.configs.filter(config=>targets.has(config.id));bindSources(configs,catalog);alignDisplaySourceNames(configs,catalog);}}
 active=next.active;selected=new Set((next.selected||[]).filter(id=>available().some(c=>c.id===id)));posterEditor?.clear();
 restoringHistory=true;restoringConfigIds=ids;try{changed(message,ids??state.configs.filter(c=>!c.deletedAt).map(c=>c.id),false,null,true);renderAll(ids);}finally{restoringHistory=false;restoringConfigIds=null;syncHistoryButtons();}
}
// 提取会影响图片外观的配置，排除纯库存、税价和同步时间字段。
function visiblePosterInput(config){if(!config)return null;const value=clone(config);delete value.actualParts;for(const key of ['deletionSessionId','updatedAt','taxUpdatedAt','erpImportedAt'])delete value[key];for(const part of value.parts||[])for(const key of ['sourceFollow','erp','tax','stockAvailable','stockIncomingAvailable','stockUpdatedAt','erpUpdatedAt','erpMissing','erpUnknown','taxUpdatedAt','stockSource','erpName'])delete part[key];return JSON.stringify(value);}
// 标记草稿及受影响海报。仅展示输入变化才让图片过期，实际配件变化仍作为业务修改保存。
// 统一记录用户编辑、更新预览与保存范围，并延迟触发自动保存。
function changed(message='编辑配置',ids=[active],imageOnly=false,beforeConfigs=null,preserveMetadata=false){changeSaveScope(state,acceptedState,ids);if(!imageOnly){if(!restoringHistory)syncDisplayEdits(ids);else rememberDisplayParts(restoringConfigIds);}if(!restoringHistory){redoHistory=[];syncHistoryButtons();}if(!imageOnly){for(const id of ids){const c=state.configs.find(x=>x.id===id);if(!preserveMetadata){if(c&&message!=='新增配置链接'&&message!=='编辑商品链接')delete c.emptyLinkDraft;if(c?.shortNameAuto){const nextName=suggestedName(c,c.nameFormat||'compact');if(c.shortName!==nextName){c.shortName=nextName;syncPosterShortName(c);}}}}const nameInput=document.querySelector('[data-config=shortName]');if(nameInput&&document.activeElement!==nameInput){if(nameInput.dataset.reactConfig){if(current())renderConfigFields();}else nameInput.value=current()?.shortName||'';}}dirty=true;changeCounter++;changed.message=message;let visualChange=!!imageOnly;ids.forEach(id=>{const before=beforeConfigs?.get(id)||acceptedState?.configs?.find(c=>c.id===id),after=state.configs.find(c=>c.id===id);if(imageOnly||visiblePosterInput(before)!==visiblePosterInput(after)){visualChange=true;pendingImages.add(id);imageRecords.delete(id);}});$('#save-status').textContent='尚未保存';queueMicrotask(()=>continuousWorkbench?.draw());if(visualChange){$('#image-status').textContent='预览已更新 · 导出时生成图片';$('#saved-image').classList.add('hidden');}clearTimeout(timer);clearTimeout(imageTimer);if(nasMain)stageNasDrafts(ids);else if(!conflict&&!batchPromise)timer=setTimeout(()=>save().catch(()=>{}),950);if(!imageOnly){updateHeading();updateSummary();refreshCurrentListPart();}if(imageOnly&&imageOnly!=='asset'&&previewResult?.redrawImages&&previewConfigId===active&&!previewBusy&&!previewFrame){(imageOnly==='layout'?previewResult.redrawLayout:previewResult.redrawImages)(current());paintPreview(previewResult);}else schedulePreview();queueMicrotask(()=>globalThis.workbenchPriceProfitView?.refresh());}
// 输出浏览器下载文件，并在下载启动后释放临时对象 URL。
function downloadBlob(blob,name){const a=document.createElement('a'),url=URL.createObjectURL(blob);a.href=url;a.download=name;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),10000);}
const toBlob=canvas=>new Promise((resolve,reject)=>canvas.toBlob(b=>b?resolve(b):reject(Error('图片生成失败')),'image/png'));
// 导出完整合并草稿，避免按需工作区只备份到已点击的配置。
async function backup(){const complete=await completeWorkspaceSnapshot();downloadBlob(new Blob([JSON.stringify(complete.state,null,2)],{type:'application/json'}),'DIY配置备份_'+new Date().toISOString().slice(0,10)+'.json');}
let derivedTimer=null;
// 轮询商品派生文件状态，只在匹配当前版本时更新保存提示。
async function pollDerivedStatus(){
 if(nasMain)return;
 clearTimeout(derivedTimer);
 try{
  const result=await request('/api/derived/status');
  if(result.productFiles===false)return;
  if(!dirty&&!savePromise&&!batchPromise&&!conflict&&result.requestedRevision===state.revision){
   const label={pending:'商品文件待更新',running:'商品文件更新中',failed:'商品文件更新失败，后台重试',ready:'商品文件已更新'}[result.phase];
   $('#save-status').textContent=`已保存 ${new Date(state.updatedAt).toLocaleTimeString('zh-CN')} · ${label}`;
  }
  if(result.phase!=='ready')derivedTimer=setTimeout(()=>pollDerivedStatus().catch(()=>{}),2000);
 }catch(e){if(e.status!==404)derivedTimer=setTimeout(()=>pollDerivedStatus().catch(()=>{}),5000);}
}
// 接受服务端回执并重基飞行期间的输入及撤销记录，冲突时保留本地草稿。
function acceptSavedState(snapshot,remote){
 if(state.configs.length>100)return (async()=>{
  if(await sameEditingStateAsync(snapshot,remote)){acceptedState=remote;return;}
  const {live,rebased}=await prepareSavedReceipt(snapshot,remote,{getState:()=>state,getCounter:()=>changeCounter,getStacks:()=>[history,redoHistory]});
  acceptedState=remote;
  if(live.conflict)throw Object.assign(Error('保存后又收到同一字段的其他修改，请比较当前草稿与最新版本。'),{status:409});
  [history,redoHistory].forEach((stack,index)=>{const rows=rebased[index];if(rows.some(item=>item.conflict))stack.length=0;else{stack.splice(0,stack.length,...rows.map(item=>item.snapshot));trimHistory(stack);}});
  syncHistoryButtons();state=applySavedReceiptDraft(state,live.state,snapshot);catalog=sourceCatalog(state.sourceCatalog);if(!dirty)renderAll();
 })();
 // Every receipt is fresh JSON or immutable accepted rows plus fresh JSON.
 // The live draft is retained or independently merged below; it never owns
 // editable receipt rows, so the receipt itself is a safe accepted baseline.
 acceptedState=remote;
 // 回执重基遇到同字段并发修改时保留当前草稿并进入显式冲突处理，绝不自动覆盖远端。
 if(sameEditingState(snapshot,remote))return;
 const live=mergeEditorState(snapshot,state,remote);
 if(live.conflict)throw Object.assign(Error('保存后又收到同一字段的其他修改，请比较当前草稿与最新版本。'),{status:409});
 for(const stack of [history,redoHistory]){const rebased=stack.map(item=>rebaseHistorySnapshot(item,snapshot,remote));if(rebased.some(item=>item.conflict))stack.length=0;else{stack.splice(0,stack.length,...rebased.map(item=>item.snapshot));trimHistory(stack);}}
 syncHistoryButtons();state=applySavedReceiptDraft(state,live.state,snapshot);
 catalog=sourceCatalog(state.sourceCatalog);if(!dirty)renderAll();
}
// 回执只改变已保存基线，保留价格页当前输入框、选区及展开卡片。
function refreshPriceSaveMarkers(){
 if(!globalThis.workbenchPriceProfitView)return;
 queueMicrotask(()=>globalThis.workbenchPriceProfitView?.refresh({baselineOnly:true}));
}
// 串行保存草稿；请求失败复用操作编号，回执期间的新输入继续下一轮保存。
async function save(){
 if(nasMain){await flushConfigDrafts();if(nasDraftFailure)throw nasDraftFailure;return;} // 导出、关闭等旧流程仅核对本机草稿，不提交 NAS。
 // 单次循环只确认一份快照；增量请求失败时保留原 payload，成功后再保存飞行期间新增输入。
 if(conflict){openConflict('当前草稿尚未保存，请重新比较后选择保存版本。');throw Object.assign(Error('请在弹窗中处理保存冲突，当前输入已保留'),{status:409});}
 if(batchPromise){await batchPromise;return dirty?save():undefined;}
 if(batchPending){await sendBatchPending();return dirty?save():undefined;}
 if(savePromise)return savePromise;
 if(!dirty&&!ordinaryPending)return;
 savePromise=(async()=>{let priceRetried=false;try{while((dirty||ordinaryPending)&&!conflict){
  // 请求快照和 operationId 一起保留；响应丢失后重试原请求，期间的新输入留在 state。
  const replaying=Boolean(ordinaryPending);
  const snapshot=ordinaryPending?.sent||captureSaveSnapshot(state,acceptedState);
  const unsupportedRoots=unsupportedSaveRootChanges(acceptedState,snapshot);
  if(unsupportedRoots.length){await Promise.resolve();throw Error(`当前保存协议不支持修改字段：${unsupportedRoots.join('、')}。草稿已保留，请先备份草稿。`);}
  // A gesture can return to the accepted value before autosave fires. Capture
  // shares equal collections with that immutable baseline, so this check is
  // constant-sized and must not fall through to a full-workspace request.
  if(!ordinaryPending&&acceptedState&&sameCapturedBusinessState(snapshot,acceptedState)){
   dirty=false;acknowledgeSaveScope(state,acceptedState,snapshot,dirty);refreshPriceSaveMarkers();
   $('#save-status').textContent=`已保存 ${new Date(acceptedState.updatedAt).toLocaleTimeString('zh-CN')}`;await Promise.resolve();continue;
  }
  const changes=ordinaryPending?.payload.changes||(fullWorkspace?ordinarySaveChanges(acceptedState,snapshot,saveSnapshotIds(snapshot)):compactChanges(acceptedState,snapshot));
  if(!fullWorkspace&&!changes){await ensureFullWorkspace();dirty=true;continue;}
  if(!fullWorkspace&&changes?.length===0){dirty=false;continue;}
  if(!fullWorkspace)assertLoadedChanges(changes);
  if(!ordinaryPending&&changes)ordinaryPending={sent:snapshot,payload:{mode:'ordinary',operationId:crypto.randomUUID(),baseRevision:acceptedState.revision,operator,message:changed.message,changes}};
  // 重放 A 时若草稿已变成 B，B 必须继续保持 dirty；原请求和 operationId 不变。
  // A fresh capture and change selection are synchronous: no input can arrive
  // before the request awaits. Only a retained request needs a draft comparison.
  dirty=Boolean(replaying&&(!sameEditingState(snapshot,state)||unsupportedSaveRootChanges(snapshot,state).length));$('#save-status').textContent='正在保存到本机…';
  let data;
  const baselineBeforeSave=acceptedState;
  try{if(ordinaryPending){
   data=await request(fullWorkspace?'/api/configs/batch':'/api/configs/patch',{method:'POST',body:JSON.stringify(ordinaryPending.payload)});
   const saved=new Map(data.configs.map(c=>[c.id,c]));
   const remote=data.rebased?await savedReceiptState(data):{...acceptedState,configs:acceptedState.configs.map(c=>saved.get(c.id)||c),revision:data.revision,updatedAt:data.updatedAt,logs:[...(data.activityDelta||[]),...(acceptedState.logs||[])]};
   await acceptSavedState(snapshot,remote);if(!fullWorkspace&&data.rebased){catalog=sourceCatalog(state.sourceCatalog);state.costSource=costRows(catalog,state.costSource||[]);bindSources(state.configs,catalog);alignDisplaySourceNames(state.configs,catalog);rememberDisplayParts(loadedIds());}state.revision=remote.revision;state.updatedAt=remote.updatedAt;state.logs=remote.logs;
   ordinaryPending=null;if(!fullWorkspace)lazyWorkspace.confirm(remote.revision,remote.updatedAt,remote.configs);
  }else{
   data=await saveFullState(request,acceptedState,snapshot,{operator,message:changed.message});
   if(data.state)await acceptSavedState(snapshot,data.state);else acceptedState=cloneEditorState({...snapshot,revision:data.revision,updatedAt:data.updatedAt,logs:data.logs});state.revision=data.revision;state.updatedAt=data.updatedAt;state.logs=data.logs;
  }
  }catch(error){
   if(error.status!==409||priceRetried||acceptedState!==baselineBeforeSave)throw error;
   const complete=await completeWorkspaceSnapshot(mergePriceSaveConflict);
   if(complete.conflict||!complete.priceOverrides)throw error;
   // 仅价格重叠时，以最新版本为基线重新提交。仍由后端原子版本检查兜底；只重试一次。
   const rebased=[history,redoHistory].map(stack=>stack.map(item=>rebaseWorkspaceHistorySnapshot(item,complete.remote)));
   [history,redoHistory].forEach((stack,i)=>{const rows=rebased[i];stack.splice(0,stack.length,...(rows.some(row=>row.conflict)?[]:rows.map(row=>row.snapshot)));});
   syncHistoryButtons();acceptedState=complete.remote;state=complete.state;fullWorkspace=true;
   ordinaryPending=null;dirty=true;priceRetried=true;invalidateSaveScope(state,'price conflict retry');rememberDisplayParts();renderAll();continue;
  }
  acknowledgeSaveScope(state,acceptedState,snapshot,dirty);
  refreshPriceSaveMarkers();
  $('#save-status').textContent=dirty?'尚未保存':`已保存 ${new Date(data.updatedAt).toLocaleTimeString('zh-CN')}`;
  if(!dirty)pollDerivedStatus().catch(()=>{});
 }if(conflict)throw Object.assign(Error('同步期间同一字段已变化，请先处理保存冲突'),{status:409});scheduleImageSave();}catch(e){dirty=true;if(e.status===409){ordinaryPending=null;conflict=true;$('#save-status').textContent='保存冲突';openConflict(e.message);}else{$('#save-status').textContent='保存失败 · 请重试';toast(e.message);}throw e;}finally{savePromise=null;if(!dirty){pruneDetails();setTimeout(()=>compactWorkspace().catch(error=>toast(error.message)),0);}}}) ();return savePromise;
}
// 重试待确认批量请求时复用原操作编号，避免重复应用批量更换。
async function sendBatchPending(){
 if(batchPromise)return batchPromise;
 const pending=batchPending;
 batchPromise=(async()=>{try{
  const receipt=await request('/api/configs/batch',{method:'POST',body:JSON.stringify(pending.payload)});
  const saved=new Map(receipt.configs.map(c=>[c.id,c]));
  const remote=receipt.rebased?await request('/api/state?logs=none'):{...acceptedState,configs:acceptedState.configs.map(c=>saved.get(c.id)||c),revision:receipt.revision,updatedAt:receipt.updatedAt,logs:[...(receipt.activityDelta||[]),...(acceptedState.logs||[])]};
  await acceptSavedState(pending.sent,remote);state.revision=remote.revision;state.updatedAt=remote.updatedAt;state.logs=remote.logs;rememberDisplayParts();
  batchPending=null;$('#save-status').textContent=dirty?'尚未保存':`已保存 ${new Date(remote.updatedAt).toLocaleTimeString('zh-CN')}`;
  if(!dirty)pollDerivedStatus().catch(()=>{});
  scheduleImageSave();if(dirty)timer=setTimeout(()=>save().catch(()=>{}),0);return receipt;
 }catch(e){invalidateSaveScope(state,'batch request failure');dirty=true;if(e.status===409){batchPending=null;conflict=true;$('#save-status').textContent='保存冲突';openConflict(e.message);}else{$('#save-status').textContent='保存失败 · 请重试';toast(e.message);}throw e;}finally{batchPromise=null;if(!dirty)setTimeout(()=>compactWorkspace().catch(()=>{}),0);}})();
 return batchPromise;
}
// 把预览确认的批量更换转换成事务请求，保持展示配件和实际 BOM 一致。
async function applyBatchChanges(plan,message,agentOptions=null,{partHistory=null,stockShopId=null}={}){
 if(nasMain){
  validateBatchSources(plan,currentCatalog());
  validateReplacement(plan,available());
  const outcome=await commitNasConfigs(plan.changes.map(({id,after})=>({id,action:'replace',document:after})),{title:message,partHistory});
  if(!outcome)throw Error('已取消批量提交。');
  return partHistory?outcome:nasApplied(outcome).map(row=>row.configuration_id);
 }
 await save();
 // 离线价格页可浏览其他店铺，校验与应用都固定在预览店铺。
 const configs=stockShopId?state.configs.filter(c=>c.shopId===stockShopId&&!c.deletedAt):agentOptions?state.configs:available();
 validateBatchSources(plan,stockShopId?sourcesFor(state,stockShopId):currentCatalog());
 validateReplacement(plan,configs);
 checkpoint();
 const ids=applyReplacement(plan,configs);
 const byId=new Map(state.configs.map(c=>[c.id,c]));
 for(const id of ids)displayBaseline.set(id,clone(byId.get(id).parts));
 const displayChanged=plan.changes.some(c=>visiblePosterInput(c.before)!==visiblePosterInput(c.after));
 changed(message,ids,false,new Map(plan.changes.map(c=>[c.id,c.before])),!displayChanged);renderAll();clearTimeout(timer);
 const sent=cloneEditorState(state),base=new Map(acceptedState.configs.map(c=>[c.id,c])),intents=new Map(plan.changes.map(c=>[c.id,c]));
 const payload={operationId:agentOptions?.operationId||crypto.randomUUID(),baseRevision:acceptedState.revision,operator,message,
  ...(plan.request?.action?.type==='configFields'?{mode:'configFields'}:{}),
  changes:ids.map(id=>{const intent=intents.get(id),saved=base.get(id),local=clone(intent.after),live=byId.get(id);
   if(live.shortName!==intent.before.shortName)local.shortName=live.shortName;
   if(live.emptyLinkDraft!==intent.before.emptyLinkDraft){if(Object.hasOwn(live,'emptyLinkDraft'))local.emptyLinkDraft=live.emptyLinkDraft;else delete local.emptyLinkDraft;}
   const merged=mergeEditingState({configs:[intent.before],shopSettings:{}},{configs:[local],shopSettings:{}},{configs:[saved],shopSettings:{}});
   if(merged.conflict)throw Error('配置来源已变化，请重新预览');
   return {id,base:clone(saved),after:merged.state.configs[0]};})};
 invalidateSaveScope(state,'asynchronous batch request');dirty=false;batchPending={payload,sent,...(agentOptions?{agent:{plan:clone(plan),baseline:clone(agentOptions.baseline),counter:changeCounter}}:{})};
 try{const receipt=await sendBatchPending();if(agentOptions)return receipt;}catch(e){if(e.status===404&&!agentOptions){batchPending=null;await save();return ids;}throw e;}
 return ids;
}

async function applyPartBatch(plan,message){
 if(!nasMain)return applyBatchChanges(plan,message);
 const partHistory={direction:'apply',records:captureBatchRevert(plan,[],{onlyChanged:true})};
 const outcome=await applyBatchChanges(plan,message,null,{partHistory});
 return outcome.historyEntry;
}

// 已确认批次和续接批次共用同一份还原资料；读回已推进的版本不做旧回退。
async function registerNasPartUndo(plan){
 const options=plan?.partHistory;
 if(!options)return null;
 const confirmed=new Map(nasApplied(plan).map(row=>[row.configuration_id,row.version]));
 const source=options.direction==='undo'?history:redoHistory;
 const sourceIndex=source.findIndex(entry=>entry.id===options.sourceEntryId);
 // 续接完成时也消费原记录中已经反转的配置，留待处理的配置仍可再次核对。
 if(options.sourceEntryId&&sourceIndex>=0){
  const entry=source[sourceIndex],remaining=entry.records.filter(row=>!confirmed.has(row.id));
  if(remaining.length)source[sourceIndex]={...entry,records:remaining};
  else source.splice(sourceIndex,1);
  syncHistoryButtons();
 }
 try{
  const ids=[...confirmed.keys()];
  await loadNasScope(ids);
  const unchanged=new Map([...confirmed].filter(([id,version])=>nasWorkspace.configurationVersion(id)===version));
  const records=confirmBatchRevert(options.records,state.configs,unchanged);
  if(records.length<ids.length)toast(`只保留 ${records.length} / ${ids.length} 套仍处在保存版本的配件还原记录。`);
  if(!records.length)return null;
  const entry={historyScope:'nas-part-batch',id:plan.id,shopId:activeShopId,records};
  if(options.direction==='undo'){redoHistory.push(entry);trimHistory(redoHistory);syncHistoryButtons();}
  else addCheckpoint(entry);
  return entry;
 }catch(error){
  toast('批量换件已保存，未能准备还原记录。'+nasErrorText(error));
  return null;
 }
}

async function replayNasPartBatch(entry,message){
 const undo=history.at(-1)===entry;
 if(!entry||entry.shopId!==activeShopId||!undo&&redoHistory.at(-1)!==entry||nasBusy)throw Error('这次批量操作已不在当前撤销位置。');
 const undoStack=[...history],redoStack=[...redoHistory];
 await loadNasScope(entry.records.map(row=>row.id));
 if((undo?history:redoHistory).at(-1)!==entry||entry.shopId!==activeShopId)throw Error('编辑状态已变化，请重新确认。');
 const reversal=batchRevertPlan(entry.records,state.configs);
 let reversedEntry;
 if(reversal.changes.length){
  const partHistory={direction:undo?'undo':'redo',sourceEntryId:entry.id,records:captureBatchRevert(reversal,[],{onlyChanged:true})};
  const result=await applyBatchChanges(reversal,message,null,{partHistory});
  reversedEntry=result.historyEntry;
 }else reversedEntry={...entry,records:entry.records.map(row=>({...row,before:row.saved,saved:row.before}))};
 // 恢复互逆记录。已有其他字段始终取当前值，已变化的同一字段由还原计划拦截。
 const source=undo?undoStack:redoStack,target=undo?redoStack:undoStack;
 source.pop();
 if(reversedEntry){target.push(reversedEntry);trimHistory(target);}
 history=undoStack;redoHistory=redoStack;syncHistoryButtons();
}
let imageTimer;
let exportJobs=0;
const imageRenderGate=createPosterRenderGate({quietMs:160});
imageRenderGate.bind(document);
window.addEventListener('pagehide',event=>{if(!event.persisted)imageRenderGate.dispose();});
// Editing keeps only the canvas preview. Exports write directly to the chosen
// download/folder; no background PNG encoding or saved-image cache is scheduled.
// 维护图片状态提示；图片只在用户导出时生成，普通保存不积累 PNG 缓存。
function scheduleImageSave(){clearTimeout(imageTimer);pendingImages.clear();}
// 保留草稿并提供备份、重新比较和明确选择，不自动覆盖冲突字段。
function openConflict(message){openDialog('保存版本需要比较',`<p class="error">${esc(message)}</p><p class="hint">当前输入仍保留。可以重新比较并保存本页修改，或备份当前草稿后载入已保存版本。</p><div class="actions"><button id="conflict-backup">下载当前草稿</button><button id="conflict-compare" class="primary">重新比较</button><button id="conflict-reload">备份草稿并重新载入</button></div>`);$('#conflict-backup').onclick=backup;
 $('#conflict-reload').onclick=async()=>{try{await request('/api/recovery-draft',{method:'POST',body:JSON.stringify(await recoverySnapshot())});conflict=false;dirty=false;location.reload();}catch(e){toast(e.message);}};
 $('#conflict-compare').onclick=compareSaveConflict;
}
// 预览与实际保存使用同一份合并快照；预览后发生输入时要求重新比较。
async function compareSaveConflict(){
 const button=$('#conflict-compare')||$('#conflict-refresh');if(button)button.disabled=true;
 try{
  const complete=await completeWorkspaceSnapshot(),remote=complete.remote;
  if(button&&!button.isConnected)return;
  openDialog('选择保存版本',`<p class="hint">已读取最新保存版本。独立字段已自动合并；同一字段冲突保留本页输入。请核对下方内容后保存。</p>${saveConflictHtml(complete.state,remote,esc)}<p id="conflict-message" class="error" role="status"></p><div class="actions"><button id="conflict-apply-local" class="primary">保留本页修改并保存</button><button id="conflict-refresh">重新比较</button><button id="conflict-cancel">返回编辑</button></div>`);
  $('#conflict-cancel').onclick=closeDialog;$('#conflict-refresh').onclick=compareSaveConflict;
  $('#conflict-apply-local').onclick=async()=>{
   const apply=$('#conflict-apply-local');apply.disabled=true;
   try{
    const assertCurrent=()=>{if(complete.counter!==changeCounter)throw Error('比较后有新的输入，请重新比较；当前输入已保留。');};
    assertCurrent();
    await request('/api/recovery-draft',{method:'POST',body:JSON.stringify(await recoverySnapshot())});
    assertCurrent();
    acceptedState=cloneEditorState(remote);state=complete.state;fullWorkspace=true;invalidateSaveScope(state,'conflict resolution draft');conflict=false;dirty=true;closeDialog();await save();renderAll();
   }catch(e){if(apply.isConnected){$('#conflict-message').textContent=e.message;apply.disabled=false;}toast(e.message);}
  };
 }catch(e){toast(e.message);}finally{if(button?.isConnected)button.disabled=false;}

}
// 刷新当前配置的标题和基础信息，避免重建整个工作区。
function updateHeading(){const c=current();if(!c){$('#config-heading').textContent=ordinaryAvailable().length?'请选择配置':'暂无配置';$('#breadcrumb').textContent='商品配置';return;}$('#config-heading').textContent=`${c.name} · ${c.version}`;$('#breadcrumb').textContent=`商品配置 / ${c.product||'未命名商品链接'}`;$('#sample-note').textContent=c.sampleNote||'';}
// 刷新当前配置核算摘要，使配件和价格编辑立即反映在界面。
function updateSummary(){
 const c=current();if(!c)return;const settings=currentPricingSettings(),p=pricing(c,settings),t=totals(c,settings,p);let input=$('#arrival-price');
 if(!input){if(!reactWorkbench.dialog($('#cost-summary'),'cost-summary',{}))$('#cost-summary').innerHTML=`<label class="arrival-field"><small>到手价 · 买家实付</small><div><span>¥</span><input id="arrival-price" type="number" min="0" step=".01" aria-label="到手价"></div></label><div><small>商品定价 <button id="coupon-open" class="text-button">店铺券</button></small><strong id="list-price"></strong></div><div class="profit-cell" title="到手价 − 核算成本 − 核算扣点 − 固定费用 − 分期费"><small>核算利润</small><div class="profit-value-line"><strong id="excel-profit"></strong><span id="profit-cost-note" class="config-cost-note hidden" role="status"></span></div></div><section class="cost-more" aria-label="成本与分期"><div class="cost-detail-grid"><div><small>ERP 总成本</small><strong id="erp-total"></strong></div><div><small>含税总成本</small><strong id="tax-total"></strong></div><div class="profit-cell" title="到手价 − ERP 成本 − ERP 扣点 − 固定费用；括号内再扣除分期费"><small>ERP 利润</small><strong id="erp-profit"></strong></div><div class="installment-field"><small>链接分期</small><strong id="installment-label"></strong><small id="installment-fee"></small><small id="installment-mixed" class="error hidden">本链接旧配置分期不一致，请在“编辑链接”统一设置。</small></div></div></section><p id="erp-price-warning" class="erp-price-warning hidden" role="status"></p>`;
 input=$('#arrival-price');input.onfocus=()=>checkpointConfig();input.oninput=()=>{const value=Number(input.value);if(input.value===''||!Number.isFinite(value)||value<0){input.setCustomValidity('请输入不小于 0 的到手价');return;}input.setCustomValidity('');current().price=value;changed('调整到手价');if(tab==='costs')renderEditor();};
 $('#coupon-open').onclick=()=>openShopSettings();}
 $('#erp-total').textContent=financeMoney(t.erp);$('#tax-total').textContent=financeMoney(t.tax);$('#list-price').textContent=financeMoney(p.listPrice);$('#coupon-open').textContent='店铺券 ¥'+money(p.coupon);$('#installment-label').textContent=p.term==null?'分期设置无效':p.term?`${p.term} 期 · 息费率 ${p.percent}%`:'不分期';$('#installment-fee').textContent='本配置息费 '+financeMoney(p.fee);$('#installment-mixed').classList.toggle('hidden',currentProduct()?.installment!==null);
 const modifiedCosts=actualParts(c).filter(hasConfigCost).length,note=$('#profit-cost-note');note.classList.toggle('hidden',!modifiedCosts);note.textContent=modifiedCosts?`含 ${modifiedCosts} 项单独改价`:'';
 const warning=$('#erp-price-warning');warning.classList.toggle('hidden',!t.erpFallback&&!t.erpUnresolved);warning.textContent=`ERP价格未识别，请核算货源情况和价格。${t.erpFallback?` ${t.erpFallback} 项暂用核算成本代入。`:''}${t.erpUnresolved?` ${t.erpUnresolved} 项连核算成本也未填写，ERP 利润暂不显示。`:''}`;
 for(const [id,value] of [['excel-profit',t.taxProfitAfter],['erp-profit',t.erpProfit]]){const el=$('#'+id);el.dataset.profitTone=profitTone(value);el.textContent=financeMoney(value);if(id==='erp-profit'&&t.erpProfitAfter!==null&&p.term>0){const after=document.createElement('span');after.dataset.profitTone=profitTone(t.erpProfitAfter);after.textContent='（分期后实际 '+financeMoney(t.erpProfitAfter)+'）';el.append(after);}el.classList.toggle('loss',value!==null&&value<0);el.classList.toggle('gain',value!==null&&value>0);}
 if(document.activeElement!==input){input.value=c.price;input.setCustomValidity('');}
}
// NAS 摘要可能缺少运营费率，统计和提交前读取店铺范围内的配置正文。
function shopRateRows(shopId){
 return ordinaryConfigs(liveConfigs(listConfigs())).filter(c=>c.shopId===shopId);
}
async function loadShopRateRows(shopId,productId=null){
 const select=()=>shopRateRows(shopId).filter(c=>!productId||c.productId===productId);
 if(nasMain){
  if(activeShopId!==shopId)throw Error('店铺已切换，请重新打开。');
  await loadPriceDetails(select().map(c=>c.id),{isOpen:()=>activeShopId===shopId});
  if(activeShopId!==shopId)throw Error('店铺已切换，请重试。');
  const loaded=new Set(state.configs.map(c=>c.id));
  if(select().some(c=>!loaded.has(c.id)))throw Error('部分配置详情尚未载入，请重新打开。');
 }
 return select();
}
function bindShopRate(shopId){
 const input=$('#shop-overview-fee-rate'),button=$('#shop-fee-rate-save'),note=$('#shop-fee-rate-note');
 let loading=false;
 // 第一次打开费率页才载入全店配置，避免影响 ERP 设置首屏。
 $('[data-shop-tab="rule"]').addEventListener('click',async()=>{
  if(!input.disabled||loading)return;
  loading=true;
  try{
   const {rate,mixed}=commonOverviewFeeRate(await loadShopRateRows(shopId));
   if(!input.isConnected)return;
   input.value=String(rate);input.disabled=false;button.disabled=false;
   note.textContent=mixed?'当前各配置费率不完全一致':'';
  }catch(error){note.textContent=nasErrorText(error);}finally{loading=false;}
 });
 button.onclick=async()=>{
  button.disabled=true;
  try{
   const rate=readOverviewFeeRate(input.value);
   const rows=(await loadShopRateRows(shopId)).filter(c=>overviewFeeRate(c)!==rate);
   if(!button.isConnected)return;
   if(!rows.length){note.textContent='本店在用配置均已使用此费率。';return;}
   if(!confirm('将本店 '+rows.length+' 套在用配置的运营费率改为 '+rate+'%？主机模板与回收站保留原值。'))return;
   const title='全局修改本店运营费率';
   if(nasMain){
    if(!await replaceNasFields(rows.map(c=>({id:c.id,fields:{overviewFeeRate:rate}})),title))return;
   }else{
    checkpoint();
    for(const config of rows)config.overviewFeeRate=rate;
    changed(title,rows.map(c=>c.id),false,null,true);
   }
   if(button.isConnected)closeDialog();
   renderAll();globalThis.workbenchPriceProfitView?.refresh({force:true});continuousWorkbench?.draw();
   toast('已更新 '+rows.length+' 套配置的运营费率');
  }catch(error){toast(nasErrorText(error));}finally{button.disabled=false;}
 };
}
// 编辑店铺默认设置；涉及已有配置时通过全局检查点统一保存。
function openShopSettingsFull(shopId=activeShopId){
 const shop=shopById(shopId),settings=settingsFor(state,shop.id);
 openDialog('店铺设置',shopSettingsHtml({name:shop.name,settings,serviceText:defaultServiceText(state,shop.id),pricingHtml:pricingRuleFields('shop-price',effectivePricingRule({},settings)),erpShopId:settings.erpShopId||DEFAULT_ERP_SHOP_IDS[shop.id]||''}));
 bindShopRate(shop.id);
 const extrasEditor=bindShopSettings($('#shop-settings-panel'),{shopId:shop.id,sessionStatus:()=>erpMatchingRequest({action:'status'}),connect:credentials=>erpMatching.changeSession('connect',credentials),extras:shopErpExtras(shop.id,settings),search:query=>erpMatchingRequest({action:'match_search',payload:{query}}),errorText:error=>nasErrorText(error,listConfigs())});
 $('#shop-price-save').onclick=()=>{try{const rule=readPricingRuleFields('shop-price');checkpoint();state.shopSettings[shop.id].pricingRule=rule;changed('修改店铺核算参数',[]);closeDialog();renderAll();toast('本店核算参数已更新');}catch(error){toast(error.message);}};
 $('#shop-erp-save').onclick=async()=>{try{const raw=$('#shop-erp-id').value.trim(),id=raw?standardId(raw,'ERP 店铺 ID'):'';checkpoint();Object.assign(state.shopSettings[shop.id],{erpShopId:id,erpShopName:$('#shop-erp-name').value.trim(),erpDefaultExtras:extrasEditor.read()});changed('修改 ERP 店铺对应关系',[]);await save();closeDialog();toast('本店 ERP 对应关系已保存');}catch(e){toast(e.message);}};
 $('#coupon-save').onclick=()=>{const input=$('#shop-coupon'),value=Number(input.value);if(!input.value||!input.reportValidity()||!Number.isFinite(value)||value<0)return;checkpoint();state.shopSettings[shop.id].coupon=value;changed(`修改${shop.name}优惠券`,[]);closeDialog();toast('本店优惠券已更新');};
 $('#service-reset').onclick=()=>{$('#shop-service-text').value=DEFAULT_SERVICE_TEXT;};
 $('#service-save').onclick=()=>{const input=$('#shop-service-text');if(!input.reportValidity())return;checkpoint();const ids=saveServiceDefault(state,shop.id,input.value,$('#shop-service-existing').checked);changed(`修改${shop.name}默认服务承诺`,ids,true);closeDialog();renderAll();toast(`本店默认服务承诺已保存${ids.length?'，更新 '+ids.length+' 套配置':''}`);};
 if(nasMain){
  const expected=nasWorkspace.settingsVersion();
  let saving=false;
  const edit=async(button,update)=>{
   if(saving)return;saving=true;button.disabled=true;
   try{if(await update()!==false&&button.isConnected)closeDialog();}
   catch(error){toast(nasErrorText(error));}finally{saving=false;button.disabled=false;}
  };
  $('#shop-price-save').onclick=event=>edit(event.currentTarget,()=>saveNasSettings({pricingRule:readPricingRuleFields('shop-price')},expected));
  $('#shop-erp-save').onclick=event=>edit(event.currentTarget,()=>{
   const input=$('#shop-erp-id').value.trim();
   return saveNasSettings({erpShopId:input?standardId(input,'ERP 店铺 ID'):'',erpShopName:$('#shop-erp-name').value.trim(),erpDefaultExtras:extrasEditor.read()},expected);
  });
  $('#coupon-save').onclick=event=>edit(event.currentTarget,()=>{
   const input=$('#shop-coupon');if(!input.value||!input.reportValidity())throw Error('请输入有效券额。');
   return saveNasSettings({coupon:Number(input.value)},expected);
  });
  $('#service-save').onclick=event=>edit(event.currentTarget,async()=>{
   const value=$('#shop-service-text').value,updateExisting=$('#shop-service-existing').checked;
   let changes=[];
   if(updateExisting){
    await loadNasScope(available().map(c=>c.id));
    const next={...state,configs:clone(state.configs),shopSettings:clone(state.shopSettings)};
    const ids=new Set(saveServiceDefault(next,activeShopId,value,true));
    changes=await nasWorkspace.configurationChanges(next.configs.filter(c=>ids.has(c.id)).map(c=>({id:c.id,action:'replace',document:c})));
    if(changes.length&&!confirm(`先保存默认值，再单独更新 ${changes.length} 套仍使用旧默认值的在用配置？两个操作分别确认。`))return false;
   }
   await saveNasSettings({serviceText:value},expected);
   if(changes.length)try{if(!await startNasPlan('configurations',changes,{title:'更新保留旧默认承诺的配置'}))return false;}
    catch(error){throw Error('默认承诺已保存；既有配置更新未全部确认。'+nasErrorText(error));}
  });
 }
}
// 打开成员入口，成员身份由同步与登录界面维护。
function openOperator(){openDialog('当前操作人',`<p class="hint">此名称用于标记本机操作记录，可在交接时切换。</p><label class="field">操作人名称<input id="operator-name" maxlength="60" value="${esc(operator)}"></label><div class="actions"><button id="operator-save" class="primary">保存操作人</button></div>`);$('#operator-save').onclick=async()=>{const name=$('#operator-name').value.trim();if(!name)return toast('请输入操作人名称');try{await save();operator=name;localStorage.setItem('diy-operator',name);$('#operator-open').textContent='操作人：'+name;changed('切换操作人',[]);await save();closeDialog();toast('操作人已切换');}catch(e){toast(e.message);}};}
// 已保存的 NAS 模板快照同样从主机模板入口打开，按当前店铺过滤。
const savedHostTemplates=()=>nasMain?(state.templates||[]).filter(row=>row.shopId===activeShopId&&!row.deletedAt)
 .map(row=>({...row,configs:templateConfigs(row)})):[];
function hostTemplateGroup({kind,id,shopId}){
 if(shopId!==activeShopId)return null;
 const groups=kind==='saved'?savedHostTemplates():productGroups(legacyTemplateConfigs(available()));
 return groups.find(row=>row.id===id);
}
function showHostTemplate(view=null){
 pendingHostTemplate=null;
 if(hostTemplateView===view)return;
 hostTemplateView=view;
 if(view)$('#host-template-sheet .host-template-scroll')?.scrollTo(0,0);
}
function openHostTemplate(kind,id){
 selectZone('templates');templateSectionOpen=true;
 const shopId=activeShopId,key=JSON.stringify([shopId,kind,id]);
 let view=hostTemplateDrafts.get(key);
 if(!view){
  const empty=()=>({name:'',qty:1});
  view={kind,id,shopId,key,picked:new Set(),showIds:false,versions:new Map(),
   appearance:{机箱:empty(),散热:empty(),风扇:empty(),accessories:[empty()],changes:''}};
  hostTemplateDrafts.set(key,view);
 }
 if(hostTemplateView===view){pendingHostTemplate=null;return view;}
 // 配置组详情未到前保留原视图。快速连点时只显示最后选中的组。
 if(kind==='group'&&!view.draft){
  pendingHostTemplate=view;
  if(!view.loading)void loadHostTemplateView(view);
  return view;
 }
 showHostTemplate(view);
 // 左栏已有 NAS 模板全文，打开时直接使用本批目录资料，避免先清空再重载。
 if(kind==='saved'&&!view.draft&&!view.loading&&hostTemplateGroup(view))void loadHostTemplateView(view,false);
 else{
  renderList();
  if(!view.draft&&!view.loading)void loadHostTemplateView(view);
 }
 return view;
}
// 双击左栏名称进入当前模板的撤销栈，随模板一起保存。
function renameHostTemplate(kind,id,name){
 if(!canCreateTemplateLink(kind)||!name||name.length>160)return;
 const view=openHostTemplate(kind,id);
 if(!view?.draft||view.busy)return toast('模板正在载入，请稍后改名。');
 editTemplate(view.draft,next=>{next.name=name;});
 renderList();
}
async function loadHostTemplateView(view,refresh=true){
 view.loading=true;
 try{
  if(nasMain&&view.kind==='saved'&&refresh)await loadNasCatalog('templates');
  if(nasMain&&view.kind==='group'&&view.stale){
   const index=await readNasIndex(),remote=index.summaries.filter(row=>row.productId===view.id&&!row.deletedAt);
   const pending=new Set(nasWorkspace.drafts().map(row=>row.id));
   if(remote.some(row=>pending.has(row.id)))throw Error('模板有配置草稿，请先处理原配置的保存。');
   const ids=new Set(remote.map(row=>row.id));
   for(const id of ids){nasWorkspace.release(id);displayBaseline.delete(id);}
   state.configs=state.configs.filter(row=>!ids.has(row.id));
   acceptedState={...acceptedState,configs:acceptedState.configs.filter(row=>!ids.has(row.id))};
  }
  const original=hostTemplateGroup(view);
  if(!original)throw Error('模板已经变化，请重新打开。');
  if(view.kind==='group')await loadNasScope(original.configs.map(c=>c.id));
  const latest=hostTemplateGroup(view);
  if(!latest)throw Error('模板已移出当前店铺。');
  view.draft=newTemplateDraft(latest);
  view.version=view.kind==='saved'?catalogRow('templates',view.id)?.version:null;
  if(nasMain&&view.kind==='group')view.versions=new Map(latest.configs.map(c=>[c.id,nasWorkspace.configurationVersion(c.id)]));
  view.error='';view.stale=false;
 }catch(error){view.error=nasMain?nasErrorText(error):error.message;}
 finally{
  view.loading=false;
  if(pendingHostTemplate===view){
   pendingHostTemplate=null;
   if(view.shopId===activeShopId&&templateSectionOpen){
    if(view.draft)showHostTemplate(view);
    else if(view.error)toast(view.error);
   }
  }
  if(hostTemplateView===view)renderList();
 }
}
const canCreateTemplateLink=kind=>!nasMain||nasWorkspace.canPlan()&&(kind!=='saved'||nasWorkspace.canManage());
const hostTemplateHasDrafts=()=>[...hostTemplateDrafts.values()].some(view=>view.busy||view.draft&&templateDirty(view.draft));
function renderHostTemplateView(){
 if(pendingHostTemplate?.shopId!==activeShopId)pendingHostTemplate=null;
 const template=hostTemplateView&&hostTemplateGroup(hostTemplateView);
 let root=$('#host-template-sheet');
 const visible=!!template||hostTemplateView?.shopId===activeShopId&&!!hostTemplateView.draft&&templateDirty(hostTemplateView.draft);
 document.body.classList.toggle('host-template-mode',visible);
 if(!visible){
  if(hostTemplateView)showHostTemplate();
  if(root){root.hidden=true;root.replaceChildren();}
  return;
 }
 if(!root){root=document.createElement('section');root.id='host-template-sheet';$('.workspace').append(root);}
 root.hidden=false;
 const view=hostTemplateView;
 if(!view.draft){
  root.innerHTML=view.error?`<div role="alert">${esc(view.error)} <button type="button" id="host-template-retry">重试</button></div>`:'<p role="status">正在载入模板…</p>';
  const retry=root.querySelector('#host-template-retry');if(retry)retry.onclick=()=>loadHostTemplateView(view);
  return;
 }
 if(view.sourceCatalog!==state.sourceCatalog||view.costSource!==state.costSource){
  view.sourceCatalog=state.sourceCatalog;view.costSource=state.costSource;
  view.catalog=templateCatalog(currentCatalog(),available());
 }
 renderTemplateSheet(root,{view,esc,catalog:view.catalog,canEdit:canCreateTemplateLink(view.kind),canCreate:!!template&&!view.stale&&canCreateTemplateLink(view.kind),
  onClose:()=>{showHostTemplate();renderList();},
  onEdit:view.kind==='group'?id=>activate(id):null,
  onGenerate:ids=>openHostTemplateLink(view,ids),onSave:()=>saveHostTemplateView(view),
  onReload:()=>{
   if(templateDirty(view.draft)&&!confirm('放弃未保存的模板修改，重读已保存版本？'))return;
   if(!hostTemplateGroup(view)){hostTemplateDrafts.delete(view.key);showHostTemplate();renderList();return;}
   void loadHostTemplateView(view);
  },
  onManage:action=>manageHostTemplate(view,action),notice:toast,
  onChange:()=>{
   const card=$$('.host-template-card').find(el=>el.dataset.templateKind===view.kind&&el.dataset.templateId===view.id);
   if(!card)return;
   card.dataset.templateDirty=String(templateDirty(view.draft));
   card.dataset.templatePlatform=view.draft.data.platform;
   card.dataset.templateColor=view.draft.data.color;
   const label=card.querySelector('strong');label.textContent=label.title=view.draft.data.name;
   card.querySelector('small').textContent=view.draft.data.configs.length+' 套';
  },
  onCopy:async text=>{try{await navigator.clipboard.writeText(text);toast('选号单已复制，可以粘贴给 AI。');}catch{toast('复制失败，请选中右侧选号单手动复制。');}},
 });
}
async function refreshHostTemplateList(){
 try{await loadNasCatalog('templates');renderList();}
 catch(error){if(templateSectionOpen)toast(nasErrorText(error));}
}
function templateDocuments(view,data){
 const rows=clone(data.configs);
 const latest=hostTemplateGroup(view);
 const product={id:latest?.id||crypto.randomUUID(),name:data.name,shopId:view.shopId,category:'主机模板',configs:[]};
 if(!rows.length){const empty=blankConfig(null,product);empty.emptyLinkDraft=true;rows.push(empty);}
 const first=latest?.configs[0]?.workspaceOrder??0;
 return rows.map((row,i)=>({...row,product:data.name,productCategory:'主机模板',templatePlatform:data.platform,
  templateColor:data.color,workspaceOrder:Number(first)+i,parts:row.parts,actualParts:row.actualParts}));
}
/** 编号、移除和新增使用已有配置批次，目录模板使用带版本的原保存接口。 */
async function saveHostTemplateView(view){
 if(view.busy||!view.draft||!canCreateTemplateLink(view.kind)||!templateDirty(view.draft))return;
 const data=clone(view.draft.data);
 const latest=hostTemplateGroup(view);if(!latest)return toast('模板已变化，请重新打开。');
 view.busy=true;renderHostTemplateView();
 try{
  const rows=templateDocuments(view,data);
  if(nasMain&&view.kind==='saved'){
   await saveNasCatalog('templates',view.id,'replace',{...latest,name:data.name,platform:data.platform,color:data.color,configs:rows},{expected_version:view.version});
   view.version=catalogRow('templates',view.id)?.version;
  }else if(nasMain){
   const previous=new Map(view.draft.baseline.configs.map(c=>[c.id,c]));
   await loadNasScope([...previous.keys()]);
   const ids=new Set(rows.map(c=>c.id));
   const edits=rows.flatMap(row=>{
    const old=previous.get(row.id);
    if(!old)return [{id:row.id,action:'create',document:nasNewDocument({...row,productId:view.id},row.workspaceOrder)}];
    if(sameNasDocument(old,row))return [];
    return [{id:row.id,action:'replace',document:row,expected_version:view.versions.get(row.id)}];
   });
   for(const id of previous.keys())if(!ids.has(id))edits.push({id,action:'archive',expected_version:view.versions.get(id)});
   if(edits.length&&!await commitNasConfigs(edits,{title:'保存主机模板',group:{product_id:view.id,configuration_ids:[...previous.keys()]}}))return;
   const currentGroup=hostTemplateGroup(view);
   await loadNasScope(currentGroup.configs.map(c=>c.id));
   view.versions=new Map(currentGroup.configs.map(c=>[c.id,nasWorkspace.configurationVersion(c.id)]));
   data.configs=hostTemplateGroup(view).configs;
  }else await fullAction(async()=>{
   const previous=new Set(view.draft.baseline.configs.map(c=>c.id)),rowsById=new Map(rows.map(row=>[row.id,row]));
   const capacity=configCapacityMessage(state.configs,view.shopId,rows.length-previous.size);
   if(capacity)throw Error(capacity);
   checkpoint();
   for(const row of state.configs)if(previous.has(row.id)){
    const next=rowsById.get(row.id);if(next)Object.assign(row,next);else deleteConfigs([row],[row.id]);
   }
   state.configs.push(...rows.filter(row=>!previous.has(row.id)).map(row=>({...row,productId:view.id})));
   changed('保存主机模板',rows.map(row=>row.id));await save();
  })();
  view.draft=newTemplateDraft({...data,configs:nasMain&&view.kind==='group'?data.configs:rows});
  toast('主机模板已保存。');
 }catch(error){if(nasMain){if(['VERSION_CONFLICT','PRODUCT_MEMBERS_CHANGED'].includes(error.code))view.stale=true;toast(nasErrorText(error));}}
 finally{view.busy=false;renderList();}
}
async function createHostTemplate(data){
 const shopId=activeShopId,template=productTemplate(data.configs,data.name);
 Object.assign(template,{platform:data.platform,color:data.color});
 for(const row of template.configs){row.templatePlatform=data.platform;row.templateColor=data.color;}
 if(nasMain){
  if(!nasWorkspace.canManage())throw Error('当前账号不能创建模板。');
  await saveNasCatalog('templates',template.id,'create',template);
  openHostTemplate('saved',template.id);
 }else await fullAction(async()=>{
  checkpoint();state.templates.push(template);const rows=migrateSavedTemplates(state,shopId);
  changed('新增主机模板',rows.map(row=>row.id));await save();
  openHostTemplate('group',template.editorProductId);
 })();
}
function openCreateHostTemplate(){
 openDialog('新建主机模板',`<label class="field">模板名称<input id="host-template-new-name" maxlength="160"></label>
  <label class="field">平台<select id="host-template-new-platform"><option value="intel">Intel</option><option value="amd">AMD</option></select></label>
  <label class="field">颜色<select id="host-template-new-color"><option value="black">黑色</option><option value="white">白色</option></select></label>
  <div class="actions"><button type="button" class="primary" id="host-template-new-save">创建模板</button></div>`);
 const button=$('#host-template-new-save');
 button.onclick=async()=>{
  const name=$('#host-template-new-name').value.trim();if(!name)return toast('请输入模板名称。');
  const color=$('#host-template-new-color').value,platform=$('#host-template-new-platform').value;
  const empty=blankConfig(null,{id:crypto.randomUUID(),name,category:'主机模板',shopId:activeShopId,configs:[]});
  empty.emptyLinkDraft=true;button.disabled=true;
  try{await createHostTemplate({name,color,platform,configs:[empty]});if(button.isConnected)closeDialog();}
  catch(error){if(nasMain)toast(nasErrorText(error));}
  finally{button.disabled=false;}
 };
}
function importHostTemplate(){
 const input=document.createElement('input');input.type='file';input.accept='.json,application/json';
 input.onchange=async()=>{
  const file=input.files?.[0];if(!file)return;
  try{
   if(file.size>8*1024*1024)throw Error('模板文件不能超过 8 MiB。');
   const {format,shopId,name,platform,color,configs}=JSON.parse(await file.text());
   if(format!=='diy-host-template-v1'||shopId!==activeShopId||typeof name!=='string'||!name.trim()||name.length>160||
    !['intel','amd'].includes(platform)||!['black','white'].includes(color)||!Array.isArray(configs)||!configs.length||configs.length>100||
    configs.some(c=>c?.shopId!==shopId||!Array.isArray(c.parts)||!Array.isArray(c.actualParts)||!Array.isArray(c.modules)||!Array.isArray(c.addons)||
     [...c.parts,...c.actualParts].some(row=>!row||typeof row.slot!=='string'||typeof row.name!=='string'||
      typeof row.goodsId!=='string'||!Number.isInteger(row.qty)||row.qty<1||row.qty>1000)))
    throw Error('模板格式无效或属于其他店铺。');
   const copies=configs.map(c=>({...c,id:crypto.randomUUID(),skuId:'',spu:'',productUrl:''}));
   await createHostTemplate({name:name.trim(),platform,color,configs:copies});
  }catch(error){toast(nasMain?nasErrorText(error):error.message);}
 };
 input.click();
}
async function manageHostTemplate(view,action){
 if(view.busy)return;
 const data=view.draft.data;
 if(action==='export'){
  const doc={format:'diy-host-template-v1',shopId:view.shopId,...clone(data),configs:templateDocuments(view,data)};
  downloadBlob(new Blob([JSON.stringify(doc,null,2)],{type:'application/json'}),data.name.replace(/[<>:"/\\|?*]/g,'_')+'.json');return;
 }
 if(!canCreateTemplateLink(view.kind))return;
 if(action==='import'){importHostTemplate();return;}
 if(action==='rename'){
  const name=prompt('主机模板名称',data.name)?.trim();
  renameHostTemplate(view.kind,view.id,name);
  return;
 }
 view.busy=true;renderHostTemplateView();
 try{
  if(action==='duplicate'){
   const name=(data.name.slice(0,155)+' 副本'),configs=templateDocuments(view,data).map(c=>({...c,id:crypto.randomUUID(),skuId:'',spu:'',productUrl:''}));
   await createHostTemplate({...data,name,configs});
  }else if(action==='delete'){
   if(view.kind==='saved'){
    if(!confirm('将「'+data.name+'」移入回收站？'))return;
    await saveNasCatalog('templates',view.id,'archive',null,{expected_version:view.version});
   }else{
    const template=hostTemplateGroup(view);
    if(!template)return;
    await removeConfigurations(template.configs.map(c=>c.id));
    if(hostTemplateGroup(view))return;
   }
   hostTemplateDrafts.delete(view.key);showHostTemplate();
  }
 }catch(error){toast(nasMain?nasErrorText(error):error.message);}
 finally{view.busy=false;renderList();}
}
// 仅复制勾选行和右侧已明确选择的外观，NAS 创建走原批量回执。
function openHostTemplateLink(view,ids){
 if(!ids.length||!canCreateTemplateLink(view.kind)||view.appearance.changes.trim())return;
 const title='从主机模板生成草稿链接',selection=new Set(ids),draft=clone(view.draft.data),appearance=clone(view.appearance);
 const sources=draft.configs.filter(c=>selection.has(c.id)&&!c.emptyLinkDraft);
 if(sources.length!==ids.length)return toast('请勾选有效配置。');
 const unresolved=new Map();
 const pendingGpu=source=>{const gpu=templatePart(source,'显卡');return gpu&&!gpu.goodsId&&gpu.name!=='无卡'?(gpu.templateSpec||gpuSpec(gpu)):null;};
 for(const source of sources){const spec=pendingGpu(source);if(spec){const group=unresolved.get(spec.label)||{spec,count:0};group.count++;unresolved.set(spec.label,group);}}
 const choices=[...unresolved.values()];
 const gpuFields=choices.map(({spec,count},i)=>{
  const candidates=rankedTemplateGpus(view.catalog,spec,draft.color);
  return `<label class="field">${esc(spec.label)} · ${count} 套<select data-host-template-gpu="${i}">
   ${candidates.map(row=>`<option value="${esc(row.sourceId)}">${esc(row.name)} · ${esc(row.goodsId)} · 库存 ${esc(row.stockAvailable??'未知')} · ERP ${esc(row.erp??'未知')}</option>`).join('')}
   <option value="">先不选，生成后再补</option></select></label>`;
 }).join('');
 openDialog('生成新链接',`<p class="hint">将「${esc(draft.name)}」中勾选的 ${ids.length} 套配置生成到草稿区。</p>
  <label class="field">新链接名称<input id="host-template-link-name" maxlength="160" value="${esc(draft.name)}"></label>${gpuFields}
  <div class="actions"><button type="button" class="primary" id="host-template-link-save">生成到草稿区</button></div>`);
 const button=$('#host-template-link-save'),nameInput=$('#host-template-link-name');
 nameInput.focus();nameInput.select();
 nameInput.onkeydown=event=>{if(event.key==='Enter'&&!event.isComposing){event.preventDefault();button.click();}};
 button.onclick=async()=>{
  if(button.disabled)return;
  const name=nameInput.value.trim();
  if(!name)return toast('请输入新链接名称。');
  button.disabled=nameInput.disabled=true;
  const selectedGpus=new Map(choices.map(({spec},i)=>[spec.label,$(`[data-host-template-gpu="${i}"]`).value]));
  const apply=async()=>{
   if(nasMain&&view.kind==='saved'){
    await loadNasCatalog('templates');
    if(catalogRow('templates',view.id)?.version!==view.version){view.stale=true;throw Error('模板内容已变化，请读取最新模板。');}
   }else if(nasMain){
    const index=await readNasIndex(),rows=index.summaries.filter(row=>row.productId===view.id&&!row.deletedAt);
    if(rows.length!==view.versions.size||rows.some(row=>row.nasVersion!==view.versions.get(row.id))){
     view.stale=true;throw Error('模板内容已变化，请读取最新模板。');
    }
    const pending=new Set(nasWorkspace.drafts().filter(row=>row.pending).map(row=>row.id));
    if(ids.some(id=>pending.has(id)))throw Error('模板配置有待确认的保存，请先核对结果。');
   }
   if(!button.isConnected||!$('#dialog').open||activeShopId!==view.shopId)return;
   const capacity=configCapacityMessage(available(),activeShopId,ids.length);
   if(capacity)throw Error(capacity);
   const catalog=currentCatalog();
   for(const config of sources)applyTemplateAppearance(config,catalog,appearance,selectedGpus.get(pendingGpu(config)?.label));
   const shop=activeShopId;
   const {rate}=commonOverviewFeeRate(await loadShopRateRows(shop));
   if(!button.isConnected||!button.closest("dialog")?.open||activeShopId!==shop)return;
   const added=draftLinkFromTemplate(sources,shop,name);
   for(const config of added)config.overviewFeeRate=rate;
   if(nasMain){
    if(!await createNasConfigs(added,title))return;
   }else{
    checkpoint();state.configs.push(...added);active=added[0].id;selected=new Set([active]);
    changed(title,added.map(c=>c.id));
   }
   showHostTemplate();
   selectZone('draft');collapsedZones.delete('draft');collapsedProducts.delete(added[0].productId);
   $('#search').value='';$('#link-category-filter').value='';
   if(nasMain)renderList();else renderAll();
   if(button.isConnected)closeDialog();
   toast(`已生成草稿链接，共 ${added.length} 套配置。`);
  };
  try{if(nasMain)await apply();else await fullAction(apply)();}
  catch(error){if(nasMain){if(view.stale&&button.isConnected)closeDialog();renderList();toast(nasErrorText(error));}}
  finally{button.disabled=nameInput.disabled=false;}
 };
}
// 按店铺、链接和筛选条件绘制左侧列表，折叠组不创建隐藏配置节点。
function renderList(){closeLinkCardMenu();const listMenu=document.querySelector('.list-actions-menu');if(listMenu)listMenu.open=false;const q=$('#search').value.trim().toLowerCase();if(searchCollapse.q!==q){searchCollapse.q=q;searchCollapse.products.clear();searchCollapse.zones.clear();}const productCollapse=q?searchCollapse.products:collapsedProducts,zoneCollapse=q?searchCollapse.zones:collapsedZones,allGroups=productGroups(ordinaryConfigs(available())),filter=$('#link-category-filter'),filterValue=filter.value;filter.innerHTML='<option value="">全部分类</option><option value="none">未分类</option>'+linkCategories().map(cat=>`<option value="cat:${esc(cat)}">${esc(cat)}（${allGroups.filter(g=>g.category===cat).length}）</option>`).join('');filter.value=filterValue;const groups=allGroups.filter(g=>categoryMatches(g.configs[0])),listed=listedConfigs();$('#count').textContent=groups.length+' 个 · '+groups.reduce((n,g)=>n+g.configs.length,0)+' 套';$('#selected-count').textContent='批量已选 '+selected.size+' 套';$('#batch-export').textContent=selected.size?`导出勾选（${selected.size}）`:'导出勾选';$('#batch-export').disabled=!selected.size;let clearSelection=$('#clear-selection');if(!clearSelection){clearSelection=document.createElement('button');clearSelection.id='clear-selection';$('#selected-count').after(clearSelection);}clearSelection.textContent='清空';clearSelection.disabled=!selected.size;clearSelection.onclick=()=>{selected.clear();renderList();};$('#select-all').checked=listed.length>0&&listed.every(c=>selected.has(c.id));$('#select-all').indeterminate=listed.some(c=>selected.has(c.id))&&!$('#select-all').checked;$('#select-all').disabled=!listed.length;$('#delete-selected').disabled=!selected.size;$('#link-recycle-shortcut').textContent=nasMain&&!archivedCounts.has(activeShopId)?'回收站':'回收站（'+(nasMain?archivedCounts.get(activeShopId):localArchivedConfigs().length)+'）';
 const renderGroup=group=>{const matchGroup=[group.name,group.url,group.spu].join(' ').toLowerCase().includes(q);const configs=group.configs.filter(c=>matchGroup||[c.name,c.shortName,c.skuId,...c.parts.map(p=>p.name)].join(' ').toLowerCase().includes(q));if(!configs.length)return '';const expanded=!productCollapse.has(group.id);return `<section class="product-group ${expanded?'expanded':''} ${group.id===current()?.productId?'editing-product':''}" data-list-product="${esc(group.id)}" ${group.cardColor?`style="--link-card-color:${group.cardColor};--link-card-display-color:${cardDisplayColor(group.cardColor)}" data-link-colored`:""}>${linkCardHeading(group,{expanded,editing:group.id===current()?.productId,esc})}<div ${expanded?'':'hidden'}>${expanded?configs.map(c=>`<div class="config-item ${active===c.id?'active':''}" data-id="${esc(c.id)}" tabindex="0" role="button" aria-current="${active===c.id?'true':'false'}" aria-label="打开 ${esc(c.name)}"><input type="checkbox" ${selected.has(c.id)?'checked':''} aria-label="勾选 ${esc(c.name)}"><div><strong>${esc(c.name)} · ${esc(c.version)}</strong>${configurationSummaryHtml(c,esc)}</div></div>`).join(''):''}</div></section>`;};
 // 主机模板位于草稿区上方；普通链接仍可用卡片菜单移入或移出草稿区。
 const isDraft=g=>g.configs.some(c=>c.productDraft),drafts=groups.filter(isDraft),linked=groups.filter(g=>!isDraft(g));
 const zone=(key,title,list,empty)=>{const open=!zoneCollapse.has(key),body=list.map(renderGroup).join('');return `<button type="button" class="list-zone-heading list-zone-${key}" data-zone-toggle="${key}" aria-expanded="${open}"><span class="zone-arrow">${open?'▼':'▶'}</span><span class="zone-title">${title}</span><small>${list.length} 个</small></button>${open?(body||`<p class="hint list-zone-empty">${empty}</p>`):''}`;};
 reactWorkbench.list($('#config-list'),zone('draft','草稿区',drafts,'暂无草稿。链接卡片右侧「⋯」可移到草稿区')+zone('links','链接区',linked,'暂无链接'));
 $$('[data-zone-toggle]').forEach(b=>b.onclick=e=>{const key=b.dataset.zoneToggle,list=$('#config-list'),keep=list.scrollTop;
  if(e.target.closest('.zone-arrow')||selectedZone===key)zoneCollapse.has(key)?zoneCollapse.delete(key):zoneCollapse.add(key);
  else{showHostTemplate();selectZone(key);}
  renderList();list.scrollTop=keep;});
 mountTemplateArea({render:model=>reactWorkbench.templates($('#config-list'),model),container:$('#config-list'),configs:available(),
  savedTemplates:savedHostTemplates(),opened:templateSectionOpen,
  templateView:hostTemplateView,canRename:canCreateTemplateLink,draftFor:(kind,id)=>hostTemplateDrafts.get(JSON.stringify([activeShopId,kind,id]))?.draft,
  onToggle:event=>{
   if(event.target.closest('.zone-arrow')||selectedZone==='templates')templateSectionOpen=!templateSectionOpen;
   else selectZone('templates');
   if(!templateSectionOpen)showHostTemplate();
   renderList();
   if(templateSectionOpen&&nasMain)void refreshHostTemplateList();
  },
  onOpenGroup:openHostTemplate,onRename:renameHostTemplate,onAddTemplate:openCreateHostTemplate,onImportTemplate:importHostTemplate,
  onManage:action=>{if(hostTemplateView?.draft)void manageHostTemplate(hostTemplateView,action);},esc
 });
 paintZones();
 bindLinkCardMenus($('#config-list'),{
  groups:()=>productGroups(available()),esc,
  onEdit:group=>openProduct(true,group),
  onDraft:async(group,flag)=>{
   const shopId=activeShopId,ids=group.configs.map(c=>c.id),label=flag?'移到草稿区':'移回链接区';fullActionBusy++;
   try{
    if(nasMain)return await updateNasProduct(group,{productDraft:flag},label);
    for(const id of ids)await loadDetail(id);
    const rows=state.configs.filter(c=>ids.includes(c.id)&&!c.deletedAt&&c.shopId===shopId&&c.productId===group.id);
    if(activeShopId!==shopId||rows.length!==ids.length)throw Error('链接范围已变化，请重试');
    checkpointConfig(ids);rows.forEach(c=>{if(flag)c.productDraft=true;else delete c.productDraft;});
    changed(label,ids,false,null,true);renderList();toast(group.name+' 已'+label);
   }catch(error){toast(error.message);}finally{fullActionBusy--;}
  },
  onDuplicate:group=>duplicateLinkToDraft(group),
  onDelete:async group=>{try{if(nasMain)return archiveNasConfigs(group.configs.map(c=>c.id),group);await save();await removeConfigurations(available().filter(c=>c.productId===group.id).map(c=>c.id));await save();}catch(error){toast(error.message);}},
  onColor:async(group,color)=>{
   const shopId=activeShopId,ids=group.configs.map(c=>c.id);fullActionBusy++;
   try{
    if(group.cardColor===color)return;
    if(nasMain)return await updateNasProduct(group,{productCardColor:color},'修改链接卡片颜色');
    toast('正在应用链接配色…');
    // 卡片元数据只需要该链接详情，不能为一次选色载入所有店铺。
    for(const id of ids)await loadDetail(id);
    const rows=state.configs.filter(c=>ids.includes(c.id)&&!c.deletedAt&&c.shopId===shopId&&c.productId===group.id);
    if(activeShopId!==shopId||rows.length!==ids.length)throw Error('链接范围已变化，请重新选择配色');
    checkpointConfig(ids);rows.forEach(c=>c.productCardColor=color);
    changed('修改链接卡片颜色',ids,false,null,true);renderList();
   }catch(error){toast(error.message);}finally{fullActionBusy--;}
  },
  onCategory:group=>{
   openDialog('修改链接分类',`<p class="hint">${esc(group.name)}</p><label class="field">分类名称<input id="quick-category-name" maxlength="40" list="quick-category-options" value="${esc(group.category)}" placeholder="选择或输入分类，留空为未分类"><datalist id="quick-category-options">${linkCategories().map(cat=>`<option value="${esc(cat)}"></option>`).join('')}</datalist></label><div class="actions"><button id="quick-category-save" class="primary">保存分类</button></div>`);
   if(nasMain){$('#quick-category-save').onclick=async()=>{try{await updateNasProduct(group,{productCategory:$('#quick-category-name').value.trim()},'修改链接分类');closeDialog();}catch(error){toast(nasErrorText(error));}};return;}
   $('#quick-category-save').onclick=fullAction(()=>{group=productGroups(available()).find(p=>p.id===group.id);const category=$('#quick-category-name').value.trim();if(category!==group.category){checkpoint();group.configs.forEach(c=>c.productCategory=category);changed('修改链接分类',group.configs.map(c=>c.id));}if(category==='主机模板'){templateSectionOpen=true;collapsedProducts.delete(group.id);}closeDialog();renderList();if(current()?.productId===group.id)renderProduct();});
  }
 });
 let context=$('#editing-context');if(!context){context=document.createElement('div');context.id='editing-context';$('#config-list').before(context);}const editing=current();context.classList.toggle('hidden',!editing);context.innerHTML=editing?`<div><small>正在编辑</small><strong title="${esc(editing.product)}">${esc(editing.product)}</strong><span>${esc(editing.name)} · ${esc(editing.version)}</span></div><button id="locate-editing" title="展开当前商品链接并显示正在编辑的配置">展开当前</button>`:'';if(editing)$('#locate-editing').onclick=()=>{collapsedZones.delete(editing.productDraft?'draft':'links');if(isLegacyTemplateConfig(editing))templateSectionOpen=true;$('#search').value='';$('#link-category-filter').value='';for(const group of productGroups(available()))if(group.id!==editing.productId)collapsedProducts.add(group.id);collapsedProducts.delete(editing.productId);renderList();const list=$('#config-list'),item=[...list.querySelectorAll('.config-item')].find(el=>(el.dataset.id===active||el.dataset.templateConfigId===active)),header=item?.closest('.product-group').querySelector('.product-select-row,.product-toggle');if(item){list.scrollTop+=item.getBoundingClientRect().top-list.getBoundingClientRect().top-(header?.offsetHeight||0)-8;item.focus({preventScroll:true});item.classList.add('config-located');setTimeout(()=>item.classList.remove('config-located'),1800);}};
 $$('[data-group-select]').forEach(box=>{const configs=groups.find(g=>g.id===box.dataset.groupSelect).configs;box.checked=configs.every(c=>selected.has(c.id));box.indeterminate=configs.some(c=>selected.has(c.id))&&!box.checked;box.onchange=()=>{configs.forEach(c=>box.checked?selected.add(c.id):selected.delete(c.id));renderList();};});
 $$('[data-product-toggle]').forEach(b=>b.onclick=event=>{const id=b.dataset.productToggle,list=$('#config-list'),keep=list.scrollTop;
  // 点箭头：原地展开或收起，列表不跳动、不置顶。
  // 箭头先转 150ms 再重绘列表，让展开/收起有「跟着动」的过程。
  const flip=()=>{const open=productCollapse.has(id);open?productCollapse.delete(id):productCollapse.add(id);const arrow=b.querySelector('.link-arrow');if(arrow)arrow.style.transform=open?'rotate(90deg)':'rotate(0deg)';b.setAttribute('aria-expanded',String(open));setTimeout(()=>{renderList();$('#config-list').scrollTop=keep;},150);};
  if(event.target.closest('.link-arrow')){
   const opening=productCollapse.has(id);flip();
   // 展开其他链接才跟到首套；保留左栏原滚动位置。
   const first=opening&&current()?.productId!==id&&productGroups(available()).find(g=>g.id===id)?.configs[0];
   if(first){selectZone(first.productDraft?'draft':'links');void activate(first.id).finally(()=>{list.scrollTop=keep;});}
   return;
  }
  // 点卡片：打开该链接；只有开了「点开时展开」才展开，且都不置顶。
  // 11-19：已经选中的链接，再点一下就展开/收起（箭头跟着转），不切换配置、不置顶。
  if(current()?.productId===id){flip();return;}
  if(expandOnOpen())productCollapse.delete(id);
  const first=productGroups(available()).find(g=>g.id===id)?.configs[0];
  if(first&&current()?.productId!==id)Promise.resolve(activate(first.id)).finally(()=>{list.scrollTop=keep;});else{renderList();list.scrollTop=keep;}
 });
 bindLinkDrag($('#config-list'),(fromId,target)=>moveLinkTo(fromId,target));
 bindConfigDrag($('#config-list'),nasMain?moveNasConfig:fullAction((from,to,after)=>{const next=moveConfig(state.configs,from,to,after);if(!next)return;checkpoint();state.configs=next;changed('调整配置顺序',[],true);const scroll=$('#config-list').scrollTop;renderList();$('#config-list').scrollTop=scroll;}));
 $$('.config-item[data-id]').forEach(el=>{el.querySelector('input').onclick=e=>{e.stopPropagation();el.querySelector('input').checked?selected.add(el.dataset.id):selected.delete(el.dataset.id);renderList();};const locate=async()=>{await activate(el.dataset.id);if(current()?.id===el.dataset.id)continuousWorkbench?.locate(el.dataset.id);};el.onclick=locate;el.onkeydown=e=>{if(e.target===el&&e.key==='Enter')locate();};});
 syncScrollHighlight(current());
 renderHostTemplateView();
}
// 链接日常操作直接显示，导出回 WPS 和图片标题设置收进更多菜单。
function renderProduct(){const p=currentProduct();$('#product-panel').innerHTML=`<div class="product-heading"><div><strong>${esc(p.name)}</strong><small>${esc(p.category||'未分类')} · ${p.configs.length} 套配置 · ${p.installment===null?'分期设置不一致':p.installment?p.installment+' 期分期':'不分期'}${p.url?' · '+esc(p.url):' · 尚未填写商品网址'}</small></div></div><div class="product-actions"><button id="edit-product">链接设置</button><button id="add-template">从模板添加</button><button id="overview">配置总览</button><button id="copy-open">选中配置导出</button><button id="save-product-template">整组存为模板</button><button id="add-special-page">添加升级展示页</button><button id="product-stock-check">一键检查该链接库存</button><details class="action-menu ov-link-more"><summary>更多链接操作</summary><div class="action-menu-body"><button id="wps-export-open">导出回 WPS</button><button id="poster-title-settings">图片标题与摘要</button></div></details></div>`;$('#wps-export-open').onclick=(nasMain?fn=>nasScopeAction(fn,()=>currentProduct()?.configs||[]):fullAction)(()=>openWpsExport(currentProduct().configs,{openDialog,selectedIds:selected}));$('#edit-product').onclick=()=>openProduct(true);$('#overview').onclick=openOverview;$('#copy-open').onclick=()=>openCopy();$('#add-template').onclick=()=>openTemplates();if(nasMain){
 // 换码保存后，按当前链接已保存的编码重新核对维护表。
 if(activeShopId==='intel'&&nasWorkspace.canPlan()){
  const quoteButton=document.createElement('button');
  quoteButton.type='button';quoteButton.textContent='从维护表重新核价';
  quoteButton.onclick=()=>openNasWorkbookQuotes(p.configs.map(row=>row.id));
  $('.ov-link-more .action-menu-body').append(quoteButton);
 }
 const copyLink=document.createElement('button');copyLink.id='duplicate-product';copyLink.type='button';copyLink.textContent='创建副本';copyLink.title='整条链接复制到草稿区';copyLink.onclick=()=>duplicateLinkToDraft(p);$('#overview').before(copyLink);for(const id of ['edit-product','duplicate-product','add-special-page'])$('#'+id).hidden=!nasWorkspace.canPlan();}$('#save-product-template').onclick=openSaveProductTemplate;$('#poster-title-settings').onclick=openPosterTitles;$('#product-stock-check').onclick=nasMain?()=>openStockCheckFull(p):fullAction(()=>openStockCheckFull(p));$('#add-special-page').onclick=nasMain?()=>addNasToProduct(p,true):fullAction(()=>{const capacityError=configCapacityMessage(state.configs,activeShopId,1);if(capacityError)return toast(capacityError);if(p.installment===null){toast('请先统一本链接的分期设置');return openProduct(true);}checkpoint();const c=blankConfig(null,p,'颜值升级包',defaultServiceText(state,activeShopId));c.version='';c.posterFields={name:true,version:false,subtitle:false};c.footer='';c.modules=modulesDefault(c.shopId,c.theme).map(m=>({...m,visible:m.type==='header',...(m.type==='service'?{text:defaultServiceText(state,activeShopId)}:{})}));const m=c.modules.find(m=>m.type==='parts');if(m)m.visible=false;c.modules.push({id:crypto.randomUUID(),type:'custom',title:'颜值升级包',text:'点击预览文字编辑内容',visible:true,size:22,weight:600,gap:16});state.configs.push(c);active=c.id;selected=new Set([c.id]);changed('新增特殊页面');renderAll();});}
// 通过导航令牌忽略较早点击的迟到结果，成功后才切换当前配置。
async function activate(id){
 const token=++activationGeneration;
 pendingHostTemplate=null;
 try{
  if(!fullWorkspace)await loadDetail(id);
  if(token!==activationGeneration)return;
  const previousShop=current()?.shopId;
  posterEditor?.clear();active=id;
  if(hostTemplateView){selectZone(isLegacyTemplateConfig(current())?'templates':current()?.productDraft?'draft':'links');showHostTemplate();}
  const shopIds=new Set(available().map(c=>c.id));
  selected=new Set([...selected].filter(value=>shopIds.has(value)));
  if(expandOnOpen())collapsedProducts.delete(current().productId);
  if(previousShop===current().shopId)renderCompact([id]);else renderAll();
  pruneDetails();
 }catch(error){
  if(token===activationGeneration){
   const locked=previewConfigId!==current()?.id||(nasMain&&nasEditorLocked());
   $('#poster-stage').inert=locked;$('#poster-inspector').inert=locked;toast(error.message);
  }
 }
}
// 切换店铺主题、设置和配件目录，统一更新对应导航信息。
function renderShop(){observeSourceAlertShop();const shop=currentShop(),card=$('#shop-card');card.dataset.shop=shop.id;$('#shop-picker').value=shop.id;const brand=$('#shop-brand');brand.replaceChildren();if(shop.brandLogo){const logo=document.createElement('img');logo.src=globalThis.resolveWorkbenchAsset?.(shop.brandLogo.src)||shop.brandLogo.src;logo.alt=shop.brandText;logo.className='shop-brand-image';brand.append(logo);}else brand.textContent=shop.brandText;$('#shop-settings').textContent='店铺设置';$('#shop-settings').title='优惠券与默认服务承诺';document.title=`${shop.name} · DIY 配置工作台`;}
bindScrollPreview((id,productId)=>{
 if(tab!=='parts'||hostTemplateView||$('#dialog').open||nasBusy||current()?.productId!==productId)return;
 if(document.activeElement?.matches('input, textarea, select, [contenteditable="plaintext-only"]'))return;
 if(available().some(c=>c.id===id&&c.productId===productId))void activate(id);
});
// 重画工作台完整视图；全量归一只适用于完整工作区，避免修改未加载摘要。
function renderAll(historyIds=null,persistNormalization=true){if(!fullWorkspace)return renderCompact();invalidateSaveScope(state,'renderAll migrations and shared presentation normalization');queueMicrotask(()=>globalThis.workbenchPriceProfitView?.refresh());previewNavigation?.render();const migrated=migrateSavedTemplates(state,activeShopId);if(persistNormalization&&migrated.length)changed('将已保存模板归入主机模板',[],false,null,true);const themeIds=applyProductThemes(ordinaryAvailable());if(persistNormalization&&themeIds.length)changed('跟随链接图片主题',themeIds,'asset');const viewIds=applyPosterView(ordinaryAvailable().filter(c=>!c.fixedInitialFormat),currentSettings().posterView);if(persistNormalization&&viewIds.length)changed('统一配置图视图',viewIds,'asset');if(current())normalizePosterDesign(current());rememberDisplayParts(historyIds);renderShop();const empty=!current();for(const child of document.querySelector('.main').children){if(child.classList.contains('page-heading'))continue;child.classList.toggle('hidden',child.id==='empty-state'?!empty:empty);}$('.preview-side').classList.toggle('hidden',empty);for(const id of ['delete-current','duplicate','copy-shop'])$('#'+id).disabled=empty;for(const button of $$('[data-editor-open]'))button.disabled=empty;updateHeading();renderList();if(empty){void continuousWorkbench?.render();$('#empty-state h2').textContent=ordinaryAvailable().length?'请从左侧选择需要编辑的配置':`${currentShop().name}暂无日常配置，可在左侧展开主机模板`;previewToken++;releasePreview();clearImageCache();return;}renderProduct();renderConfigFields();$('#layout').value=current().layout;$('#poster-auto-width').checked=current().autoWidth===true;updateSkuControls();$('#name-format').value=current().nameFormat||'compact';$$('[data-theme]').forEach(el=>{el.classList.toggle('active',el.dataset.theme===current().theme);el.disabled=false;});renderEditor();updateSummary();schedulePreview();const record=imageRecords.get(active);$('#image-status').textContent=record?`图片已保存 · r${record.revision}`:'当前版式预览';$('#saved-image').classList.toggle('hidden',!record);if(record)$('#saved-image').href=record.url;}
// React 基本信息字段直接提交到现有配置，简称自动/手动和撤销语义保持不变。
function renderConfigFields(){reactWorkbench.fields(current(),()=>checkpointConfig(),(field,value)=>{current()[field]=value;if(field==='shortName'){current().shortNameAuto=false;syncPosterShortName(current());}changed('编辑配置基本信息');});}
// 普通切换只刷新目标配置相关区域，减少全量列表和配置处理。
function renderCompact(detailIds=loadedIds()){if(nasMain)queueMicrotask(syncNasControls);queueMicrotask(()=>globalThis.workbenchPriceProfitView?.refresh());previewNavigation?.render();if(current())normalizePosterDesign(current());rememberDisplayParts(detailIds);renderShop();const empty=!current();for(const child of document.querySelector('.main').children){if(child.classList.contains('page-heading'))continue;child.classList.toggle('hidden',child.id==='empty-state'?!empty:empty);}$('.preview-side').classList.toggle('hidden',empty);for(const id of ['delete-current','duplicate','copy-shop'])$('#'+id).disabled=empty;for(const button of $$('[data-editor-open]'))button.disabled=empty;updateHeading();renderList();if(empty){void continuousWorkbench?.render();$('#empty-state h2').textContent=ordinaryAvailable().length?'请从左侧选择需要编辑的配置':`${currentShop().name}暂无日常配置，可在左侧展开主机模板`;previewToken++;releasePreview();clearImageCache();return;}renderProduct();renderConfigFields();$('#layout').value=current().layout;$('#poster-auto-width').checked=current().autoWidth===true;updateSkuControls();$('#name-format').value=current().nameFormat||'compact';$$('[data-theme]').forEach(el=>{el.classList.toggle('active',el.dataset.theme===current().theme);el.disabled=false;});renderEditor();updateSummary();schedulePreview();const record=imageRecords.get(active);$('#image-status').textContent=record?`图片已保存 · r${record.revision}`:'当前版式预览';$('#saved-image').classList.toggle('hidden',!record);if(record)$('#saved-image').href=record.url;}
let previewFrame=null,previewBusy=false,requestedPreviewToken=null,previewConfigId=null,previewShopId=null,overviewPreviewLayout='long';
const overviewPreviewActive=()=>document.body.classList.contains('overview-mode')&&!$('.preview-side').classList.contains('preview-expanded');
// 方图预览跟随导出样式。选“按配置样式”后，切换配置时重新读取该配置的样式。
function overviewPreviewMode(config){
 if(overviewPreviewLayout==='long')return 'long';
 const style=$('#image-export-sku-mode').value;
 return style==='saved'?skuImageMode(config):style;
}
function updateOverviewPreviewButtons(){
 const mode=overviewPreviewMode(current());
 for(const button of $$('[data-ov-preview]'))button.setAttribute('aria-pressed',String(button.dataset.ovPreview===mode));
}
function setOverviewPreviewLayout(layout){
 overviewPreviewLayout=layout;
 updateOverviewPreviewButtons();
 schedulePreview();
}
// 只覆盖渲染用副本的版式，展开自由编辑时继续读取配置本身。
function previewConfigForLayout(){
 const config=withAddonPackText(clone(current()));
 if(overviewPreviewActive()){
  const mode=overviewPreviewMode(config);
  config.layout=overviewPreviewLayout;
  if(mode!=='long')config.skuMode=config.skuExportMode=mode;
 }
 return config;
}
// 合并连续输入的预览请求，避免每个按键都排队生成完整画布。
// 同店切换时保留屏幕上的旧图，释放编辑对象并锁住操作，等新图完成后一次换上。
function releasePreview(keepDisplayed=false){
 posterEditor?.release();
 if(previewResult?.canvas){previewResult.canvas.width=0;previewResult.canvas.height=0;}
 previewResult=null;previewConfigId=null;
 if(!keepDisplayed){previewShopId=null;const canvas=$('#poster');canvas.width=0;canvas.height=0;}
}
function schedulePreview(){
 const config=current(),sameShop=!!config&&previewShopId===config.shopId;
 if((previewConfigId&&previewConfigId!==config?.id)||(previewShopId&&!sameShop)){
  $('#poster-stage').inert=true;$('#poster-inspector').inert=true;
  $('#download').disabled=true;
  releasePreview(sameShop);clearImageCache();
 }
 requestedPreviewToken=++previewToken;
 if(previewFrame===null&&!previewBusy)previewFrame=requestAnimationFrame(()=>{previewFrame=null;renderScheduledPreview(previewToken);});
}
// 将已完成的画布结果显示到预览区，并更新编辑器交互范围。
function paintPreview(result){const locked=nasMain&&nasEditorLocked();$('#poster-stage').inert=locked;$('#poster-inspector').inert=locked;const dest=$('#poster');if(dest.width!==result.canvas.width)dest.width=result.canvas.width;if(dest.height!==result.canvas.height)dest.height=result.canvas.height;const ctx=dest.getContext('2d');ctx.clearRect(0,0,dest.width,dest.height);ctx.drawImage(result.canvas,0,0);posterEditor?.render(result);$('#overflow').classList.toggle('hidden',!result.overflow);$('#overflow').textContent='内容超出画布，请移动或缩小对象，或恢复自动排版后导出。';$('#download').disabled=false;}
// 异步生成当前预览，使用令牌丢弃切换配置之前的过期画布。
async function renderScheduledPreview(token){if(!current())return;const c=previewConfigForLayout();previewBusy=true;try{const result=await renderPreviewPoster(c,{exportWidth:defaultPosterWidth(c),displayWidth:posterEditor?.previewWidth()||700,devicePixelRatio:window.devicePixelRatio,geometry:previewConfigId===c.id&&previewResult?.previewLayout===c.layout?previewResult:undefined});if(token!==previewToken){result.canvas.width=0;result.canvas.height=0;return;}if(previewResult?.canvas&&previewResult.canvas!==result.canvas){previewResult.canvas.width=0;previewResult.canvas.height=0;}previewResult=result;previewConfigId=c.id;previewShopId=c.shopId;paintPreview(result);$('#dimensions').textContent=`${result.exportWidth} × ${Math.ceil(result.height*result.exportWidth/result.base)} px · ${c.layout==='long'?'紧凑详情图':(skuImageMode(c)==='padded'?'1:1 详情补白':'1:1 专用 SKU')}`;$('#overflow').classList.toggle('hidden',!result.overflow);$('#overflow').textContent='内容超出画布，请移动或缩小对象，或恢复自动排版后导出。';$('#download').disabled=false;}catch(e){if(token===previewToken){if(!previewResult)releasePreview();$('#overflow').textContent=e.message;$('#overflow').classList.remove('hidden');$('#download').disabled=false;}}finally{previewBusy=false;if(token!==previewToken&&requestedPreviewToken===previewToken&&previewFrame===null)previewFrame=requestAnimationFrame(()=>{previewFrame=null;renderScheduledPreview(previewToken);});}}
// 切换配置编辑子页并刷新对应控件，不重新加载完整配置数据。
function switchTab(name){tab=name;$$('[data-tab]').forEach(b=>{b.classList.toggle('active',b.dataset.tab===tab);b.setAttribute('aria-selected',String(b.dataset.tab===tab));});renderEditor();syncScrollHighlight(current());}
// 局部刷新当前配置在列表中的展示，保持搜索和展开状态。
function refreshCurrentListPart(){const c=current();if(!c)return;for(const element of document.querySelectorAll('#config-list .config-item[data-id],[data-template-config-id]')){if((element.dataset.id||element.dataset.templateConfigId)!==c.id)continue;const label=element.querySelector('strong'),detail=element.querySelector('small');if(element.dataset.templateConfigId&&label){label.textContent=templateConfigLabel(c);label.title=label.textContent;}if(detail){if(element.dataset.templateConfigId)detail.textContent=c.parts.find(p=>p.slot==='CPU')?.name||'待配置配件';else{detail.classList.add('config-hardware-summary');detail.textContent=configurationSummaryText(c);detail.title=configurationHardwareSummary(c);detail.setAttribute('aria-label','CPU、显卡、内存、硬盘：'+detail.title);}}}}
// 生成当前配置编辑控件并绑定字段修改，所有修改经检查点和 changed 处理。
function renderEditor(){
 const c=current(),el=$('#editor'),packPage=c&&['addon-packs','benefits'].includes(tab);
 renderAddonPage(packPage?c:null);
 el.hidden=Boolean(packPage);
 if(continuousWorkbench){continuousWorkbench.render();if(tab==='parts'&&c)return;}
 if(packPage||!c)return;
 /* 销毁上一页搜索订阅后才替换节点，避免旧异步扫描回写。 */
 $$('[data-part-search]').forEach(destroyProductSearch);c.modules=posterModules(c);
 if(tab==='parts'||tab==='display'||tab==='actual'){
  const isActual=tab==='actual',parts=isActual?ensureActualParts(c):c.parts,editorCatalog=currentCatalog();
  const partConfig=()=>isActual?{...c,parts,addons:[]}:c;
  if(!reactWorkbench.editor(el,editorModel(isActual?'actual':'parts',c,{parts,catalog:editorCatalog,costs:state.costSource||[],copiedPart})))el.innerHTML=`<p class="hint">${isActual?'用于成本、利润、表格复制和库存导出；这里的修改不会回写展示清单。名称请在输出源维护中修改。':'用于消费者配置图；选择配件或修改数量会同步该项到实际配置；上方按输出源选择配件；下方展示名称只用于配置图，留空沿用输出源名称。拖动配件名称下方的 ⠿ 手柄调整图片顺序。'}</p>${isActual?'<button id="copy-actual-table">复制当前实际配置到维护表</button>':''}<div class="part-head"><span>配件</span><span>${isActual?'实际型号':'展示型号'} / ERP ID</span><span>数量</span><span>${isActual?'':'图片'}</span><span></span></div>`+parts.map((p,i)=>`<div ${isActual?'':'data-sort-part'} class="part-row ${!isActual&&p.posterVisible===false?'poster-hidden-part':''}"><span class="part-label">${esc(p.slot)}${isActual?'':`<button type="button" class="part-drag-handle" data-part-drag draggable="true" aria-label="拖动排序${esc(p.slot)}" title="拖动调整顺序，也可聚焦后按上下方向键">⠿</button>`}</span><div class="part-model"><div data-part-search="${i}"><input type="search" data-part-name="${i}" aria-label="${esc(p.slot)}配件搜索" placeholder="搜索配件名称或 ERP ID" autocomplete="off" value="${esc(isActual?p.name:editorCatalog.find(row=>row.sourceId===p.sourceId&&row.goodsId===p.goodsId)?.name||p.name)}"></div>${isActual?'':`<label class="display-name-field">展示名称<input type="text" data-display-name="${i}" aria-label="${esc(p.slot)}展示名称" maxlength="200" placeholder="${esc(p.name)}" value="${esc(p.displayName||'')}"></label>`}<small>${isSpecialComponent(p)?'特殊配件 · 成本 ¥0':'ID '+esc(p.goodsId||'未绑定')}</small>${isActual?componentStockHtml(p):''}<div class="part-transfer"><button data-copy-part="${i}">复制配件</button><button data-paste-part="${i}" ${copiedPart&&copiedPart.shopId===c.shopId?'':'disabled'}>粘贴替换</button></div></div><input type="number" min="1" step="1" value="${p.qty}" data-qty="${i}" aria-label="${esc(p.slot)}数量">${isActual?'<span></span>':`<label class="poster-part-toggle" title="${p.posterVisible===false?'图片已隐藏，仍计入成本与维护表':'配置图显示'}"><input type="checkbox" data-poster-visible="${i}" ${p.posterVisible!==false?'checked':''}><span>显示</span></label>`}<button data-remove-part="${i}" aria-label="移除${esc(p.slot)}">×</button></div>`).join('')+`<button id="part-add" class="wide">＋ 添加配件</button>`;
  $$('[data-poster-visible]').forEach(input=>input.onchange=()=>{checkpointConfig([c.id]);parts[input.dataset.posterVisible].posterVisible=input.checked;changed(input.checked?'显示配置图配件':'隐藏配置图配件');renderEditor();});
  $$('[data-display-name]').forEach(input=>{input.onfocus=()=>checkpointConfig();input.onchange=()=>{const part=parts[input.dataset.displayName],name=input.value.trim();if(name===(part.displayName||''))return;if(!name||name===part.name)delete part.displayName;else part.displayName=name;markSourceFieldManual(part,'name');changed('自定义展示配件名称');renderEditor();};});
  $$('[data-qty]').forEach(input=>{input.onfocus=()=>checkpointConfig();input.oninput=()=>{const q=Number(input.value);if(!Number.isInteger(q)||q<1){input.setCustomValidity('数量必须是正整数');return;}input.setCustomValidity('');parts[input.dataset.qty].qty=q;changed('修改配件数量');};});
  $$('[data-copy-part]').forEach(b=>b.onclick=()=>{copiedPart=copyPartPayload(partConfig(),Number(b.dataset.copyPart));renderEditor();toast(`已复制 ${copiedPart.part.name}，可切换配置后粘贴替换`);});
  if(!isActual)mountPartSort(el,(from,to)=>{checkpointConfig([c.id]);parts.splice(to,0,parts.splice(from,1)[0]);changed('调整展示配件顺序');renderEditor();});
  $$('[data-paste-part]').forEach(b=>b.onclick=()=>{try{const index=Number(b.dataset.pastePart),after=clone(partConfig());pastePartPayload(after,index,copiedPart,currentCatalog());checkpointConfig([c.id]);if(isActual)c.actualParts=after.parts;else Object.assign(c,after);changed('粘贴替换配件及关联加购');renderAll();}catch(e){toast(e.message);}});
  $$('[data-part-search]').forEach(root=>mountProductSearch(root,{
   deferred:true,stableRows:true,getRows:()=>editorCatalog,getCosts:()=>state.costSource,idKey:'sourceId',inputElement:root.querySelector('[data-part-name]'),
   label:'搜索配件',placeholder:'输入名称或 ERP ID，点击下方结果替换',emptySelection:'',
   describe:x=>`${isSpecialComponent(x)?'特殊配件 · 成本 ¥0':'ERP ID '+(x.goodsId||'未绑定')} · ERP ¥${money(x.erp)} · 含税 ¥${money(x.tax)}${x.erpName?' · ERP 原名：'+x.erpName:''}${x.originalName?' · 原名：'+x.originalName:''}`,
   onChange:x=>{if(!x)return;checkpointConfig([c.id]);replaceSourcePart(partConfig(),Number(root.dataset.partSearch),x);changed('更换配件');renderEditor();refreshCurrentListPart();}
  }));
  $$('[data-remove-part]').forEach(b=>b.onclick=()=>{checkpointConfig([c.id]);parts.splice(Number(b.dataset.removePart),1);changed('移除配件');renderEditor();});
  if(isActual)$('#copy-actual-table').onclick=async()=>{try{const text=copyMaintenanceText([c],'parts');try{await navigator.clipboard.writeText(text);toast(`已复制当前实际配置的 ${text.split('\t').length} 列，含 ERP ID 和数量`);}catch{copyKind='parts';openCopy([c]);}}catch(e){toast(e.message);}};
  $('#part-add').onclick=()=>{const slot=slots.find(s=>!parts.some(p=>p.slot===s));if(!slot)return toast('16 个配件栏已用完');checkpointConfig([c.id]);parts.push({slot,name:'',goodsId:'',qty:1,erp:null,tax:null,upgrade:''});changed('添加配件');renderEditor();};
 }else if(tab==='perks'){
  const sections=['addons','benefits'].map(kind=>({kind,module:c.modules.find(module=>module.type===kind),rows:posterExtraRows(c,kind)}));
  if(!reactWorkbench.editor(el,editorModel(tab,c)))el.innerHTML=`<div class="poster-extras-editor"><div class="poster-extras-context"><strong>${esc(c.name)}</strong><span>编辑当前配置图片中的加购、选配与专属福利</span></div>${sections.map(section=>`<section class="poster-extras-section"><div class="poster-extras-heading"><h3>${section.kind==='addons'?'加购与选配':'专属福利'}</h3><label><input type="checkbox" data-extra-visible="${section.kind}" ${section.module&&section.module.visible!==false?'checked':''}>显示在配置图中</label></div><p class="hint">支持多行文案，空白内容不会出图。</p>${section.rows.map(entry=>`<div class="poster-extra-entry"><label class="field">${section.kind==='addons'?'加购 / 选配文案':'福利文案'}<textarea data-extra-kind="${section.kind}" data-extra-index="${entry.index}" data-extra-field="text" rows="3">${esc(entry.text||'')}</textarea></label><label class="field">补充说明（可留空）<textarea data-extra-kind="${section.kind}" data-extra-index="${entry.index}" data-extra-field="note" rows="2">${esc(entry.note||'')}</textarea></label><button type="button" data-remove-extra="${section.kind}" data-extra-index="${entry.index}">移除此条</button></div>`).join('')||'<p class="poster-extras-empty">暂未填写内容</p>'}<button type="button" data-add-extra="${section.kind}">${section.kind==='addons'?'＋ 添加加购或选配':'＋ 添加专属福利'}</button></section>`).join('')}<p class="hint">文字随当前配置保存，并同步到右侧配置图预览。</p></div>`;
  // 只改文字与明确的显示开关，保存、撤销及预览继续走配置原有流程。
  $$('[data-extra-field]').forEach(input=>{input.onfocus=()=>checkpointConfig([c.id]);input.oninput=()=>{editPosterExtra(c,input.dataset.extraKind,Number(input.dataset.extraIndex),input.dataset.extraField,input.value);changed('编辑加购选配和福利文案');};});
  $$('[data-add-extra]').forEach(button=>button.onclick=()=>{checkpointConfig([c.id]);addPosterExtra(c,button.dataset.addExtra);changed('添加加购选配或福利');renderEditor();});
  $$('[data-remove-extra]').forEach(button=>button.onclick=()=>{checkpointConfig([c.id]);removePosterExtra(c,button.dataset.removeExtra,Number(button.dataset.extraIndex));changed('移除加购选配或福利');renderEditor();});
  $$('[data-extra-visible]').forEach(input=>input.onchange=()=>{checkpointConfig([c.id]);setPosterExtraVisible(c,input.dataset.extraVisible,input.checked);changed('切换加购选配或福利显示');});
 }else if(tab==='addons'){
  if(!reactWorkbench.editor(el,editorModel(tab,c,{costs:state.costSource||[]})))el.innerHTML=`<div class="editor-section"><h3>逐项升级说明</h3><p class="hint">展示在对应配件下方；未选购的升级不计入成本。</p>${c.parts.map((p,i)=>`<label>${esc(p.slot)}<input data-upgrade="${i}" value="${esc(displayUpgrade(p,c))}" class="${doubleMemoryUpgrade(p)?'memory-upgrade-warning':''}" placeholder="例如：+199 元升级…">${partHardwareWarning(p,c)?`<small class="memory-upgrade-warning">主板升级可能与机箱不兼容，默认不展示，可手动选择。</small><select data-hardware-upgrade="${i}" aria-label="主板升级文案展示"><option value="">不展示不兼容文案</option><option value="use" ${hardwareUpgradeSelected(p,c)?'selected':''}>${esc(p.upgrade)}</option></select>`:''}${doubleMemoryUpgrade(p)?`<small class="memory-upgrade-warning">当前内存已为 2 条，以下双条升级默认不展示，可手动选择。</small><select data-memory-upgrade="${i}" class="memory-upgrade-warning" aria-label="内存双条升级候选"><option value="">不展示此升级</option><option value="use" ${displayUpgrade(p,c)?'selected':''}>${esc(p.upgrade)}</option></select>`:''}</label>`).join('')}</div><div class="editor-section"><h3>加购与选配</h3><p class="hint">一条加购可组合多个商品、合计核算成本，只输出一条描述。关联原配件可选；独立加购不随配件替换。</p>${c.addons.map((p,i)=>`<div class="entry-row addon-card"><div><strong>${esc(p.text||'未填写加购描述')}</strong><p>${esc(p.note)}</p>${addonHardwareWarning(p,c)?`<small class="memory-upgrade-warning">主板加购可能与机箱不兼容，默认不展示，可手动选择。</small><select data-hardware-addon="${i}" aria-label="主板加购文案展示"><option value="">不展示不兼容文案</option><option value="use" ${hardwareUpgradeSelected(p,c)?'selected':''}>展示已勾选的加购文案</option></select>`:''}${addonStatusHtml(p,state.costSource,c.parts)}<small>${p.sourceId?'随配件切换：'+esc(c.parts.find(x=>x.sourceId===p.sourceId)?.name||'原关联配件'):'独立加购'}</small></div><div><button data-edit-addon="${i}">编辑加购</button><button data-remove-addon="${i}">移除</button></div></div>`).join('')}<button id="add-addon">＋ 添加选配</button></div><div class="editor-section"><h3>福利点</h3><p class="hint">只填写真实提供的福利，空白模块不会输出。</p>${c.benefits.map((p,i)=>`<div class="entry-row"><input data-benefit="${i}" value="${esc(p.text)}" aria-label="福利点 ${i+1}"><button data-remove-benefit="${i}">移除</button></div>`).join('')}<button id="add-benefit">＋ 添加福利点</button></div>`;
  $$('[data-upgrade]').forEach(input=>{input.onfocus=()=>checkpointConfig();input.oninput=()=>{const part=c.parts[input.dataset.upgrade];part.upgrade=input.value;markSourceFieldManual(part,'upgrade');part.memoryUpgradeConfirmed=memoryUpgradeKey(part);changed('编辑升级说明');};});
  // 手动选择只改变图片展示，原始文案、加购勾选和实际配件均保留。
  $$('[data-hardware-upgrade]').forEach(select=>select.onchange=()=>{checkpointConfig([c.id]);selectHardwareUpgrade(c.parts[select.dataset.hardwareUpgrade],c,select.value==='use');changed('选择主板升级文案展示');renderEditor();});
  $$('[data-hardware-addon]').forEach(select=>select.onchange=()=>{checkpointConfig([c.id]);selectHardwareUpgrade(c.addons[select.dataset.hardwareAddon],c,select.value==='use');changed('选择主板加购文案展示');renderEditor();});
  $$('[data-memory-upgrade]').forEach(select=>select.onchange=()=>{checkpointConfig([c.id]);const part=c.parts[select.dataset.memoryUpgrade];if(select.value==='use')part.memoryUpgradeConfirmed=memoryUpgradeKey(part);else delete part.memoryUpgradeConfirmed;changed('选择内存双条升级说明');renderEditor();});
  // 显式编辑或移除选项时退出整组跟随，防止下次载入把用户删掉的方案重新添加。
  const commitAddon=(index,value)=>{
   const before=index===null?null:c.addons[index],owners=new Set([before?.sourceId,value.sourceId].filter(Boolean));
   const followed=new Set([...c.addons.filter(a=>a.followAll===true).map(a=>a.sourceId),...c.parts.filter(p=>p.sourceFollow?.upgrade?.structured===true).map(p=>p.sourceId)]);
   if(value.sourceId&&c.addons.some((a,i)=>i!==index&&a.sourceId===value.sourceId&&(before?.sourceId!==value.sourceId||(a.variantId||'')===(value.variantId||''))))throw Error('该配件的这个加购方案已存在，请编辑已有方案');
   checkpointConfig([c.id]);if(index===null)c.addons.push(value);else c.addons[index]=value;
   for(const owner of owners)if(followed.has(owner)&&!(value.sourceId===owner&&value.followPolicy==='follow'&&value.followAll===true))detachAddonFollow(c,owner);
   changed('编辑加购描述与关联商品');closeDialog();renderEditor();
  };
  const editAddon=index=>openAddonEditor({react:reactWorkbench,openDialog,allowFollow:nasMain,getSourceRows:()=>currentCatalog().filter(row=>c.parts.some(p=>p.sourceId===row.sourceId)),getCosts:()=>state.costSource,initial:index===null?{text:'',note:''}:c.addons[index],getOriginals:()=>c.parts,owners:c.parts.filter((p,i,all)=>p.sourceId&&all.findIndex(x=>x.sourceId===p.sourceId)===i),commit:value=>commitAddon(index,value)});
  $$('[data-edit-addon]').forEach(b=>b.onclick=()=>editAddon(Number(b.dataset.editAddon)));$$('[data-remove-addon]').forEach(b=>b.onclick=()=>{checkpointConfig([c.id]);const [removed]=c.addons.splice(Number(b.dataset.removeAddon),1);if(removed?.sourceId&&(removed.followAll===true||c.parts.some(p=>p.sourceId===removed.sourceId&&p.sourceFollow?.upgrade?.structured===true)))detachAddonFollow(c,removed.sourceId);changed('移除加购');renderEditor();});$('#add-addon').onclick=()=>editAddon(null);
  $$('[data-benefit]').forEach(input=>{input.onfocus=()=>checkpointConfig();input.oninput=()=>{c.benefits[input.dataset.benefit].text=input.value;changed('编辑福利点');};});
  for(const type of ['benefit']){$$(`[data-remove-${type}]`).forEach(b=>b.onclick=()=>{checkpointConfig([c.id]);c[type==='addon'?'addons':'benefits'].splice(Number(b.dataset[type==='addon'?'removeAddon':'removeBenefit']),1);changed('移除选配或福利点');renderEditor();});$(`#add-${type}`).onclick=()=>{checkpointConfig([c.id]);c[type==='addon'?'addons':'benefits'].push({text:'',note:''});changed('添加选配或福利点');renderEditor();};}
 }else if(tab==='modules'){
  const palette={...shopPalette(c.shopId,c.theme),...c.palette};
  if(!reactWorkbench.editor(el,editorModel(tab,c,{palette,fonts:POSTER_FONTS,selectedModule})))el.innerHTML=`<div class="inline-grid editor-section"><label class="field">店铺标题<input id="shop-title" value="${esc(c.shop)}"></label><label class="field">字体<select id="font-family">${POSTER_FONTS.map(f=>`<option ${posterFontFamily(c.fontFamily)===f?'selected':''}>${f}</option>`).join('')}</select></label></div><div class="row-tools editor-section"><label><input id="case-visible" type="checkbox" ${c.caseVisible!==false?'checked':''}> 显示机箱图</label><label><input id="upgrades-visible" type="checkbox" ${c.showUpgrades?'checked':''}> 升级说明</label></div><div class="inline-grid editor-section"><label class="field">升级文字颜色<input id="upgrade-color" type="color" value="${c.upgradeColor||palette.accent}"></label><label class="field">升级文字字号<input id="upgrade-size" type="number" min="10" max="30" value="${c.upgradeSize}"></label><label class="field">升级字重<select id="upgrade-weight">${[400,500,600,700].map(w=>`<option ${Number(c.upgradeWeight)===w?'selected':''}>${w}</option>`).join('')}</select></label></div><div class="editor-section"><div class="row-tools"><h3>整体配色</h3><button id="reset-palette">恢复本店主题</button><button id="batch-style-editor">批量应用配色与格式</button></div><div class="palette-fields">${Object.entries({bg:'画布背景',panel:'配件底色',text:'主体文字',accent:'强调与数量',muted:'辅助文字',line:'分隔线'}).map(([key,label])=>`<label class="field">${label}<input type="color" data-palette="${key}" value="${palette[key]}"></label>`).join('')}</div><p class="hint">调整主体文字色会同步清除普通模块和局部文字颜色；服务承诺可单独配色。</p></div><p class="hint">点击右侧预览中的具体文字，可单独调整字体与颜色。这里管理整块默认样式、顺序和显示开关；空模块自动隐藏。</p>${c.modules.map((m,i)=>`<div class="module ${selectedModule===m.id?'selected':''}" data-module="${esc(m.id)}"><div class="module-top"><span class="drag" draggable="true" title="按住拖动，蓝线表示插入位置" aria-label="拖动调整模块顺序">⠿ 拖动</span><input type="checkbox" data-module-visible="${i}" ${m.visible?'checked':''} aria-label="显示${esc(m.title)}"><strong>${esc(m.title)}</strong><button data-move="${i}" data-dir="-1" aria-label="上移${esc(m.title)}">↑</button><button data-move="${i}" data-dir="1" aria-label="下移${esc(m.title)}">↓</button>${m.type==='custom'?`<button data-delete-module="${i}">×</button>`:''}</div><div class="module-fields"><label>字号<input data-module-field="size" data-index="${i}" type="number" min="10" max="50" value="${m.size}"></label><label>字重<select data-module-field="weight" data-index="${i}">${[400,500,600,700].map(w=>`<option ${m.weight==w?'selected':''}>${w}</option>`).join('')}</select></label><label>颜色<input data-module-field="color" data-index="${i}" type="color" value="${m.color||(m.type==='service'?'#ffffff':palette.text)}"></label><label>下方间距<input data-module-field="gap" data-index="${i}" type="number" min="0" max="60" value="${m.gap}"></label><label>模块标题<input data-module-field="title" data-index="${i}" value="${esc(m.title)}"></label><button data-reset-color="${i}">跟随主题</button>${m.type==='service'?`<label>背景色<input data-module-field="background" data-index="${i}" type="color" value="${m.background||'#173e76'}"></label><label>字体<select data-module-field="fontFamily" data-index="${i}"><option value="">跟随配置字体</option>${POSTER_FONTS.map(f=>`<option value="${f}" ${posterFontFamily(m.fontFamily)===f?'selected':''}>${f}</option>`).join('')}</select></label>`:''}</div>${['custom','service'].includes(m.type)?`<textarea data-custom-text="${i}" aria-label="${m.type==='service'?'服务承诺文字':'自定义模块内容'}">${esc(m.text||'')}</textarea>`:''}</div>`).join('')}<button id="add-module">＋ 自定义文字模块</button><label class="field editor-section" style="margin-top:20px">页脚说明<textarea id="footer-text">${esc(c.footer)}</textarea></label>`;
  $$('[data-palette]').forEach(input=>{input.onfocus=()=>checkpointConfig();input.oninput=()=>{c.palette??={};c.palette[input.dataset.palette]=input.value;if(input.dataset.palette==='text'){for(const m of c.modules)if(m.type!=='service')m.color='';for(const [key,style] of Object.entries(c.textStyles||{}))if(!c.modules.some(m=>m.type==='service'&&key.startsWith(m.id+'.')))delete style.color;}if(input.dataset.palette==='accent'){c.upgradeColor='';for(const [key,style] of Object.entries(c.textStyles||{}))if(/\.(label|qty|upgrade)$/.test(key)||key==='header.brand'||key==='header.subtitle')delete style.color;}changed('修改整体配色');};});
   $('#reset-palette').onclick=()=>{checkpointConfig([c.id]);c.palette=shopPalette(c.shopId,c.theme);if(c.themePalettes)delete c.themePalettes[c.theme];c.upgradeColor=shopUpgradeColor(c.shopId,c.theme);for(const m of c.modules)if(m.type==='service')m.background=shopServiceColor(c.shopId,c.theme);else m.color='';for(const [key,style] of Object.entries(c.textStyles||{}))if(!c.modules.some(m=>m.type==='service'&&key.startsWith(m.id+'.')))delete style.color;changed('恢复整体主题配色');renderEditor();};
  $('#batch-style-editor').onclick=openBatchStyle;
  for(const [selector,key,kind] of [['#shop-title','shop','text'],['#font-family','fontFamily','text'],['#case-visible','caseVisible','check'],['#upgrades-visible','showUpgrades','check'],['#upgrade-color','upgradeColor','text'],['#upgrade-size','upgradeSize','number'],['#upgrade-weight','upgradeWeight','number'],['#footer-text','footer','text']]){const input=$(selector);input.onfocus=()=>checkpointConfig();input.oninput=()=>{c[key]=kind==='check'?input.checked:kind==='number'?Math.max(10,Number(input.value)||14):input.value;changed('调整模块样式');};}
  $$('[data-module-visible]').forEach(input=>input.onchange=()=>{checkpointConfig([c.id]);c.modules[input.dataset.moduleVisible].visible=input.checked;changed('切换模块显示');});
  $$('[data-module-field]').forEach(input=>{input.onfocus=()=>checkpointConfig();input.oninput=()=>{const key=input.dataset.moduleField,m=c.modules[input.dataset.index];m[key]=['size','weight','gap'].includes(key)?Math.max(key==='gap'?0:10,Math.min(key==='weight'?700:60,Number(input.value)||0)):input.value;changed('调整模块样式');};});
  $$('[data-custom-text]').forEach(input=>{input.onfocus=()=>checkpointConfig();input.oninput=()=>{c.modules[input.dataset.customText].text=input.value;changed('编辑文字模块');};});
  const move=(from,to)=>{if(from===to||to<0||to>=c.modules.length)return;checkpointConfig([c.id]);c.modules.splice(to,0,c.modules.splice(from,1)[0]);changed('调整模块顺序');renderEditor();};
  $$('[data-move]').forEach(b=>b.onclick=()=>move(Number(b.dataset.move),Number(b.dataset.move)+Number(b.dataset.dir)));
  bindModuleDrag(el,move);
  $$('[data-reset-color]').forEach(b=>b.onclick=()=>{checkpointConfig([c.id]);c.modules[b.dataset.resetColor].color='';changed('恢复主题文字色');renderEditor();});
  $$('[data-delete-module]').forEach(b=>b.onclick=()=>{checkpointConfig([c.id]);c.modules.splice(Number(b.dataset.deleteModule),1);changed('删除文字模块');renderEditor();});
  $('#add-module').onclick=()=>{checkpointConfig([c.id]);c.modules.push({id:crypto.randomUUID(),type:'custom',title:'补充说明',text:'',visible:true,size:17,weight:400,color:'',gap:16});changed('添加文字模块');renderEditor();};
 }else{
  const settings=currentPricingSettings(),p=pricing(c,settings),t=totals(c,settings,p);
  const erpCell=part=>{const unit=erpUnitCost(part);return unit.cents===null?'待补成本':`¥${money(unit.cents/100)}${unit.fallback?'<small class="erp-fallback-note">核算成本代入</small>':''}`;};
  if(!reactWorkbench.editor(el,editorModel(tab,c,{parts:actualParts(c),t,p,money})))el.innerHTML=`<div class="row-tools"><button id="batch-config-cost" class="primary">批量修改价格</button><button id="open-shared-costs">打开三店共用成本源</button><button id="import-erp">查看 ERP 同步说明</button></div><p class="hint shared-source-note">默认使用三店共用成本源；可单独修改当前配置的含税单价，黄色文字标记修改项。恢复共用价后重新跟随成本源。</p>${t.erpFallback||t.erpUnresolved?'<p class="erp-price-warning">ERP价格未识别，请核算货源情况和价格。</p>':''}<table class="cost-table"><thead><tr><th>配件</th><th>ERP 单价</th><th>含税单价</th><th>数量</th><th>含税合计</th></tr></thead><tbody>${actualParts(c).map((part,index)=>`<tr><td>${esc(part.slot)}</td><td>${erpCell(part)}</td><td>${configCostCell(part,index,money)}</td><td>${part.qty}</td><td>${part.tax==null?'待填':'¥'+money(part.tax*part.qty)}</td></tr>`).join('')}</tbody></table><div class="summary-grid"><div><small>核算成本（含扣点和固定费用）</small><strong>${financeMoney(t.basis)}</strong></div><div><small>EXCEL 利润（扣分期费）</small><strong data-profit-tone="${profitTone(t.taxProfitAfter)}">${financeMoney(t.taxProfitAfter)}</strong></div><div><small>ERP 利润</small><strong data-profit-tone="${profitTone(t.erpProfit)}">${t.erpProfit===null?'待补成本':'¥'+money(t.erpProfit)+(p.term>0&&t.erpProfitAfter!=null?'<span data-profit-tone="'+profitTone(t.erpProfitAfter)+'">（分期后实际 ¥'+money(t.erpProfitAfter)+'）</span>':'')}</strong></div><div><small>ERP 未识别 / 待核算行</small><strong>${t.missing}</strong></div></div><p class="hint">含税价更新时间：${c.taxUpdatedAt?new Date(c.taxUpdatedAt).toLocaleString():'未人工同步'}<br>ERP 导入时间：${c.erpImportedAt?new Date(c.erpImportedAt).toLocaleString():'未同步'}</p>`;
  const batchCost=()=>openBatchConfigCost({openDialog,toast,productId:c.productId,getConfigs:ordinaryAvailable,getSelectedIds:()=>chosen().map(c=>c.id),apply:plan=>applyBatchChanges(plan,`批量修改含税单价：${plan.changes.length} 套配置`)});
  $('#batch-config-cost').onclick=nasMain?nasScopeAction(batchCost):batchCost;
  $('#open-shared-costs').onclick=openCosts;$('#import-erp').onclick=openErp;
  if(nasMain){
   $('#open-shared-costs').textContent='当前店铺核算价';$('#import-erp').textContent='读取 ERP 资料';
   const hint=el.querySelector('.shared-source-note');if(hint)hint.textContent='使用本店的有效成本。可单独修改本配置的含税单价，黄色标记表示单独价。';
  }
  bindConfigCosts(el,c,{react:reactWorkbench,parts:ensureActualParts(c),costs:state.costSource||[],openDialog,closeDialog,checkpoint:()=>checkpointConfig([c.id]),changed,render:renderEditor});
 }
}
// 复用业务对话框容器，替换内容后由调用方绑定本次操作。
function openDialog(title,html,{headerHtml=''}={}){
 window.workbenchSourceEditor?.detachForDialog?.();
 const dialog=$('#dialog'),heading=$('#dialog-title'),body=$('#dialog-body');
 dialog.classList.remove('price-changes-dialog','template-editor-dialog','global-batch-dialog','profit-check-dialog','template-dialog','link-parts-dialog','source-dialog','source-quick-dialog','cost-dialog','overview-dialog','inventory-dialog','case-gallery-dialog','activity-dialog');
 heading.parentElement.querySelector('.activity-header')?.remove();
 heading.textContent=title;
 if(headerHtml)heading.insertAdjacentHTML('afterend',headerHtml);
 body.querySelectorAll('.product-search').forEach(destroyProductSearch);
 reactWorkbench.release(body);body.innerHTML=html;
 if(title==='配置总览')dialog.classList.add('overview-dialog');
 if(title==='操作记录'&&headerHtml)dialog.classList.add('activity-dialog');
 dialog.scrollTop=0;body.scrollTop=0;if(!dialog.open)dialog.showModal();
}
// 关闭当前业务弹窗，保留工作台和草稿状态。
function closeDialog(){$('#dialog').close();}
// NAS 试验入口只在原生明确配置后显示；不替换本机保存、同步或其他店铺入口。
if(!nasMain)installNasWorkspace({openDialog,esc,draftStorage:configDraftStorage,notify:message=>toast(message)}).catch(()=>{});
// 格式化配件库存展示，区分未知库存与真实零库存。
function componentStockHtml(part){const stock=componentStockView(part,state.costSource||[]);return `<small class="component-stock stock-${stock.status}" title="${esc(stock.detail)}">${esc(stock.label)}${stock.status==='unknown'?`<span>${esc(stock.detail)}</span>`:''}</small>`;}
// 复制配置时通过完整工作区创建新标识，避免复用旧配置身份。
// 按当前店铺和维护表布局读取本机公式，批量导出只为每店读取一次。
function copyMaintenanceText(configs,kind,template){
 const scope=nasMain?nasWorkspace.sharedPreviewScope():'local',cache=new Map();
 return copyText(configs,kind,template,shopId=>{
  if(!cache.has(shopId)){
   const short=maintenanceUsesLocator(shopId,template);
   cache.set(shopId,readPartFormulas(localStorage,scope,shopId,short,short?slots.slice(0,14):slots));
  }
  return cache.get(shopId);
 });
}
// 导出预览和公式设置共用当前模板，设置成功后立即重算预览。
function openCopyFull(configs=chosen()){
 if(!configs.length)return toast('请先在左侧勾选需要导出的配置');
 const shopId=configs[0].shopId,sameShop=configs.every(config=>config.shopId===shopId);
 const intel=sameShop&&shopId==='intel';
 openDialog('复制到主机维护表',`<p class="hint">已勾选 ${configs.length} 套，按左侧原始顺序输出。目标表有隐藏列，请分别粘贴到对应区域。SPU / SKU 目标列需设置为文本，避免长 ID 失真。</p>
  ${intel?'<label id="maintenance-template-field">目标维护表 <select id="maintenance-template"><option value="short">英特尔新版（配件1–5）</option><option value="legacy">旧版维护表</option></select></label>':''}
  <div class="copy-buttons">${[['spu','SPU'],['sku','SKU ID'],['name','简称'],['price','定价'],['parts','展开实际配件列']].map(([k,v])=>`<button data-copy-kind="${k}">${v}</button>`).join('')}</div>
  ${sameShop?'<details id="part-export-formula-settings"></details>':''}
  <p id="copy-hint" class="hint"></p><textarea id="copy-preview" readonly aria-label="复制内容预览"></textarea>
  <div class="actions"><button id="copy-execute" class="primary">复制当前区域</button></div>`);
 const template=$('#maintenance-template'),formulaEditor=$('#part-export-formula-settings');
 const show=()=>{
  if(template)template.parentElement.hidden=copyKind!=='parts'&&!formulaEditor?.open;
  $$('[data-copy-kind]').forEach(button=>button.classList.toggle('active',button.dataset.copyKind===copyKind));
  try{
   const text=copyKind==='price'?pricingColumn(configs,currentSettings()):copyMaintenanceText(configs,copyKind,template?.value);
   $('#copy-preview').value=text;
   $('#copy-hint').textContent=copyKind==='parts'?`${configs.length} 行 × ${text.split('\n')[0].split('\t').length} 列 · 实际配置 · ID / 名称公式 / 数量 / 备注`:`${configs.length} 行 × 1 列 · 不含表头`;
   $('#copy-execute').disabled=false;
  }catch(error){$('#copy-preview').value='';$('#copy-hint').textContent=error.message;$('#copy-execute').disabled=true;}
 };
 let refreshFormulas;
 if(formulaEditor){
  const scope=nasMain?nasWorkspace.sharedPreviewScope():'local';
  const short=()=>maintenanceUsesLocator(shopId,template?.value);
  const getSlots=()=>short()?slots.slice(0,14):slots;
  refreshFormulas=mountPartFormulaEditor(formulaEditor,{
   shopName:shopById(shopId).shortName,getSlots,
   read:()=>readPartFormulas(localStorage,scope,shopId,short(),getSlots()),
   write:formulas=>savePartFormulas(localStorage,scope,shopId,short(),formulas),
   defaultFormula:slot=>erpFormula(slot,short()),
   onSave:()=>{copyKind='parts';show();},
  });
  formulaEditor.ontoggle=()=>{if(formulaEditor.open)copyKind='parts';show();};
 }
 if(template)template.onchange=()=>{refreshFormulas?.();show();};
 $$('[data-copy-kind]').forEach(button=>button.onclick=()=>{copyKind=button.dataset.copyKind;show();});
 $('#copy-execute').onclick=async()=>{
  const preview=$('#copy-preview');
  try{await navigator.clipboard.writeText(preview.value);toast('已复制，请在维护表对应区域粘贴');}
  catch{preview.focus();preview.select();toast('内容已选中，请按 Ctrl+C 复制');}
 };
 show();
}
// 集中维护配置的业务标识，使用全局保存与撤销流程。
// 预览与应用均读取完整链接，不受勾选或搜索过滤影响；名称或顺序改变后必须重新预览。
function openRenumberFull(){
 const product=currentProduct();if(!product)return toast('请先选择一个商品链接');
 const shopId=activeShopId,productId=product.id,plan=planConfigRenumber(product.configs);
 const edits=plan.filter(row=>row.before!==row.after||row.shortNameChanged),skipped=plan.filter(row=>row.skipped).length;
 openDialog('一键重新编号',`<p class="hint">${esc(product.name)}：按当前链接全部配置的排列顺序，从配置1开始连续编号，不受搜索或勾选影响。同步更新配置简称与海报摘要中的编号，保留编号后的文字，跳过特殊名称。应用后可撤销。</p><p>将修改 ${edits.length} 套，跳过 ${skipped} 套特殊名称。</p><div class="global-list">${plan.map(row=>`<div class="list-card"><span>${esc(row.before)}</span><span>→ ${esc(row.after)}${row.skipped?'（跳过）':row.before===row.after?(row.shortNameChanged?'（同步简称编号）':'（不变）'):''}</span></div>`).join('')}</div><div class="actions"><button id="renumber-apply" class="primary" ${edits.length?'':'disabled'}>应用重新编号</button></div>`);
  const apply=async()=>{
  if(nasMain){
   try{
    const ids=edits.map(row=>row.id),byId=new Map(edits.map(row=>[row.id,row]));
    await loadNasScope(ids);
    const docs=new Map(state.configs.filter(c=>ids.includes(c.id)).map(c=>[c.id,clone(c)]));
    for(const id of ids)applyConfigRenumber(docs.get(id),byId.get(id),suggestedName);
    if(await commitNasConfigs(ids.map(id=>({id,action:'replace',document:docs.get(id)})),{title:'重新编号',group:nasGroup(product)}))closeDialog();
   }catch(error){toast(nasErrorText(error));}
   return;
  }
  const live=currentProduct();
  if(activeShopId!==shopId||live?.id!==productId||JSON.stringify(planConfigRenumber(live.configs))!==JSON.stringify(plan))return toast('链接配置、名称或顺序已变化，请重新打开编号预览');
  const ids=edits.map(row=>row.id),byId=new Map(edits.map(row=>[row.id,row]));
  checkpointConfig(ids);
  for(const config of live.configs)if(byId.has(config.id))applyConfigRenumber(config,byId.get(config.id),suggestedName);
  changed(`重新编号 ${ids.length} 套配置`,ids);closeDialog();renderAll();toast(`已重新编号 ${ids.length} 套配置，可点击“撤销”恢复`);
 };
 $('#renumber-apply').onclick=nasMain?apply:fullAction(apply);
}
function openIdsFull(){const configs=chosen();if(!configs.length)return toast('请勾选需要填入 ID 的配置');openDialog('批量粘贴平台 ID',`<p class="hint">当前 ${configs.length} 套：${esc(configs.map(c=>c.name).join('、'))}。按此顺序粘贴，每行一个 SKU ID；SPU 将应用到勾选配置。</p><label class="field">SPU（留空保留原值）<input id="ids-spu" value="${esc(configs[0].spu)}"></label><label class="field">SKU ID，每行一个<textarea id="ids-values"></textarea></label><div class="actions"><button id="ids-apply" class="primary">核对并应用</button></div>`);reactWorkbench.dialog($('#dialog-body'),'batch-ids',{configs});$('#ids-apply').onclick=async()=>{const spu=$('#ids-spu').value.trim(),lines=$('#ids-values').value.trim().split(/\r?\n/).map(s=>s.trim());if(lines.length!==configs.length||lines.some(s=>!/^\d+$/.test(s))||(spu&&!/^\d+$/.test(spu)))return toast('行数必须与配置数一致，ID 只能包含数字');if(new Set(lines).size!==lines.length)return toast('SKU ID 重复，请先核对');try{const ids=configs.map(c=>c.id),skuPlan=planIdEdit(nasMain?available():state.configs,'sku',ids,lines),spuPlan=spu?planIdEdit(nasMain?available():state.configs,'spu',ids,ids.map(()=>spu)):[],plan=[...skuPlan,...spuPlan],byId=new Map(state.configs.map(c=>[c.id,c]));if(!plan.length)return closeDialog();if(nasMain){if(await replaceNasFields(plan,'批量修改平台 ID'))closeDialog();return;}checkpoint();for(const row of plan)Object.assign(byId.get(row.id),row.fields);changed('批量粘贴平台 ID',[...new Set(plan.map(row=>row.id))],false,null,true);}catch(error){return toast(error.message);}renderAll();closeDialog();};}
// 打开成本税价维护入口，将确认后的修改纳入保存流程。
function openTax(){const c=current(),parts=actualParts(c);openDialog('粘贴含税单价',`<p class="hint">仅应用当前配置的 ${parts.length} 行：${esc(parts.map(p=>p.slot).join('、'))}。粘贴的是单件价，空行保留旧值。</p><textarea id="tax-values" placeholder="每行一个单价"></textarea><div class="actions"><button id="tax-apply" class="primary">核对并同步</button></div>`);$('#tax-apply').onclick=()=>{const lines=$('#tax-values').value.replace(/\r/g,'').split('\n');if(lines.length!==parts.length||lines.some(v=>v.trim()!==''&&(!/^\d+(\.\d{1,2})?$/.test(v.trim()))))return toast('行数需一致，单价最多两位小数，空行保留');checkpointConfig([c.id]);lines.forEach((v,i)=>{if(v.trim())parts[i].tax=Number(v);});c.taxUpdatedAt=new Date().toISOString();changed('粘贴含税单价');renderEditor();closeDialog();};}
// 打开 ERP 同步入口，读取结果通过专门的工作区刷新流程接收。
function openErp(){if(nasMain)return openNasErp();openDialog('三店共用 ERP 同步',`<p class="hint">库存与 ERP 成本只通过顶部“三店同步库存 / ERP”更新。同步按真实 goods_id 写入共享成本源，再更新三店所有引用配置；店铺展示名称、升级和加购文案不会被覆盖。</p><p class="hint">请先在“连接设置”安装并连接采集脚本，然后使用顶部同步按钮。</p>`);}
// 对选择集合统一应用图片样式，记录全局撤销点。
function openBatchStyleFull(){const scope=isLegacyTemplateConfig(current())?()=>currentProduct()?.configs||[]:ordinaryAvailable;openBatchAppearance({reference:clone(current()),render:model=>reactWorkbench.dialog($('#dialog-body'),'batch-style',model),openDialog,closeDialog,toast,esc,available:scope,chosen:()=>scope().filter(config=>selected.has(config.id)),request,upload:nasMain?uploadImage:null,errorText:error=>nasErrorText(error,listConfigs()),draftFirst:nasMain,
 apply:async(reference,configs,options,url,isCurrent)=>{
  if(nasMain){
   const shop=activeShopId;
   const ids=configs.map(c=>c.id);
   await loadNasScope(ids);
   if(!isCurrent())return false;
   if(shop!==activeShopId||nasBusy||!nasWorkspace.canWrite())throw Error('工作区已变化，请重新打开批量设置。');
   const loaded=new Map(state.configs.map(c=>[c.id,c])),updates=[];
   for(const id of ids){
    const before=loaded.get(id);
    if(!before||before.deletedAt||before.shopId!==shop)throw Error('配置范围已变化，请重新选择。');
    const c=clone(before);
    if(options.colors||options.format||options.images)applyPosterStyle(reference,c,options);
    if(options.asset)c.caseImage=url;
    applyBatchContent(reference,c,options);
    if(!sameNasDocument(before,c))updates.push({id,before,after:c});
   }
   const blocked=updates.find(({id})=>nasWorkspace.pending(id));
   if(blocked)throw Error(`「${blocked.before.name}」有未确认的保存，请先查询保存结果。`);
   if(!updates.length){toast('所选配置已是当前样式与内容。');return;}
   const changedIds=updates.map(row=>row.id);
   checkpointConfig(changedIds);
   const byId=new Map(updates.map(row=>[row.id,row.after]));
   state.configs=state.configs.map(row=>byId.get(row.id)||row);
   changed('批量应用样式与内容',changedIds,false,null,true);
   renderAll();
   toast(nasDraftFailure?nasErrorText(nasDraftFailure):`已应用到 ${changedIds.length} 套本机草稿，可撤销或保存到服务端。`);
   return;
  }
  checkpoint();for(const c of configs){if(options.colors||options.format||options.images)applyPosterStyle(reference,c,options);if(options.asset)c.caseImage=url;applyBatchContent(reference,c,options);}changed(`批量应用样式与内容${options.asset?'并更换机箱图片':''}：${configs.length} 套配置`,configs.map(c=>c.id));renderAll();}});}
// 删除配置使用业务删除标记，保留历史和恢复能力。
function removeConfigurationsFull(ids){const targets=available().filter(c=>ids.includes(c.id));if(!targets.length||!confirm('将 '+targets.length+' 套配置移入回收站？本机配置可在 7 天内恢复。'))return false;checkpoint();const oldIndex=available().findIndex(c=>c.id===active);deleteConfigs(state.configs,targets.map(c=>c.id));targets.forEach(c=>c.deletionSessionId=session.id);targets.forEach(c=>{selected.delete(c.id);pendingImages.delete(c.id);imageRecords.delete(c.id);});if(!current())active=available()[Math.min(Math.max(0,oldIndex),available().length-1)]?.id||null;changed(`删除 ${targets.length} 套配置`,[]);renderAll();toast(`已删除 ${targets.length} 套配置，可在 7 天内从回收站恢复`);}
// 本机到期配置仍可手动清理；保留期只限制恢复。
function localArchivedRows(shop){
 return localArchivedConfigs(shop).map(c=>({
  id:c.id,product:c.product,name:c.name,label:c.version,at:c.deletedAt
 }));
}
async function openConfigRecycle(){
 const shop=activeShopId;
 const load=async()=>{
  if(shop!==activeShopId)throw Error('已切换店铺，请重新打开回收站。');
  if(!nasMain)return localArchivedRows(shop);
  const archived=await nasWorkspace.archived();
  if(shop!==activeShopId)throw Error('已切换店铺，请重新打开回收站。');
  return archived.map(r=>({id:r.configuration_id,product:r.product_name,name:r.name,label:r.config_label,
   version:r.version,at:r.archived_at}));
 };
 const apply=async(action,targets)=>{
  if(shop!==activeShopId)throw Error('已切换店铺，请重新打开回收站。');
  const ids=new Set(targets.map(row=>row.id));
  if(nasMain){
   const plan=await commitNasConfigs(targets.map(r=>({id:r.id,action,expected_version:r.version})),
    {title:action==='restore'?'恢复已归档配置':'彻底删除已归档配置',selectId:action==='restore'?targets[0].id:null});
   return Boolean(plan);
  }
  await fullAction(async()=>{
   await save();
   const byId=new Map(state.configs.map(c=>[c.id,c]));
   if(shop!==activeShopId||targets.some(r=>byId.get(r.id)?.deletedAt!==r.at||byId.get(r.id)?.shopId!==shop))
    throw Error('回收站已变化，请核对最新清单。');
   if(action==='restore'){
    if(deletedWithinRetention(targets.map(r=>byId.get(r.id))).length!==ids.size)throw Error('配置已超过 7 天恢复期限。');
    const issue=configCapacityMessage(state.configs,shop,ids.size);if(issue)throw Error(issue);
    checkpoint();restoreConfigs(state.configs,[...ids]);active=targets[0].id;selected.add(active);
   }else{
    // 移除编辑器中可重新引入已清理配置的撤销点，磁盘操作记录及图片素材不参与清理。
    state.configs=state.configs.filter(c=>!ids.has(c.id));
    const usable=entry=>!entry.configs?.some(c=>ids.has(c.id))&&!entry.configOrder?.some(id=>ids.has(id));
    history=history.filter(usable);
    redoHistory=redoHistory.filter(usable);
    invalidateSaveScope(state,'永久清理归档配置');syncHistoryButtons();
   }
   changed((action==='restore'?'恢复':'彻底删除')+ids.size+' 套配置',[]);renderAll();await save();
  })();
  return true;
 };
 try{
  const rows=await load();
  openDialog('已删除配置（回收站）','');
  mountConfigRecycle($('#dialog-body'),{shopName:currentShop().name,nas:nasMain,rows,load,
   onCount:n=>{if(nasMain)archivedCounts.set(shop,n);if(shop===activeShopId)$('#link-recycle-shortcut').textContent='回收站（'+n+'）';},
   apply:async(...args)=>{try{return await apply(...args);}catch(error){throw Error(nasMain?nasErrorText(error):error.message);}}});
 }catch(error){toast(nasMain?nasErrorText(error):error.message);}
}
// 维护链接及其配置归属，批量字段变化先建立完整撤销点。
function openProductFull(edit=false,targetProduct=null,defaultCategory='',shopId=activeShopId){
 const shop=shopById(targetProduct?.shopId??shopId),shopConfigs=(nasMain?available():liveConfigs(state.configs)).filter(c=>c.shopId===shop.id),product=targetProduct?productGroups(shopConfigs).find(p=>p.id===(targetProduct.productId??targetProduct.id)):currentProduct();
 if(edit&&!product)return toast('商品链接已变化，请重新选择');
 const defaults=effectivePricingRule({},settingsFor(state,shop.id)),linkRule=edit?product.pricingRule:null;
 openDialog(edit?'编辑商品链接':'新增配置链接',`<p class="hint">当前店铺：<strong>${esc(shop.name)}</strong>。一个商品链接可包含多套配置，可从 WPS 粘贴配件创建，也可先创建空白配置。</p><label class="field">链接名称<input id="product-name" value="${edit?esc(product.name):''}" placeholder="例如：X400 白色主机"></label><label class="field">链接分类<input id="product-category" list="link-categories" maxlength="40" value="${edit?esc(product.category):esc(defaultCategory)}" placeholder="选择分类或输入自定义分类"><datalist id="link-categories">${linkCategories().map(cat=>`<option value="${esc(cat)}"></option>`).join('')}</datalist></label><label class="field">左侧链接卡片颜色<select id="product-card-color">${[['','默认'],['#e7f0ff','浅蓝'],['#e4f5e9','浅绿'],['#fff2ce','浅黄'],['#ffe8d9','浅橙'],['#fce5ed','浅粉'],['#eee6ff','浅紫'],['#dcf3f5','青色'],['#e9edf2','浅灰']].map(([value,label])=>`<option value="${value}" ${value===(edit?product.cardColor:'')?'selected':''}>${label}</option>`).join('')}</select><small>仅用于左侧链接卡片，不影响配置图。</small></label><label class="field">商品网址（可稍后填写）<input id="product-url" type="url" value="${edit?esc(product.url):''}" placeholder="https://…"></label><label class="field">SPU（可稍后填写）<input id="product-spu" value="${edit?esc(product.spu):''}" inputmode="numeric"></label><label class="field">整条商品链接的分期<select id="product-installment">${edit&&product.installment===null?'<option value="">旧配置分期不一致，请选择</option>':''}${INSTALLMENT_TERMS.map(value=>[value,value?value+' 期免息':'不分期']).map(([value,label])=>`<option value="${value}" ${(edit?product.installment:0)===value?'selected':''}>${label}</option>`).join('')}</select></label><p class="hint">本链接全部配置统一使用；息费按各配置到手价计算。新增配置也会沿用。</p><label class="field" hidden>旧费用兼容参数<select id="product-pricing-mode"><option value="inherit" ${linkRule?'':'selected'}>跟随店铺默认</option><option value="custom" ${linkRule?'selected':''}>本链接独立设置</option></select></label><fieldset id="product-pricing-fields" class="pp-pricing-fieldset" hidden>${pricingRuleFields('product-price',effectivePricingRule({pricingRule:linkRule},{pricingRule:defaults}))}</fieldset>${edit?'':'<div id="wps-import-mount"></div>'}<div class="actions"><button id="product-apply" class="primary">${edit?'保存链接':'创建并编辑配置'}</button></div>`);
 $('#product-pricing-mode').onchange=e=>{const custom=e.target.value==='custom',group=$('#product-pricing-fields');group.disabled=!custom;group.hidden=!custom;};
 const importer=edit?null:mountWpsImport($('#wps-import-mount'),{catalog:sourcesFor(state,shop.id),costSource:selectableComponents(state.costSource),configs:shopConfigs});
 const readFields=()=>{const termValue=$('#product-installment').value,term=Number(termValue);if(termValue===''||!INSTALLMENT_TERMS.includes(term))throw Error('请选择本链接的分期选项');const cardColor=$('#product-card-color').value,category=$('#product-category').value.trim(),name=$('#product-name').value.trim(),url=$('#product-url').value.trim(),spu=$('#product-spu').value.trim();if(!name)throw Error('请输入链接名称');if(url){try{if(!['http:','https:'].includes(new URL(url).protocol))throw Error();}catch{throw Error('请输入完整的 http 或 https 商品网址');}}if(spu&&!/^\d{1,30}$/.test(spu))throw Error('SPU 应为 1–30 位完整数字');const pricingRule=$('#product-pricing-mode').value==='custom'?readPricingRuleFields('product-price'):null;return {name,url,spu,category,cardColor,installment:term,pricingRule,shopId:shop.id};};
 let pendingAddition=null,nameControl=null;
 const prepareAddition=()=>{const fields=readFields(),imported=importer?.read(),signature=JSON.stringify([fields,imported?.groups]);if(pendingAddition?.signature===signature)return pendingAddition;const target={...fields,id:crypto.randomUUID()};const added=(imported?.groups||[null]).map((group,index)=>{const c=applyShopIdentity(blankConfig(null,target,group?.name||`配置${index+1}`,defaultServiceText(state,shop.id)),shop.id,{resetAppearance:true});c.fixedInitialFormat=true;if(group){if(group.price!=null)c.price=group.price;c.parts=group.parts;c.actualParts=clone(c.parts);if(group.version)c.version=group.version;c.wpsImport={sourceText:group.sourceText,importedAt:imported.importedAt,lineStart:group.lineStart};}else c.emptyLinkDraft=true;return c;});return pendingAddition={signature,added,imported};};
 if(!edit){const mount=document.createElement('div');$('#product-apply').parentElement.before(mount);nameControl=mountNameFormatPreview(mount,{getConfigs:()=>prepareAddition().added,shopId:shop.id,esc,toast,scope:'本次导入或新建配置',requirePreview:false});}
 $('#product-url').onchange=()=>{try{const id=new URL($('#product-url').value).searchParams.get('id');if(id&&/^\d+$/.test(id)&&!$('#product-spu').value)$('#product-spu').value=id;}catch{}};
 $('#product-apply').onclick=async()=>{
  const button=$('#product-apply');if(button.disabled)return;
  let fields,addition,plan;
  try{
   fields=readFields();
   if(fields.spu&&shopConfigs.some(c=>c.productId!==(edit?product.id:null)&&String(c.spu??'')===fields.spu))throw Error('本店已存在使用此 SPU 的其他链接');
   if(!edit){addition=prepareAddition();plan=nameControl.read();}
  }catch(e){return toast(e.message);}
  const {name,url,spu,category,cardColor,installment:term,pricingRule}=fields;
  // 11-19：在草稿区选中时新建，链接直接进草稿区。
  const intoDraft=!edit&&selectedZone==='draft'&&category!=='主机模板';if(intoDraft)addition.added.forEach(c=>c.productDraft=true);
  const capacityError=!edit&&configCapacityMessage(nasMain?shopConfigs:state.configs,shop.id,addition.added.length);if(capacityError)return toast(capacityError);
  if(nasMain){
   button.disabled=true;
   try{
    let applied;
    if(edit)applied=await updateNasProduct(product,{product:name,productCategory:category,productCardColor:cardColor,productUrl:url,spu,pricingRule:clone(pricingRule),installment:term},'编辑商品链接');
    else{
     const {rate}=commonOverviewFeeRate(await loadShopRateRows(shop.id));
     if(!button.isConnected||!button.closest("dialog")?.open)return;
     for(const row of addition.added)row.overviewFeeRate=rate;
     applyNameFormatPlan(plan,addition.added);applied=await createNasConfigs(addition.added,addition.imported?'从 WPS 导入配置':'新建商品链接');}
    if(applied&&button.isConnected)closeDialog();
   }catch(error){toast(nasErrorText(error));}finally{button.disabled=false;}
   return;
  }
  checkpoint();
  if(edit){applyProductInstallment(state.configs,product,term);product.configs.forEach(c=>Object.assign(c,{product:name,productCategory:category,productCardColor:cardColor,productUrl:url,spu,pricingRule:clone(pricingRule)}));changed('编辑商品链接',product.configs.map(c=>c.id),false,null,true);}
  else{
   const {added,imported}=addition;
   const {rate}=commonOverviewFeeRate(shopRateRows(shop.id));
   for(const row of added)row.overviewFeeRate=rate;
   applyNameFormatPlan(plan,added);
   state.configs.push(...added);if(activeShopId!==shop.id){activeShopId=shop.id;localStorage.setItem('diy-active-shop',shop.id);collapsedProducts.clear();}active=added[0].id;selected=new Set(added.map(c=>c.id));changed(imported?`从 WPS 导入 ${added.length} 套配置`:'新增配置链接',added.map(c=>c.id));
  }
  if(category==='主机模板'){templateSectionOpen=true;collapsedProducts.delete(edit?product.id:current()?.productId);}
  renderAll();closeDialog();if(!edit)toast('已在'+(category==='主机模板'?'主机模板':intoDraft?'草稿区':'链接区')+'新建链接');
 };
}
// 维护图片标题内容，修改仅影响对应配置的预览与保存。
function openPosterTitles(){const c=current();openDialog('页面标题与摘要',`<p class="hint">只控制图片显示，不影响配置名称、版本和维护表数据。</p>${[['name','配置名称'],['version','版本'],['subtitle','维护表简称 / 摘要']].map(([key,label])=>`<label class="field"><span><input type="checkbox" data-poster-field="${key}" ${c.posterFields?.[key]===false?'':'checked'}> 显示${label}</span></label>`).join('')}<label class="field">图片专用摘要（留空即为空白）<input id="poster-subtitle" value="${esc(c.posterSubtitle??c.shortName??'')}"></label><div class="actions"><button id="poster-titles-save" class="primary">应用</button></div>`);$('#poster-titles-save').onclick=()=>{checkpointConfig([c.id]);c.posterFields=Object.fromEntries($$('[data-poster-field]').map(el=>[el.dataset.posterField,el.checked]));c.posterSubtitle=$('#poster-subtitle').value;changed('修改图片标题显示');closeDialog();};}
// 按所选格式预览和批量更新配置名称。
function openNameFormatsFull(){const shopId=activeShopId,ids=chosen().map(c=>c.id);if(!ids.length&&current())ids.push(active);if(!ids.length)return toast('请先选择配置');const getConfigs=()=>{if(activeShopId!==shopId)throw Error('当前店铺已变化，请重新选择配置');const configs=available().filter(c=>ids.includes(c.id));if(configs.length!==ids.length)throw Error('配置范围已变化，请重新选择');return configs;};openNameFormatBatch({openDialog,closeDialog,esc,toast,getConfigs,shopId,format:current()?.nameFormat||'compact',scope:`${currentShop().name}，${ids.length} 套${selected.size?'已勾选':'当前'}配置`,apply:async plan=>{const configs=getConfigs();validateNameFormatPlan(plan,configs);const targetIds=plan.rows.filter(r=>!r.preserved).map(r=>r.id);
 if(nasMain){const copies=clone(configs);applyNameFormatPlan(plan,copies);return Boolean(await commitNasConfigs(copies.filter(c=>targetIds.includes(c.id)).map(c=>({id:c.id,action:'replace',document:c})),{title:'批量修改简称格式'}));}
 checkpointConfig(targetIds);applyNameFormatPlan(plan,configs);changed(`批量修改简称格式：${targetIds.length} 套配置`,targetIds);renderAll();toast(`已应用 ${targetIds.length} 个简称，可撤销`);}});}
// 将链接配置保存为可复用模板，保留模板与普通商品的身份区别。
function openSaveProductTemplateFull(){const p=currentProduct();let pendingTemplate=null,saving=false;openDialog('整组存为模板','');if(!reactWorkbench.dialog($('#dialog-body'),'template-save',{name:p.name,count:p.configs.length}))openDialog('整组存为模板',`<p class="hint">保存“${esc(p.name)}”的全部 ${p.configs.length} 套配置及图片样式。调用时可以勾选其中需要的配置。</p><label class="field">模板名称<input id="template-name" value="${esc(p.name)}"></label><div class="actions"><button id="template-save" class="primary">保存整组模板</button></div>`);$('#template-save').onclick=async()=>{if(saving)return;const name=$('#template-name').value.trim();if(!name)return toast('请输入模板名称');const capacityError=pendingTemplate?'':configCapacityMessage(state.configs,activeShopId,p.configs.length);if(capacityError)return toast(capacityError);const button=$('#template-save');button.disabled=true;saving=true;try{if(!pendingTemplate){checkpoint();pendingTemplate=productTemplate(p.configs,name);state.templates.push(pendingTemplate);}const added=migrateSavedTemplates(state,activeShopId);templateSectionOpen=true;for(const c of added)collapsedProducts.delete(c.productId);changed('保存整组配置模板',[]);renderList();await save();closeDialog();document.querySelector(`[data-template-product-toggle="${pendingTemplate.editorProductId}"]`)?.scrollIntoView({block:'nearest'});toast(`已保存 ${p.configs.length} 套配置到左侧主机模板`);}catch(error){toast(error.message);}finally{saving=false;if(button.isConnected)button.disabled=false;}};}
// 跨店复制时更新目标店铺身份和显示设置，保留原配置。
function openCopyToShopFull(){const source=current(),targets=shops.filter(shop=>shop.id!==activeShopId);openDialog('复制到其他店铺',`<p class="hint">复制当前配置的配件和数量，重新使用目标店输出名称与图片配色。SPU、SKU、售价、加购、福利和店铺服务文案将清空。</p><label class="field">目标店铺<select id="copy-shop-target">${targets.map(shop=>`<option value="${shop.id}">${esc(shop.name)}</option>`).join('')}</select></label><label class="field">目标商品链接名称<input id="copy-shop-product" value="${esc(source.product)}"></label><div class="actions"><button id="copy-shop-apply" class="primary">复制并切换到目标店铺</button></div>`);$('#copy-shop-apply').onclick=()=>{const targetShopId=$('#copy-shop-target').value,targetShop=shopById(targetShopId),productName=$('#copy-shop-product').value.trim();if(!productName)return toast('请输入目标商品链接名称');checkpoint();const targetProduct={id:crypto.randomUUID(),shopId:targetShopId,name:productName,category:source.productCategory||'',url:'',spu:''},copy=clone(source);Object.assign(copy,{id:crypto.randomUUID(),shopId:targetShopId,productId:targetProduct.id,product:productName,productUrl:'',spu:'',skuId:'',price:null,pricingRule:null,addons:[],benefits:[],updatedAt:null,taxUpdatedAt:null,erpImportedAt:null,shortName:'',shortNameAuto:true});for(const part of [...copy.parts,...actualParts(copy)]){const row=state.sourceCatalog.find(item=>item.shopId===targetShopId&&part.goodsId&&item.goodsId===part.goodsId);if(row)Object.assign(part,{sourceId:row.sourceId,name:row.name,upgrade:row.upgrade,erp:row.erp,tax:row.tax,erpMissing:row.erpMissing??false,erpUnknown:row.erpUnknown??(row.erp==null)});else delete part.sourceId;}for(const module of copy.modules||[])if(module.type==='service')module.text='';copy.footer='';applyShopIdentity(copy,targetShopId,{resetAppearance:true});const capacityError=configCapacityMessage(state.configs,targetShopId,1);if(capacityError)return toast(capacityError);state.configs.push(copy);activeShopId=targetShopId;localStorage.setItem('diy-active-shop',targetShopId);active=copy.id;selected=new Set([copy.id]);changed(`复制配置到${targetShop.name}`,[copy.id]);renderAll();closeDialog();toast(`已复制到${targetShop.name}，请补充商品身份、售价和本店文案`);};}
// 生成利润概览单元格，统一数值、异常和展示口径。
function overviewProfitCell(c,settings,value,index){
 const t=index===1?totals(c,settings):null,term=index===1?pricing(c,settings).term:0;
 const text=value===null?'待补成本':index===1?'¥'+money(t.erpProfit)+(term>0?'<span class="overview-installment" data-profit-tone="'+profitTone(value)+'">'+term+' 期后 ¥'+money(value)+'</span>':''):'¥'+money(value);
 return `<small class="overview-profit" data-profit-tone="${profitTone(index===1?t.erpProfit:value)}">${text}${index===0?configCostNote(c):''}</small>`;
}
// 汇总概览异常提示，帮助定位缺失成本等业务问题。
function overviewWarning(c){const t=totals(c);return t.erpFallback||t.erpUnresolved?'<span class="overview-warning">ERP价格未识别，请核算货源情况和价格</span>':'';}
// 为当前范围构建配置与利润概览，完整数据准备后再计算。
function openOverviewFull(){const p=currentProduct(),settings={...currentSettings(),linkInstallment:p.installment},getConfigs=()=>available().filter(c=>c.productId===p.id);openDialog('配置总览',`<p class="hint">${esc(currentShop().name)} · ${esc(p.name)} · ${p.configs.length} 套配置 · 店铺券 ¥${money(settings.coupon)}。${nasMain?'修改工作台到手价先留草稿，返回主编辑器后保存；不改变维护表销售报价。':'到手价可直接修改，按 Enter 或离开输入框后自动保存；定价与利润同步更新。'}</p><div class="overview-toolbar"><button id="overview-copy" class="primary">复制全部简称</button><button id="overview-price-copy" class="primary">复制全部定价</button><button id="overview-import-price">从成本维护表更新价格</button></div><div class="overview-list"><div class="overview-head"><span>维护表简称 · 点击编辑配置</span><span>到手价</span><span>定价</span><span>EXCEL 利润</span><span>ERP 利润</span></div>${p.configs.map(c=>`<div class="overview-row"><button type="button" class="overview-config-link" data-overview="${esc(c.id)}">${esc(c.shortName||suggestedName(c,c.nameFormat||'compact'))}</button><input type="number" min="0" step="0.01" class="overview-price-input" data-overview-price="${esc(c.id)}" aria-label="${esc(c.name)} 到手价" value="${esc(c.price??'')}"><strong>${financeMoney(pricing(c,settings).listPrice)}</strong>${overviewProfits(c,settings).map((v,i)=>overviewProfitCell(c,settings,v,i)).join('')}${overviewWarning(c)}</div>`).join('')}</div><textarea id="overview-copy-fallback" class="hidden" readonly aria-label="复制内容"></textarea>`);$$('[data-overview]').forEach(b=>b.onclick=()=>{activate(b.dataset.overview);closeDialog();});// 仅更新对应配置和金额单元格，保留滚动位置与输入焦点。
$$('[data-overview-price]').forEach(input=>{
 input.onchange=()=>{
  const c=getConfigs().find(c=>c.id===input.dataset.overviewPrice);if(!c)return;
  const value=input.value.trim(),price=Number(value);
  if(!value||!input.validity.valid||!Number.isFinite(price)||price<0){input.value=String(c.price??'');toast('请输入有效的非负金额，最多两位小数');return;}
  if(price===c.price)return;
  checkpointConfig([c.id]);c.price=price;changed('配置总览修改到手价',[c.id]);
  const row=input.closest('.overview-row');row.querySelector('strong').textContent=financeMoney(pricing(c,settings).listPrice);
  row.querySelectorAll('.overview-profit').forEach((cell,i)=>{cell.outerHTML=overviewProfitCell(c,settings,overviewProfits(c,settings)[i],i);});
  if(c.id===active)renderConfigFields();
 };
 input.onkeydown=event=>{if(event.key==='Enter'){event.preventDefault();input.blur();}else if(event.key==='Escape'){event.preventDefault();event.stopPropagation();const c=getConfigs().find(c=>c.id===input.dataset.overviewPrice);if(c)input.value=String(c.price??'');input.blur();}};
});
const copy=async kind=>{try{const text=kind==='price'?pricingColumn(getConfigs(),settings):copyText(getConfigs().map(c=>({...c,shortName:c.shortName||suggestedName(c,c.nameFormat||'compact')})),'name');try{await navigator.clipboard.writeText(text);toast(`已复制 ${p.configs.length} 行${kind==='price'?'定价':'简称'}`);}catch{const el=$('#overview-copy-fallback');el.classList.remove('hidden');el.value=text;el.focus();el.select();toast('内容已选中，请按 Ctrl+C 复制');}}catch(e){toast(e.message);}};$('#overview-copy').onclick=()=>copy('name');$('#overview-price-copy').onclick=()=>copy('price');$('#overview-import-price').onclick=()=>openMaintenancePrices();}
// 提供批量维护价格入口，并保持统一保存及回退能力。
function openMaintenancePricesFull(){const p=currentProduct(),getConfigs=()=>available().filter(c=>c.productId===p.id),settings=currentSettings();openPriceImport({openDialog,closeDialog,toast,esc,money,getConfigs,getSettings:()=>settings,product:()=>p,back:openOverview,apply:plan=>{applyPriceImport(plan,clone(getConfigs()),settings);checkpoint();const ids=applyPriceImport(plan,getConfigs(),settings);changed(`从成本维护表更新 ${ids.length} 套配置价格`,ids);renderAll();}});}
function openNasMaintenancePrices(){
 const product=currentProduct();if(!product)return toast('请先选择商品链接。');
 const getConfigs=()=>available().filter(c=>c.productId===product.id),settings=clone(currentSettings());
 const versions=new Map(product.configs.map(c=>[c.id,nasWorkspace.configurationVersion(c.id)]));
 openPriceImport({nas:true,openDialog,closeDialog,toast,esc,money,getConfigs,getSettings:()=>settings,product:()=>product,back:openOverview,
  apply:async plan=>{
   if(currentProduct()?.id!==product.id||getConfigs().some(row=>!versions.get(row.id)||nasWorkspace.configurationVersion(row.id)!==versions.get(row.id)))
    throw Error('链接或配置版本已变化，请重新预览。');
   const copies=clone(getConfigs()),ids=applyPriceImport(plan,copies,settings),byId=new Map(copies.map(row=>[row.id,row]));
   if(!ids.length)return false;
   const result=await replaceNasFields(ids.map(id=>({id,fields:{price:byId.get(id).price,priceImportedAt:byId.get(id).priceImportedAt}})),
    '从成本维护表更新工作台到手价',nasGroup(product));
   return !!result&&nasApplied(result).length===ids.length;
  }
 });
}
// 维护可复用配置模板，避免将历史模板误当作普通商品。
function openTemplatesFull(){if(currentProduct()?.installment===null){toast('请先统一本链接的分期设置');if(!nasMain)return openProduct(true);}const target=currentProduct()||{id:null,name:'请先选择商品链接',configs:[]},picked=new Set();
 const getLibrary=()=>nasMain?state.templates:editableTemplateLibrary(state,activeShopId);
 const targetAnchor=nasMain&&target.id?{id:current().id,version:nasWorkspace.configurationVersion(current().id)}:null;
 const draw=()=>{const library=getLibrary(),live=library.filter(t=>!t.deletedAt),deleted=library.filter(t=>t.deletedAt);openDialog('本店配置模板','');if(!reactWorkbench.dialog($('#dialog-body'),'templates',{shopName:currentShop().name,targetName:target.name,live:live.map(t=>({...t,configs:templateConfigs(t).map((c,i)=>({...c,label:suggestedName(c,'compact'),picked:picked.has(t.id+':'+i)}))})),deleted}))openDialog('本店配置模板',`<p class="hint">当前店铺：<strong>${esc(currentShop().name)}</strong>；添加到：<strong>${esc(target.name)}</strong>。模板不会跨店混用，导入后使用当前链接 SPU，SKU 留空。</p><div class="compact-toolbar"><input type="search" id="template-search" placeholder="搜索模板或配置名称" aria-label="搜索模板"><button id="template-expand-all">全部展开</button><button id="template-collapse-all">全部收起</button></div><div id="templates-list">${live.map(t=>{const configs=templateConfigs(t);return `<details class="template-card"><summary class="template-heading"><label><input type="checkbox" data-template-all="${esc(t.id)}" aria-label="全选模板 ${esc(t.name)}"><span><strong>${esc(t.name)}</strong><small>${configs.length} 套配置 · <span data-template-picked="${esc(t.id)}">已选 0</span></small></span></label><button type="button" data-template-fold aria-expanded="false">展开</button><button class="danger" data-template-delete="${esc(t.id)}" aria-label="删除模板 ${esc(t.name)}">删除</button></summary><div class="template-configs">${configs.map((c,i)=>{const key=t.id+':'+i;return `<label class="template-config"><input type="checkbox" class="template-choice" value="${esc(key)}" data-owner="${esc(t.id)}" ${picked.has(key)?'checked':''}><span>${esc(suggestedName(c,'compact'))}<small>${c.parts.length} 项配件</small></span></label>`;}).join('')}</div></details>`;}).join('')||'<p class="hint">本店还没有模板。可以先将当前链接“整组存为模板”。</p>'}</div>${deleted.length?`<details class="template-deleted"><summary>已删除模板（${deleted.length}）· 可恢复</summary>${deleted.map(t=>`<div class="list-card"><span>${esc(t.name)}</span><button data-template-restore="${esc(t.id)}">恢复</button></div>`).join('')}</details>`:''}<div class="actions"><span id="template-selection-count" class="hint"></span><button id="template-use" class="primary" disabled>添加所选配置</button></div>`);
 $('#dialog').classList.add('template-dialog');
 $$('.template-heading label,.template-heading button').forEach(el=>el.addEventListener('click',e=>e.stopPropagation()));
 $$('[data-template-fold]').forEach(b=>b.onclick=e=>{e.preventDefault();const card=b.closest('details');card.open=!card.open;});$$('.template-card').forEach(card=>card.addEventListener('toggle',()=>{const b=card.querySelector('[data-template-fold]');b.textContent=card.open?'收起':'展开';b.setAttribute('aria-expanded',String(card.open));}));
 $('#template-search').oninput=()=>{const q=$('#template-search').value.trim().toLowerCase();$$('.template-card').forEach(card=>card.hidden=!card.textContent.toLowerCase().includes(q));};
 $('#template-expand-all').onclick=()=>$$('.template-card:not([hidden])').forEach(card=>card.open=true);$('#template-collapse-all').onclick=()=>$$('.template-card').forEach(card=>card.open=false);
 const update=()=>{const count=$$('.template-choice:checked').length;$('#template-selection-count').textContent=`已选 ${count} 套`;$('#template-use').disabled=!count||!target.id;$$('[data-template-all]').forEach(el=>{const children=$$('.template-choice').filter(c=>c.dataset.owner===el.dataset.templateAll);el.checked=children.length>0&&children.every(c=>c.checked);el.indeterminate=children.some(c=>c.checked)&&!el.checked;el.closest('summary').querySelector('[data-template-picked]').textContent='已选 '+children.filter(c=>c.checked).length;});};
 $$('.template-choice').forEach(el=>el.onchange=()=>{el.checked?picked.add(el.value):picked.delete(el.value);update();});
 $$('[data-template-all]').forEach(el=>el.onchange=()=>{$$('.template-choice').filter(c=>c.dataset.owner===el.dataset.templateAll).forEach(c=>{c.checked=el.checked;c.checked?picked.add(c.value):picked.delete(c.value);});update();});
 $$('[data-template-delete]').forEach(b=>b.onclick=async()=>{const t=getLibrary().find(t=>t.id===b.dataset.templateDelete);if(!t)return;if(nasMain){try{await saveNasCatalog('templates',t.id,'archive');draw();toast('模板已移入回收站');}catch(error){toast(nasErrorText(error));}return;}if(t.editable){if(await removeConfigurations(t.configs.map(c=>c.id))===false)return;}else{checkpoint();t.deletedAt=new Date().toISOString();changed(`删除配置模板：${t.name}`,[]);renderAll();}templateConfigs(t).forEach((c,i)=>picked.delete(t.id+':'+i));draw();const notice=document.createElement('div');notice.className='template-notice';notice.setAttribute('role','status');notice.textContent=`已删除“${t.name}”。`;const undo=document.createElement('button');undo.textContent='撤销删除';undo.onclick=()=>restore(t.id);notice.append(undo);$('#templates-list').before(notice);});
 const restore=async id=>{const t=getLibrary().find(t=>t.id===id);if(!t)return;
  if(nasMain){try{await saveNasCatalog('templates',id,'restore');draw();toast('模板已恢复');}catch(error){toast(nasErrorText(error));}return;}
  const capacityError=configCapacityMessage(state.configs,activeShopId,t.configs?.length||1);if(capacityError)return toast(capacityError);checkpoint();if(t.editable)restoreConfigs(state.configs,t.configs.map(c=>c.id));else delete t.deletedAt;changed(`恢复配置模板：${t.name}`,[]);renderAll();draw();toast('模板已恢复');};
 $$('[data-template-restore]').forEach(b=>b.onclick=()=>restore(b.dataset.templateRestore));
 if(nasMain){
  if(!nasWorkspace.canManage()){
   $$('[data-template-delete],[data-template-restore]').forEach(button=>button.hidden=true);
   $('#template-use').hidden=true;update();return;
  }
  for(const remove of $$('[data-template-delete]')){
   const button=document.createElement('button');button.type='button';button.dataset.templateRename=remove.dataset.templateDelete;button.textContent='重命名';remove.before(button);
   button.onclick=async event=>{
    event.preventDefault();event.stopPropagation();
    const template=live.find(t=>t.id===button.dataset.templateRename);if(!template)return;
    const name=window.prompt('模板名称',template.name)?.trim();
    if(!name||name===template.name)return;
    try{await saveNasCatalog('templates',template.id,'replace',{...template,name});draw();toast('模板名称已保存');}
    catch(error){toast(nasErrorText(error));}
   };
   if(target.id){
    const replace=document.createElement('button');replace.type='button';replace.dataset.templateReplaceContents=remove.dataset.templateDelete;replace.textContent='用当前链接覆盖内容';remove.before(replace);
    replace.onclick=async event=>{
     event.preventDefault();event.stopPropagation();
     const template=live.find(t=>t.id===replace.dataset.templateReplaceContents);if(!template)return;
     const expected=catalogRow('templates',template.id)?.version;
     if(!window.confirm(`用“${target.name}”下的 ${target.configs.length} 套配置覆盖模板“${template.name}”的内容？模板名称保留，已使用该模板的配置不受影响。`))return;
     replace.disabled=true;
     try{
      const configs=await readNasTemplateConfigs(target);
      if(!replace.isConnected||!$('#dialog').open)return;
      await saveNasCatalog('templates',template.id,'replace',{...template,configs},{expected_version:expected});
      if(replace.isConnected&&$('#dialog').open){picked.clear();draw();}
      toast('模板内容已保存');
     }catch(error){toast(nasErrorText(error));}
     finally{replace.disabled=false;}
    };
   }
  }
  const emptyTarget=()=>{const c=state.configs.find(c=>c.id===targetAnchor?.id);
   return c?.emptyLinkDraft&&!c.skuId&&(c.price==null||c.price===0)&&!c.benefits?.length&&!c.addons.length&&
    [...c.parts,...c.actualParts].every(p=>!p.name&&!p.goodsId)&&!nasWorkspace.drafts().some(d=>d.id===c.id);};
  let plan=null,applying=false,prepared;
  const prepare=()=>{
   const choices=live.map(t=>({id:t.id,sources:templateConfigs(t).filter((c,i)=>picked.has(t.id+':'+i))})).filter(row=>row.sources.length);
   const signature=JSON.stringify(choices);if(prepared?.signature===signature)return prepared;
   const sources=choices.flatMap(row=>row.sources),added=importTemplateConfigs(sources,{...target,
    configs:target.configs.map(c=>state.configs.find(row=>row.id===c.id)??{...c,emptyLinkDraft:false})});
   for(const [index,source] of sources.entries())if(source.shortNameAuto!==true&&String(source.shortName||'').trim())added[index].shortNameAuto=false;
   let i=0;return prepared={signature,added,rows:choices.map(row=>({id:row.id,done:false,
    selection:row.sources.map(source=>({source_id:source.id,id:added[i++].id}))}))};
  };
  const nameMount=document.createElement('div');$('#template-use').parentElement.before(nameMount);
  const nameControl=mountNameFormatPreview(nameMount,{getConfigs:()=>prepare().added,shopId:activeShopId,esc,toast,scope:'本次添加的模板配置',requirePreview:false});
  $('#template-use').onclick=async()=>{
   if(!target.id||target.installment===null||applying)return;
   if(!plan){
    try{
     const {format,replaceManual}=nameControl.read();
     const {rows}=prepare(),archivePlaceholder=emptyTarget();
     plan=rows.map((row,i)=>({...row,options:{name_format:format,replace_manual_names:replaceManual,
      ...(archivePlaceholder&&i===rows.length-1?{archive_empty_target:true}:{})}}));
    }catch(error){return toast(error.message);}
   }
   if(!plan.length){plan=null;return toast('请先勾选模板中的配置');}
   applying=true;const button=$('#template-use');button.disabled=true;
   try{
    const created=[];
    for(const row of plan.filter(r=>!r.done)){
     const result=await saveNasCatalog('templates',row.id,'apply',null,{target_product_id:target.id,target_configuration_id:targetAnchor.id,
      expected_target_version:targetAnchor.version,selection:row.selection,...row.options});
     row.done=true;created.push(...result.document.configuration_ids);
    }
    const count=plan.reduce((n,row)=>n+row.selection.length,0);
    await readNasIndex();closeDialog();
    const id=created[0]||plan[0].selection[0].id;collapsedProducts.delete(target.id);selected=new Set([id]);await activate(id);
    toast('已从 NAS 模板添加 '+count+' 套配置');
   }catch(error){
    toast((plan.some(row=>row.done)?'已确认一部分；':'')+nasErrorText(error));
   }finally{applying=false;if(button.isConnected)update();}
  };
  update();return;
 }
 let importing=false;
 let pendingTemplates=null;
 const prepareTemplates=()=>{const destination=productGroups(available()).find(p=>p.id===target.id);if(!destination||destination.shopId!==activeShopId)throw Error('目标链接已变化，请重新打开模板');const sources=clone(live.flatMap(t=>templateConfigs(t).filter((c,i)=>picked.has(t.id+':'+i))));if(!sources.length)throw Error('请先勾选模板中的配置');const signature=JSON.stringify([sources,{...destination,configs:destination.configs.map(c=>({id:c.id,name:c.name,workspaceOrder:c.workspaceOrder,placeholder:!!(c.emptyLinkDraft&&(c.price==null||c.price===0)&&c.parts.every(p=>!p.name&&!p.goodsId)&&!c.addons.length&&!c.benefits.length&&!c.skuId)}))}]);if(pendingTemplates?.signature===signature)return pendingTemplates;const added=importTemplateConfigs(sources,destination);sources.forEach((c,i)=>{if(c.shortNameAuto!==true&&String(c.shortName||'').trim())added[i].shortNameAuto=false;});return pendingTemplates={signature,added};};
 const nameMount=document.createElement('div');$('#template-use').parentElement.before(nameMount);const nameControl=mountNameFormatPreview(nameMount,{getConfigs:()=>prepareTemplates().added,shopId:activeShopId,esc,toast,scope:'本次添加的模板配置',requirePreview:false});
 $('#template-use').onclick=async()=>{
  if(importing)return;
  const sources=clone(live.flatMap(t=>templateConfigs(t).filter((c,i)=>picked.has(t.id+':'+i))));
  if(!sources.length)return toast('请先勾选模板中的配置');
  try{nameControl.read();}catch(error){return toast(error.message);}
  importing=true;const button=$('#template-use');button.disabled=true;button.textContent='正在保存并添加…';
  try{
   // Finish the new-link save before removing its placeholder. Its receipt may
   // replace state and add defaults; a stale target would cause a delete conflict.
   await save();
   const destination=productGroups(available()).find(p=>p.id===target.id);
   if(!destination)throw Error('目标链接已变化，请重新打开模板');
   const empty=destination.configs.find(c=>c.emptyLinkDraft&&(c.price==null||c.price===0)&&c.parts.every(p=>!p.name&&!p.goodsId)&&!c.addons.length&&!c.benefits.length&&!c.skuId);
   const capacityError=configCapacityMessage(state.configs,destination.shopId,sources.length-(empty?1:0));if(capacityError)throw Error(capacityError);
   const plan=nameControl.read(),{added}=prepareTemplates();applyNameFormatPlan(plan,added);checkpoint();
   if(empty){state.configs=state.configs.filter(c=>c.id!==empty.id);selected.delete(empty.id);pendingImages.delete(empty.id);}
   state.configs.push(...added);selected=new Set(added.map(c=>c.id));active=added[0].id;collapsedProducts.delete(destination.id);
   changed('批量导入模板配置',added.map(c=>c.id));renderAll();closeDialog();
   await save();toast(`已添加并保存 ${added.length} 套配置到“${destination.name}”`);
  }catch(error){toast(error.message);}finally{importing=false;if(button.isConnected){button.textContent='添加所选配置';update();}}
 };update();};draw();}
// SKU 固定样式随配置保存；图片类型和宽度仍仅用于本次导出。
async function saveSkuMode(ids,mode){
 if(nasMain&&nasEditorLocked())return;
 if(!ids.length||!['padded','dedicated'].includes(mode))return;
 await save();
 // NAS 只加载此处正在编辑的配置；方图样式撤销点按配置记，不能索取全工作区。
 if(nasMain)checkpointConfig(ids);else checkpoint();
 const changedIds=applySkuImageMode(state.configs,ids,mode);
 if(changedIds.length){changed('保存 SKU 固定样式',changedIds,'asset');updateSkuControls();await save();}
}
function imageExportOptions(){return {kind:$('#image-export-kind').value,skuMode:$('#image-export-sku-mode').value,width:Number($('#export-width').value)||0};}
async function exportCurrent(){
 const source=current();if(!source)return toast('请先选择配置');
 await exportConfiguredImages([source],false);
}
function filename(c){return`${shopById(c.shopId).shortName}_${c.spu||'未绑定'}_${c.name}_${c.id.slice(-6)}_${c.layout==='long'?'长图':'方图'}_${c.theme==='light'?'浅色':'深色'}.png`.replace(/[<>:"/\\|?*\x00-\x1f]/g,'_');}

async function batchExportFull(){
 const configs=chosen();if(!configs.length)return toast('请先勾选需要导出的配置');
 await exportConfiguredImages(configs,true);
}
async function exportConfiguredImages(configs,batch){
 const {kind,skuMode,width}=imageExportOptions(),layouts=kind==='both'?['long','square']:[kind];
 exportJobs++;
 try{
 let draft=dirty||!!savePromise||conflict;
 const revision=state.revision,shopId=activeShopId,shopName=currentShop().name;
 // 保存期间允许继续编辑，导出内容固定为点击时快照。
 configs=clone(configs).map(config=>{
  const projected=withAddonPackText(config);
  if(!draft&&addonPackDrafts?.size)draft=JSON.stringify(projected.posterAddonPacks)!==JSON.stringify(withAddonPackText(config,false).posterAddonPacks);
  return projected;
 });
 if(!nasMain&&layouts.includes('square'))await saveSkuMode(configs.map(c=>c.id),skuMode);
 // 多链接条目已含链接和图种目录；不再套图种目录，保持原生导出支持的一层子目录。
 const entries=layouts.flatMap(layout=>numberedImageEntries(configs,layout).map(({config,name})=>({config:{...(layout==='square'?skuImageConfig(config,skuMode):clone(config)),layout},name:layouts.length>1&&!name.includes('/')?(layout==='long'?'配置图/':'SKU图/')+name:batch?name:filename({...config,layout})})));

  const renderImage=c=>imageRenderGate.run(({beforeDraw})=>drawPoster(c,width||defaultPosterWidth(c),{beforeDraw}));
  if(entries.length===1){const entry=entries[0],r=await renderImage(entry.config);try{if(r.overflow)throw Error('图片内容超出，请先调整排版');toast(await exportSingleImage(await toBlob(r.canvas),entry.name,{download:downloadBlob,draft}));}finally{
   // 单张导出完成或失败后释放高清画布，与批量导出保持一致。
   r.canvas.width=0;r.canvas.height=0;
  }return;}
  const report={shopId,shop:shopName,revision:draft?null:revision,source:draft?'点击时的当前草稿':'已保存配置',kind,skuMode,width,entries:entries.map(e=>({file:e.name,config:e.config.name,id:e.config.id,product:e.config.product,theme:e.config.theme,layout:e.config.layout,skuMode:e.config.skuMode,width:width||defaultPosterWidth(e.config)}))};
  const name=kind==='both'?imageArchiveName(configs,'long').replace('_配置图.zip','_配置图和SKU图.zip'):imageArchiveName(configs,kind);
  const task=startImageExportTask({entries,name,title:batch?'批量配置图片':'当前配置图片',width,report,download:downloadBlob,renderImage});
  toast('图片任务已开始，可在右下角查看进度、取消或重试失败项');await task.done;
 }catch(e){toast(e.message);}finally{exportJobs--;scheduleImageSave();}
}
// 使用完整配置和本机成本数据执行利润检查。
async function showPriceChanges(options={}){
 if(nasMain){
  const history=nasPriceHistory(async(action,input)=>{
   try{return await nasWorkspace.priceHistory(action,input);}catch(error){throw Error(nasErrorText(error));}
  });
  return openPriceChanges({...history,nas:true,openDialog,toast,download:downloadBlob,shopName:id=>shopById(id).name,locate:async id=>{
   const target=ordinaryAvailable().find(c=>c.id===id);if(!target)return toast('配置已删除或不在当前店铺');
   closeDialog();$('#search').value='';$('#link-category-filter').value='';listPinnedProduct=target.productId;
   await activate(id);$('#locate-editing')?.click();switchTab('costs');
  }},options);
 }
 if(!options.automatic)priceNotifications.length=0;
 const blocked=()=>pricePopupBlocked()||options.isCurrent?.()===false;
 if(options.automatic&&blocked())return false;
 await ensureFullWorkspace();
 if(options.automatic&&blocked())return false;
 return openPriceChanges({openDialog,request,toast,download:downloadBlob,configs:()=>acceptedState.configs,settings:id=>settingsFor(acceptedState,id),shopName:id=>shopById(id).name,locate:async id=>{
  const target=state.configs.find(c=>c.id===id&&!c.deletedAt);if(!target)return toast('配置已删除');
  closeDialog();await save();activeShopId=target.shopId;localStorage.setItem('diy-active-shop',activeShopId);$('#search').value='';$('#link-category-filter').value='';listPinnedProduct=target.productId;await activate(id);renderAll();$('#locate-editing')?.click();switchTab('costs');
 }},options);
}
// 仅本次本机同步成功回执可排队；启动、普通保存和历史未读批次不会自动弹窗。
const priceNotifications=[],priceNotificationKeys=new Set();let priceChecking=false;
let priceInteraction=0;
for(const event of ['pointerdown','keydown'])document.addEventListener(event,()=>priceInteraction++,true);
function queuePriceChanges({source,after,revision}){
 if(!['erp','cost-source'].includes(source)||!Number.isSafeInteger(after)||!Number.isSafeInteger(revision)||revision<=after)return;
 const key=`${source}:${after}:${revision}`;if(priceNotificationKeys.has(key))return;
 priceNotificationKeys.add(key);priceNotifications.push({after,revision});
 if(priceNotificationKeys.size>128)priceNotificationKeys.delete(priceNotificationKeys.values().next().value);
}
function pricePopupBlocked(){return !window.workbenchReady||window.workbenchHasPendingChanges()||conflict||!!workspaceLoad||fullActionBusy>0||$('#dialog').open||document.activeElement?.matches('input,textarea,select');}
async function checkPriceChanges(){
 if(!priceNotifications.length)return;
 // 只在导入完成时尝试一次；忙碌时保留手动入口，不在后续点击或失焦时补弹。
 const pending=priceNotifications.shift(),interaction=priceInteraction;
 if(priceChecking||pricePopupBlocked()){toast('价格已更新，可在“工具与资料 → 检查价格变化”查看明细');return;}
 priceChecking=true;
 try{
  const result=await request('/api/price-changes/list',{method:'POST',body:'{}'});
  const batch=result.batches.find(b=>!b.seen&&b.revision>pending.after&&b.revision<=pending.revision);
  if(!batch||priceInteraction!==interaction||pricePopupBlocked())return;
  await showPriceChanges({revision:batch.revision,automatic:true,isCurrent:()=>priceInteraction===interaction});
 }catch(error){console.warn('价格变化记录读取失败',error.message);}finally{priceChecking=false;}
}
async function receiveErpForPrices(result,options){
 try{const accepted=await receiveErp(result,options);if(accepted===false)priceNotifications.length=0;return accepted;}
 catch(error){priceNotifications.length=0;throw error;}
}
let inventoryView=null;
function leaveInventoryPage(){
 if(inventoryView?.busy()){toast('请等待库存操作完成');return false;}
 if(inventoryView){
  inventoryView.dispose();inventoryView=null;
  $('#inventory-check-page').hidden=true;$('.workspace').classList.remove('inventory-check-active');
 }
 return true;
}
// 库存页保留入口店铺和链接。返回价格页恢复原筛选，定位则直接交给总表。
async function openStockCheckFull(product=null,shopId=activeShopId){
 if(inventoryView||!leaveSourceSheet())return;
 const price=globalThis.workbenchPriceProfitView,fromPrice=price?.visible();
 if(fromPrice){
  await price.hide();
  if(price.visible())return;
 }
 if(inventoryView)return;
 const root=$('#inventory-check-page'),shop=shopById(shopId);
 const catalog=()=>sourcesFor(state,shop.id);
 const load=async productId=>{
  if(!nasMain)return;
  // 单链接检查只补齐该链接。价格页返回后还要刷新全店角标，保留全店详情。
  const scope=shopRateRows(shop.id).filter(c=>fromPrice||!productId||c.productId===productId);
  await loadPriceDetails(scope.map(c=>c.id));
 };
 const currentLink=product??(current()?.shopId===shopId?currentProduct():null);
 root.hidden=false;$('.workspace').classList.add('inventory-check-active');
 inventoryView=openInventoryCheck({root,esc,shop,product:currentLink,single:!!product,fromPrice,load,
  getConfigs:()=>ordinaryConfigs(state.configs),getCosts:()=>state.costSource,getCatalog:catalog,download:downloadBlob,
  getShopLinkCount:()=>inventoryLinks(shopRateRows(shop.id),shop.id).length,
  back:()=>{
   if(!leaveInventoryPage())return;
   if(fromPrice)price.show({resume:true});
   else{renderAll();compactWorkspace().catch(error=>toast(error.message));}
  },
  locate:async id=>{
   const target=state.configs.find(c=>c.id===id&&c.shopId===shopId&&!c.deletedAt);
   if(!target)return toast('配置已变化，请重新检查');
   if(!leaveInventoryPage())return;
   if(activeShopId!==shopId){activeShopId=shopId;localStorage.setItem('diy-active-shop',shopId);selected.clear();collapsedProducts.clear();}
   $('#search').value='';$('#link-category-filter').value='';listPinnedProduct=target.productId;
   await activate(id);if(current()?.id===id){switchTab('parts');continuousWorkbench?.locate(id);}
  },
  apply:async plan=>{
   await save();validateStockReplacement(plan,state.configs,state.costSource,catalog());
   try{
    await applyBatchChanges(plan,`库存检查批量替换展示与实际配件：${plan.changes.length} 套配置`,null,{stockShopId:shopId});
   }catch(error){
    // 仅重试本次原事务，避免网络回执丢失后生成新的批号。
    if(!nasMain&&batchPending){
     const original=batchPending;
     error.retryStockSave=async()=>{
      if(batchPending!==original)throw Error('原保存状态已变化，请重新检查库存');
      await sendBatchPending();
     };
    }else if(error.nasPlanId){
     error.retryStockSave=async()=>{
      const pending=await nasWorkspace.queue().read();
      if(pending?.id!==error.nasPlanId)throw Error('原批次状态已变化，请重新检查库存');
      if(pending.batches.some(b=>b.status==='rejected')){
       await openNasPlanStatus();throw Error('原批次已被拒绝，请处理批次后重新检查库存');
      }
      const action=pending.batches.some(b=>b.status==='unknown')?'retry':'submit';
      const result=await runNasQueue(action);
      if(result.batches.some(b=>b.status!=='done'))throw Error('当前批次已确认，可继续保存剩余批次');
     };
    }
    throw error;
   }
  }
 });
}
// 打开输出源维护，来源编辑状态参与退出及保存保护。
function leaveSourceSheet(){
 const editor=window.workbenchSourceEditor;
 return !editor?.sheet||editor.leave();
}
const sourceReviewRows=()=>currentCatalog().filter(row=>!row.deletedAt);
const sourceActionTitle=action=>({restore:'还原输出源差异修改',ignore:'保留当前内容并忽略本次',unignore:'恢复待确认差异'}[action]??'确认更新输出源差异');
let alertShop=null,alertGeneration=0;
let sourceChangeSession=null;
// 快捷修改和工作表可以先后打开，补导记录只在当前店和工作表会话内接续。
function currentSourceChanges(){
 if(sourceChangeSession?.shopId!==activeShopId)sourceChangeSession=new SourceChangeSession(activeShopId);
 return sourceChangeSession;
}

// NAS 的引用接口限定当前店；按批查询后去重，摘要不作为保存正文。
async function loadAffectedSourceConfigs(rows,shop){
 if(activeShopId!==shop)throw Error('已切换店铺，请重新打开输出源。');
 if(!nasMain)return ordinaryAvailable();
 const ids=new Set();
 for(let i=0;i<rows.length;i+=5000){
  const batch=rows.slice(i,i+5000);
  const usage=await nasWorkspace.sourceUsage([...new Set(batch.map(row=>row.sourceId).filter(Boolean))],
   [...new Set(batch.map(row=>row.goodsId).filter(Boolean))]);
  for(const id of usage)ids.add(id);
 }
 if(activeShopId!==shop)throw Error('已切换店铺，请重新打开输出源。');
 await loadNasScope([...ids]);
 return ordinaryConfigs(state.configs.filter(c=>ids.has(c.id)&&!c.deletedAt&&c.shopId===shop));
}
async function refreshSourceAlerts(){
 const shop=activeShopId,turn=++alertGeneration;
 const rows=sourceReviewRows();
 let configs;
 if(nasMain){
  // 未处理的差异始终参与提醒，七天期限只适用于已忽略记录的回看。
  const all=ordinaryAvailable(),loaded=new Set(loadedIds());
  if(all.every(c=>loaded.has(c.id)))configs=all;
  else{
   await loadAffectedSourceConfigs(rows,shop);
   // NAS 引用查询只含已保存的关联；当前编辑器里新绑定来源的配置也参与同一轮统计。
   configs=ordinaryConfigs(state.configs.filter(c=>c.shopId===shop&&!c.deletedAt));
  }
 }else{
  configs=ordinaryAvailable();
  if(!fullWorkspace){
   // 离线启动仍使用列表摘要；只为本店有来源候选的配件读取原文，不切换编辑器模式。
   const goods=new Set(rows.map(row=>row.goodsId).filter(Boolean)),loaded=new Set(loadedIds());
   const missing=configs.filter(c=>!loaded.has(c.id)&&c.parts?.some(p=>goods.has(p.goodsId)||p.sourceId));
   const details=missing.length?await lazyWorkspace.load(missing.map(c=>c.id),{cacheResults:false}):[];
   configs=[...configs.filter(c=>loaded.has(c.id)),...details];
  }
 }
 if(turn!==alertGeneration||shop!==activeShopId)return;
 publishSourceSummary(document,shop,sourceFollowSummary(configs,rows,shop));
}
function observeSourceAlertShop(){
 if(alertShop===activeShopId)return;
 alertShop=activeShopId;sourceChangeSession=null;
 publishSourceSummary(document,alertShop,{count:0,latestChangedAt:null});
 // 后台统计不占用编辑器，失败后打开工作表或刷新差异时会重新读取。
 void refreshSourceAlerts().catch(error=>console.warn('读取本店输出源提醒失败',error.message));
}
async function prepareSourceExport(changes,scope,shop){
 if(shop!==activeShopId)throw Error('已切换店铺，请重新准备导图。');
 const linkKey=c=>c.productId||c.product||c.spu||'';
 const links=new Set(changes.map(change=>linkKey(change.before||change)));
 const related=ordinaryAvailable().filter(c=>links.has(linkKey(c)));
 // 即使只导本次更新，也需要链接全组以保留图片编号。
 const configs=nasMain?await loadNasBatchExportConfigs(related.map(c=>c.id)):related;
 if(shop!==activeShopId)throw Error('已切换店铺，请重新准备导图。');
 // 与常规批量导图一致，配置图和 SKU 图都采用该链接已保存的加购方案。
 return configs.map(config=>withAddonPackText(config,false));
}
// 两种来源编辑入口共用保存成功后的检查。配置加载或导图失败时，来源回执仍然有效。
function sourceSaveWithDecision(api){
 const shop=activeShopId;
 let pendingBaseline=null;
 return async changes=>{
  const sessionChanges=currentSourceChanges();
  const edited=changes.flatMap(change=>{
   const fields=editedSourceTextFields(change,shop);
   return fields.length?[{change,fields}]:[];
  });
  const ids=new Map(),sharedIds=new Map();
  for(const {change,fields} of edited){
   ids.set(change.row.sourceId,fields);
   if(change.managed)sharedIds.set(change.managed.id,fields);
  }
  const affectedFields=row=>new Set([...(ids.get(row.sourceId)??[]),...(sharedIds.get(row.sharedSourceId||row.goodsId)??[])]);
  // 多条来源逐笔保存时可能中断。重试沿用同一批次最初的有效值。
  const signature=JSON.stringify(edited);
  if(pendingBaseline?.signature!==signature)pendingBaseline={signature,rows:edited.length?sourceReviewRows().filter(row=>affectedFields(row).size):[]};
  const before=pendingBaseline.rows;
  const result=await api.applyBatch(changes);
  pendingBaseline=null;
  if(shop!==activeShopId||!api.applySync)return result;
  for(const [id,fields] of ids)if(result.sourceIds?.[id])ids.set(result.sourceIds[id],fields);
  try{
   const changed=edited.length?changedSourceText(before,sourceReviewRows(),affectedFields):[];
   if(changed.length){
    const rows=changed.map(({row})=>row);
    const configs=await loadAffectedSourceConfigs(rows,shop);
    if(shop!==activeShopId)return result;
    const plan=followPendingSourcePlan(configs,sourceReviewRows(),shop,{
     fieldsBySource:new Map(changed.map(({row,fields})=>[row.sourceId,fields])),previousRows:before,
    });
    if(plan.followConfigCount||plan.manualConfigCount){
     void openSavedAddonDecision({plan,rows,apply:api.applySync,getConfigs:api.getConfigs,errorText:api.errorText,
      prepareExport:prepareSourceExport,download:api.download,message:sourceSyncMessage,
      onUpdatedWithoutExport:records=>sessionChanges.record(records),
      onChanged:()=>refreshSourceAlerts()}).catch(error=>sourceSyncMessage(error.message));
    }
   }
   await refreshSourceAlerts();
  }catch(error){sourceSyncMessage('输出源已保存，读取待确认差异失败。'+error.message);}
  return result;
 };
}
function sourceSyncMessage(text){
 const status=$('[data-sheet-message]');
 if(status)status.textContent=text;
 toast(text);
}
async function openSourceMaintenance(options){
 const api={...options,applyBatch:sourceSaveWithDecision(options),getReviewRows:sourceReviewRows,
  getDraftStates:nasWorkspace?.sourceDraftStates,
  refreshAlerts:refreshSourceAlerts,prepareExport:prepareSourceExport};
 if(!leaveInventoryPage())return;
 if(api.quickEdit)return openSourceEditor(api);
 const current=window.workbenchSourceEditor;
 if(current?.sheet||current?.hasPending()){
  current.restore();
  if(api.focusSourceId)current.locate?.(api.focusSourceId);
  return current;
 }
 const price=window.workbenchPriceProfitView;
 if(price?.visible()){
  await price.hide();
  if(price.visible())return;
 }
 if($('#dialog').open)closeDialog();
 const automatic=currentSourceChanges();
 return openSourceSheet($('#source-sheet-page'),{...api,closeDialog,toast,automatic,
  getAllRows:api.getSheetRows??api.getAllRows,
  changeShop:id=>{
   const picker=$('#shop-picker');
   picker.value=id;
   picker.dispatchEvent(new Event('change',{bubbles:true}));
  },
  onClose:()=>{if(sourceChangeSession===automatic)sourceChangeSession=null;renderAll();setTimeout(()=>compactWorkspace().catch(()=>{}),0);},
 });
}
function openSourcesFull(options={}){return openSourceMaintenance({...options,shopIds:shops.map(shop=>shop.id),
 getDeletedSources:async()=>{
  const fresh=await request('/api/state?logs=none');
  if(fresh.revision!==acceptedState.revision)await acceptSavedState(acceptedState,fresh);
  return localDeletedSources(state,activeShopId);
 },
 changeDeletedSources:async(targets,action,confirmed)=>{
  await save();
  // 先在独立快照上检查、再以同一版本提交；不会将物理删除重基到刚被其他页面引用的来源上。
  const baseline=acceptedState,desired={...state,sourceCatalog:clone(state.sourceCatalog),shopSettings:clone(state.shopSettings)};
  changeLocalDeletedSources(desired,activeShopId,targets,action);
  const receipt=await request('/api/state',{method:'POST',body:JSON.stringify({baseRevision:baseline.revision,omitLogs:true,
   sourceCatalog:desired.sourceCatalog,shopSettings:desired.shopSettings,operator,message:action==='restore'?'恢复本店输出源':'彻底删除本店输出源'})});
  await acceptSavedState(baseline,receipt.state);
  state.revision=receipt.revision;state.updatedAt=receipt.updatedAt;
  // 旧的整库撤销快照可能重新带入被清理的来源，独立配置编辑历史仍可使用。
  if(action==='purge'){
   const ids=new Set(targets.map(row=>row.sourceId));
   const safe=entry=>isConfigHistorySnapshot(entry)&&!historyReferencesDeletedSource(entry,activeShopId,ids);
   history=history.filter(safe);redoHistory=redoHistory.filter(safe);
  }
  syncHistoryButtons();targets.forEach(confirmed);
 },
 erpSearch:findErpCandidates,readTaxCurrent:readSourceSheetTax,
 getSheetRows:()=>{
  const existing=new Set(state.sourceCatalog.map(row=>row.sourceId));
  const costs=new Map(state.costSource.map(row=>[row.goodsId,row]));
  return [...state.sourceCatalog,...currentCatalog().filter(row=>!existing.has(row.sourceId))].map(row=>{
   // 本机批次校验以共用成本源为基线，工作表显示与保存使用同一个核算价。
   const tax=costs.get(row.goodsId)?.tax;
   return tax==null||row.specialComponent?row:{...row,tax};
  });
 },
 getSheetConfigs:()=>ordinaryConfigs(liveConfigs(listConfigs())),openDialog,render:(container,model)=>reactWorkbench.dialog(container,'source-editor',model),renderDetail:(container,model)=>reactWorkbench.dialog(container,'source-editor-detail',model),release:container=>reactWorkbench.release(container),updateLinkCosts:async anchorId=>{await save();checkpoint();const result=updateLinkConfigCosts(ordinaryAvailable(),activeShopId,anchorId,state.costSource||[]);if(result.ids.length){changed(`链接恢复共用核算价：${result.count} 项`,result.ids);renderAll();await save();}return result;},lookupProduct:goodsId=>request('/api/sql-sync/product',{method:'POST',body:JSON.stringify({goodsId})}),flush:save,applyBatch:async changes=>{await save();const result=sourceBatch(state,changes,undefined,{deferText:true});checkpoint();state=result.next;catalog=sourceCatalog(state.sourceCatalog);changed(`批量维护输出源与加购：${result.count} 条`,result.configIds);renderAll();await save();return result;},download:downloadBlob,applySync:async plan=>{applySourceSync(plan,clone(ordinaryAvailable()),currentCatalog());checkpoint();const ids=applySourceSync(plan,ordinaryAvailable(),currentCatalog());for(const id of ids)displayBaseline.set(id,clone(state.configs.find(c=>c.id===id).parts));changed(`${sourceActionTitle(plan.action)}：${ids.length} 套配置`,ids);renderAll();await save();},validateImage:async c=>{const live=available().find(r=>r.id===c.id);if(!live||JSON.stringify({...c,layout:live.layout})!==JSON.stringify(live))throw Error('配置已变化，请重新预览后导出');},getCosts:()=>state.costSource,getRows:currentCatalog,getAllRows:()=>selectableComponents(state.sourceCatalog,state.costSource),shopId:()=>activeShopId,setDeleted:async(id,deleted)=>{checkpoint();if(!state.sourceCatalog.some(r=>r.sourceId===id)){const preset=currentCatalog().find(r=>r.sourceId===id);if(preset&&isSpecialComponent(preset))state.sourceCatalog.push(clone(preset));}setSourceDeleted(state.sourceCatalog,id,deleted);catalog=sourceCatalog(state.sourceCatalog);changed(deleted?'删除本店输出源':'恢复本店输出源',[]);await save();},saveSkuMode,getConfigs:ordinaryAvailable,currentProductId:()=>current()?.productId,selectedIds:()=>[...selected]});}
// 对选定范围批量维护升级描述并预览差异。
function openUpgradeDescriptionsFull(local=false,field='upgrade'){const scope=local?available:ordinaryAvailable;openUpgradeDescriptionBatch({errorText:error=>nasErrorText(error,listConfigs()),loadExportConfigs:nasMain?loadNasBatchExportConfigs:null,projectExportConfig:config=>withAddonPackText(config,false),render:model=>reactWorkbench.dialog($('#dialog-body'),'batch-description',model),openDialog,esc,save,saveSkuMode,download:downloadBlob,field,openDisplayNames:()=>openUpgradeDescriptions(local,'displayName'),getConfigs:scope,...(local?{productId:currentProduct()?.id,getSelectedIds:()=>chosen().map(c=>c.id)}:{}),apply:async plan=>applyBatchChanges(plan,`${plan.undo?'还原批量':'批量修改'}${field==='displayName'?'配件展示名称':'加购描述'}：${plan.changes.length} 套配置`)});}
// 预览并应用链接内配件更换，支持导出本次发生变化的配置图片。
function openLinkPartsDialogFull(){
 const openedShop=activeShopId;
 openLinkParts({render:model=>reactWorkbench.dialog($('#dialog-body'),'link-parts',model),renderRule:(container,model)=>reactWorkbench.dialog(container,'link-parts-rule',model),renderOverview:(container,model)=>reactWorkbench.dialog(container,'link-parts-overview',model),release:container=>reactWorkbench.release(container),product:currentProduct(),openDialog,esc,toast,getConfigs:available,getSelectedIds:()=>chosen().map(c=>c.id),getCatalog:currentCatalog,getCosts:()=>state.costSource,loadScope:nasMain?loadNasScope:null,errorText:error=>nasErrorText(error,listConfigs()),
  apply:async plan=>{
   await applyPartBatch(plan,`${plan.scopeType==='selected'?'勾选配置':'链接内'}批量修改配件：${plan.changes.length} 套配置`);
   try{
    if(nasMain){const links=new Set(plan.changes.map(row=>row.before.productId));await loadNasScope(available().filter(c=>links.has(c.productId)).map(c=>c.id));return {configs:state.configs.filter(c=>c.shopId===openedShop)};}
    const prepared=await prepareWorkspaceState(acceptedState,baseCatalog);const configs=prepared.state.configs.filter(c=>c.shopId===openedShop);for(const c of configs){c.modules=posterModules(c);c.upgradeWeight??=400;}return {configs};}
   catch(error){error.saved=true;throw error;}
  },
  exportImages:async(scope,kind,status,{signal,skuMode})=>{
   exportJobs++;clearTimeout(imageTimer);
   try{return await exportBatchImages({getSkuModes:()=>new Map(ordinaryAvailable().map(c=>[c.id,skuImageMode(c)])),saveSkuMode,download:downloadBlob,projectExportConfig:c=>withAddonPackText(c,false),renderImage:(c,width)=>imageRenderGate.run(({beforeDraw})=>drawPoster(c,width,{beforeDraw}))},scope.productIds,status,{imageKind:kind,skuMode,signal,snapshots:scope.snapshots,configIds:scope.exportConfigIds,deduplicateNames:true});}
   finally{exportJobs--;scheduleImageSave();}
  }
 });
}
// 跨链接批量更换配件，共用预览、事务应用和冲突保护。
function openGlobalPartsFull(){
 openGlobalBatch({openUpgrades:()=>openUpgradeDescriptions(),openDialog,esc,toast,getConfigs:ordinaryAvailable,getCatalog:currentCatalog,save,saveSkuMode,download:downloadBlob,loadExportConfigs:nasMain?loadNasBatchExportConfigs:null,projectExportConfig:config=>withAddonPackText(config,false),
  apply:plan=>applyPartBatch(plan,`${plan.undo?'还原跨链接批量配件':'跨链接批量更换配件'}：${plan.changes.length} 套配置`),
  undoSaved:nasMain?entry=>replayNasPartBatch(entry,'还原跨链接批量配件'):null,errorText:error=>nasErrorText(error,listConfigs())});
}
// 维护三店共用核算价，确认后重算相关数据并保存。
// 11-19：总表里改过的「含税单价」→ 应用到全局（三店共用核算价）。
// 1) 改共用成本行；2) 所有用到这个 GoodID 的配置跟着变；3) 跟新价相同的「单独核算价」自动取消；
// 4) 跟新价不同的单独核算价保留（那是别人有意设的），只在弹窗里提示数量。一次 checkpoint，可 Ctrl+Z。
function globalTaxImpact(goodsId,value){
 const cents=v=>Math.round(Number(v)*100);const byShop=new Map();let same=0,kept=0,follow=0;
 for(const c of state.configs){if(c.deletedAt||isLegacyTemplateConfig(c))continue;let hit=false;
  for(const p of [...(c.actualParts||[])])if(String(p.goodsId||'')===String(goodsId)){hit=true;if(hasConfigCost(p)){cents(p.taxOverride.value)===cents(value)?same++:kept++;}else follow++;}
  if(hit){const k=c.shopId;if(!byShop.has(k))byShop.set(k,{configs:0,links:new Set()});const r=byShop.get(k);r.configs++;r.links.add(c.productId);}}
 return {byShop,same,kept,follow};
}
function openGlobalTax(goodsId,value,name,restore=false){
 if(nasMain)return openNasGlobalTax(goodsId,value,name,restore).catch(error=>toast(nasErrorText(error)));
 const row=(state.costSource||[]).find(r=>r.goodsId===String(goodsId));
 if(!row)return toast('共用核算价里没有这个 GoodID，不能应用到全局');
 const fmt=v=>v==null?'—':'¥'+Number(v).toLocaleString('zh-CN',{maximumFractionDigits:2});
 if(restore){if(!row.globalTax)return toast('这个配件没有全局改价记录');value=row.globalTax.base;}
 const im=globalTaxImpact(goodsId,value);
 const shops=[...im.byShop].map(([id,r])=>`<li><strong>${esc(shopById(id)?.shortName||id)}</strong>：${r.links.size} 个链接 · ${r.configs} 套配置</li>`).join('')||'<li>没有配置用到它</li>';
 openDialog(restore?'全局恢复成本表价格':'应用到全局核算价',`<div class="gtax"><p><strong>${esc(name||'')}</strong><br><small>GoodID ${esc(goodsId)}</small></p><p class="gtax-price">${fmt(row.tax)} <span>→</span> <b>${fmt(value)}</b></p><p class="hint">${restore?`恢复到改价前的成本表价格（${esc(new Date(row.globalTax.at).toLocaleString('zh-CN'))} 改成 ${fmt(row.globalTax.value)}）。`:''}这是<strong>三店共用</strong>核算价，所有链接里出现这个配件的配置都会按${restore?'原价':'新价'}核算：</p><ul>${shops}</ul><p class="hint">跟随共用价 ${im.follow} 处 · 单独核算价与目标价相同、将自动取消 ${im.same} 处${im.kept?` · <span style="color:#b42318">另有 ${im.kept} 处单独核算价与目标价不同，保留不动</span>`:''}</p><div class="actions"><button id="gtax-cancel">取消</button><button id="gtax-apply" class="primary">${restore?'全局恢复':'应用到全局'}</button></div></div>`);
 $('#gtax-cancel').onclick=closeDialog;
 $('#gtax-apply').onclick=fullAction(()=>{
  checkpoint();const at=new Date().toISOString();
  // 记录改价前的成本表价格：多次全局改价只记第一次的原价；改回原价即视为已恢复。
  const base=row.globalTax?row.globalTax.base:row.tax;
  const ids=applyManualCosts(state,[{goodsId:String(goodsId),tax:Number(value)}],at);
  const live=state.costSource.find(r=>r.goodsId===String(goodsId));
  if(restore||Math.round(Number(base)*100)===Math.round(Number(value)*100))delete live.globalTax;else live.globalTax={base,value:Number(value),at,by:operator||''};
  // 与新共用价一致的单独核算价不再需要，取消掉，表里的黄色标记随之消失。
  for(const c of state.configs)for(const p of (c.actualParts||[]))if(String(p.goodsId||'')===String(goodsId)&&hasConfigCost(p)&&Math.round(p.taxOverride.value*100)===Math.round(Number(value)*100)){delete p.taxOverride;p.tax=Number(value);}
  catalog=sourceCatalog(state.sourceCatalog);changed(`${restore?'全局恢复核算价':'应用到全局核算价'}：${name||goodsId} → ${value}`,ids);closeDialog();renderAll();
  toast(`${restore?'已全局恢复':'已应用到全局'}：${ids.length} 套配置按${restore?'原价':'新价'}核算${im.kept?`，${im.kept} 处单独核算价保留`:''}（可 Ctrl+Z 撤销）`);
 });
}
// 11-19：总表里的加购描述【…】→ 应用到本链接 / 全局。
// 本链接：按同一个展示配件（来源 ID → GoodID → 型号）匹配当前链接。
// 全局：三店统一。按 GoodID 匹配三个店所有链接；同时写进三个店这个 GoodID 的「输出源」加购文案，
//       以后任何店新写配置选到这个配件，自动带上这条加购。
const upgradeKey=(p,scope)=>scope==='all'?(p.goodsId?'g:'+p.goodsId:'n:'+(p.name||'')):(p.sourceId?'s:'+p.sourceId:p.goodsId?'g:'+p.goodsId:'n:'+(p.name||''));
function upgradeTargets(src,part,scope){
 const want=upgradeKey(part,scope),text=String(part.upgrade||'');const hits=[];
 const pool=scope==='all'?state.configs.filter(c=>!c.deletedAt&&!isLegacyTemplateConfig(c)):ordinaryAvailable().filter(c=>c.shopId===src.shopId&&c.productId===src.productId);
 for(const c of pool){if(c.id===src.id)continue;
  (c.parts||[]).forEach((p,i)=>{if(upgradeKey(p,scope)===want&&String(p.upgrade||'')!==text)hits.push({c,i,before:String(p.upgrade||'')});});}
 return hits;
}
// 三店里这个 GoodID 的输出源行；带「加购选配」设置的行，新配置会以选配为准，单独提示。
function upgradeSourceRows(part){
 if(!part.goodsId)return {rows:[],ruled:[],missing:shops.map(s=>s.id)};
 const rows=(state.sourceCatalog||[]).filter(r=>!r.deletedAt&&String(r.goodsId||'')===String(part.goodsId));
 const ruled=rows.filter(r=>r.addonChoices!==undefined||r.addonShowTogether!==undefined||(r.addonVariants||[]).some(v=>v.showTogether!==undefined));
 const missing=shops.map(s=>s.id).filter(id=>!rows.some(r=>r.shopId===id));
 return {rows,ruled,missing};
}
function openUpgradeScope(id,slot,scope){
 if(nasMain)return openNasUpgradeScope(id,slot,scope).catch(error=>toast(nasErrorText(error)));
 const src=state.configs.find(c=>c.id===id&&!c.deletedAt);const part=src?.parts?.find(p=>p.slot===slot);if(!part)return toast('配置已变化，请重试');
 const all=scope==='all',text=String(part.upgrade||'').trim(),hits=upgradeTargets(src,part,scope),srcInfo=all?upgradeSourceRows(part):null;
 const label=part.displayName||part.name,shopName=id=>shopById(id)?.shortName||id;
 const sourceTodo=all&&srcInfo.rows.some(r=>String(r.upgrade||'').trim()!==text);
 if(!hits.length&&!sourceTodo)return toast(`${all?'三店':'本链接'}里用到「${label}」的配置，加购已经一致`);
 const byShop=new Map();for(const h of hits){const k=h.c.shopId;if(!byShop.has(k))byShop.set(k,{n:0,links:new Set()});const r=byShop.get(k);r.n++;r.links.add(h.c.productId);}
 const shopLines=all?[...byShop].map(([k,r])=>`<li><strong>${esc(shopName(k))}</strong>：${r.links.size} 个链接 · ${r.n} 处</li>`).join('')||'<li>现有配置都已一致</li>':'';
 const empty=hits.filter(h=>!h.before.trim()).length;
 const sample=hits.slice(0,6).map(h=>`<li>${all?esc(shopName(h.c.shopId))+' · ':''}${esc(h.c.product)} · ${esc(h.c.name)}：<s>${esc(h.before||'（空）')}</s></li>`).join('')+(hits.length>6?`<li>……另 ${hits.length-6} 处</li>`:'');
 const future=all?(part.goodsId?`<p class="hint"><b>以后新写配置</b>：已写入 ${srcInfo.rows.length} 个输出源（${[...new Set(srcInfo.rows.map(r=>shopName(r.shopId)))].join('、')||'无'}），任何店选到 GoodID ${esc(part.goodsId)} 都自动带这条加购。${srcInfo.missing.length?`<br><span style="color:#b42318">${srcInfo.missing.map(shopName).join('、')} 还没有这个配件的输出源，那边新建输出源后不会自动带。</span>`:''}${srcInfo.ruled.length?`<br><span style="color:#b42318">其中 ${srcInfo.ruled.length} 个输出源设置了「加购选配」，新配置仍按选配文案显示。</span>`:''}</p>`:'<p class="hint" style="color:#b42318">这个配件没有 GoodID，只改现有配置，不能写进输出源。</p>'):'';
 openDialog('加购应用到'+(all?'全局（三店）':'本链接'),`<div class="gtax"><p><strong>${esc(label)}</strong>${part.goodsId?`<br><small>GoodID ${esc(part.goodsId)}</small>`:''}</p><p class="gup-text">【${esc(text)}】</p><p class="hint">${all?'<strong>三店统一</strong>，按 GoodID 匹配所有链接：':'应用到<strong>本链接</strong>：'}${hits.length} 处配件${empty?`（其中 ${empty} 处原来没写加购）`:''}</p>${all?`<ul>${shopLines}</ul>`:''}${hits.length?`<ul>${sample}</ul>`:''}${future}<div class="actions"><button id="gup-cancel">取消</button><button id="gup-apply" class="primary">应用到${all?'全局（三店）':'本链接'}</button></div></div>`);
 $('#gup-cancel').onclick=closeDialog;
 $('#gup-apply').onclick=fullAction(()=>{
  const live=upgradeTargets(src,part,scope),rows=all?upgradeSourceRows(part).rows:[];
  if(!live.length&&!rows.length){closeDialog();return;}
  const ids=[...new Set(live.map(h=>h.c.id))];
  if(all)checkpoint();else checkpointConfig(ids);
  const value=part.upgrade;
  // 先改输出源，再改现有配置；全局时让配件保持「跟随输出源」，以后源文案再改还能一起更新。
  for(const r of rows)r.upgrade=value;
  const follow=p=>{if(!p.sourceFollow||p.sourceFollow.sourceId!==p.sourceId)p.sourceFollow={sourceId:p.sourceId};p.sourceFollow.upgrade={mode:'follow',value,sourceValue:value};};
  const livePart=state.configs.find(c=>c.id===src.id)?.parts?.find(p=>p.slot===slot);
  if(all&&livePart&&rows.some(r=>r.sourceId===livePart.sourceId))follow(livePart);
  for(const h of live){const p=h.c.parts[h.i];if(!String(p.upgrade??'').trim())delete p.overviewAddonHidden;p.upgrade=value;
   if(all&&rows.some(r=>r.sourceId===p.sourceId))follow(p);else markSourceFieldManual(p,'upgrade');}
  if(all)catalog=sourceCatalog(state.sourceCatalog);
  changed(`加购应用到${all?'全局（三店）':'本链接'}：${label}`,all?[...ids,src.id]:ids);closeDialog();renderAll();
  toast(`已更新 ${live.length} 处加购${all?`，并写入 ${rows.length} 个输出源`:''}，可 Ctrl+Z 撤销`);
 });
}
function openCostsFull(){openCostEditor({openDialog,getRows:()=>selectableComponents(state.costSource),lastErp:()=>state.erpSync?.updatedAt,apply:async entries=>{await save();const beforeRevision=acceptedState.revision;checkpoint();const ids=applyManualCosts(state,entries);catalog=sourceCatalog(state.sourceCatalog);changed(`人工更新 ${entries.length} 条三店共用核算价`,[]);renderAll();await save();queuePriceChanges({source:'cost-source',after:beforeRevision,revision:acceptedState.revision});await checkPriceChanges();return ids.length;}});}
// 接收已经提交的 ERP 数据；先尝试安全刷新，不在回调里重复保存。
async function receiveErp(result,{syncDialog=false}={}){
 if(result?.ok===true)queuePriceChanges({source:'erp',after:result.revision-1,revision:result.revision});
 // 按需工作区先尝试安全更新；只有确实涉及当前草稿时才转入显式比较。
 if(!fullWorkspace&&!conflict){if(await refreshCompactWorkspace(syncDialog))return true;if(!window.workbenchHasPendingChanges())return false;}
 const blocked=()=>window.workbenchHasPendingChanges()||conflict;
 if(blocked()){conflict=true;openConflict('ERP 数据已同步。此页有未保存修改，请先备份草稿，再重新载入。');return false;}
 const counter=changeCounter,next=await request('/api/state?logs=none');
 const prepared=await prepareWorkspaceState(next,baseCatalog);
 if(counter!==changeCounter||blocked()){conflict=true;openConflict('ERP 数据已同步。此页有新的修改，请先备份草稿，再重新载入。');return false;}
 state=prepared.state;acceptedState=next;catalog=prepared.catalog;
 if(active&&!current())active=null;
 const availableIds=new Set(available().map(c=>c.id));selected=new Set([...selected].filter(id=>availableIds.has(id)));
 history=[];redoHistory=[];imageRecords.clear();syncHistoryButtons();
 // ERP already committed state/history/activity in one backend transaction.
 // Client compatibility normalization stays in the draft until a real edit.
 renderAll(null,false);
 $('#save-status').textContent='已同步并载入本机配置';
 return true;
}
// 维护机箱图库或把图片应用到目标配置，异步操作前记录目标身份。
function openGalleryFull(pick=false,onPick=null){
 const targetId=pick?active:null;
 if(pick&&!current())return toast('请先选择一套配置');
 openCaseGallery({openDialog,closeDialog,esc,toast,uploadImage,render:model=>reactWorkbench.dialog($('#dialog-body'),'case-gallery',model),renderRegion:(container,kind,model)=>reactWorkbench.dialog(container,kind,model),release:container=>reactWorkbench.release(container),operator:()=>operator,getRows:()=>state.caseGallery||[],getConfigs:()=>state.configs,
  saveRows:async(rows,message)=>{validateGallery(rows);checkpoint();state.caseGallery=rows;changed(message,[]);await save();},
  useImage:async row=>{if(onPick)return onPick(row);const target=state.configs.find(c=>c.id===targetId&&!c.deletedAt);if(!target)throw Error('配置已变化，请重新选择配置');checkpointConfig([target.id]);useGalleryImage(target,row);changed(`从机箱图库选图：${row.name}`,[target.id],'asset');}
 },{pick,append:!!onPick});
}
// 展示分页活动记录，定位前刷新已保存数据并切换到目标字段。
async function showActivity(){await save();openActivity({openDialog,esc,request,toast,locate:async target=>{
 await save();if(fullWorkspace){const next=await request('/api/state?logs=none'),prepared=await prepareWorkspaceState(next,baseCatalog);state=prepared.state;acceptedState=next;catalog=prepared.catalog;}else await refreshCompactWorkspace();history=[];redoHistory=[];imageRecords.clear();
 if(target.shopId){activeShopId=target.shopId;localStorage.setItem('diy-active-shop',activeShopId);}closeDialog();
 if(target.type==='configuration'){
  if(!fullWorkspace&&lazyWorkspace.index().summaries.some(c=>c.id===target.id))await loadDetail(target.id);const c=state.configs.find(c=>c.id===target.id);if(!c||c.deletedAt){active=fullWorkspace?(ordinaryConfigs(available())[0]?.id||null):null;renderAll();return toast('该配置已删除，无法定位到编辑位置');}
  activeShopId=c.shopId;$('#search').value='';$('#link-category-filter').value='';await activate(c.id);switchTab(target.tab||'parts');
  const index=c.parts.findIndex(p=>p.slot===target.slot),element=index>=0?document.querySelector(target.field==='upgrade'?`[data-upgrade="${index}"]`:`[data-part-name="${index}"]`):target.field==='addons'?$('#add-addon'):target.field==='benefits'?$('#add-benefit'):document.querySelector(`[data-config="${target.field}"]`)||$('#editor');element?.scrollIntoView({block:'center'});element?.focus();return;
 }
 active=fullWorkspace?(ordinaryConfigs(available())[0]?.id||null):null;renderAll();
 if(target.type==='source'){await openSources({focusSourceId:target.id||target.goodsId});}
 else if(target.type==='component'){await openCosts();const input=$('#cost-source-search');input.value=target.goodsId||target.id.split('|').at(-1);input.oninput();}
 else if(target.type==='gallery'){await openGallery();[...document.querySelectorAll('[data-gallery-open]')].find(b=>b.dataset.galleryOpen===target.id)?.click();}
 else if(target.type==='template')openTemplates();else if(target.type==='settings')openShopSettings();else openCosts();
 }});}
// NAS 模式下原编辑器继续工作；只让配置正文进入 NAS 草稿，其他实体维护保持关闭。
const nasStageFailures=new Map(),nasWriteFailures=new Map();
// 只有同一笔落盘错误被修复时才撤销顶栏警告，其他编辑错误继续保留。
function reportDraftWrite(id,error){
 const previous=nasWriteFailures.get(id);
 if(error){nasWriteFailures.set(id,error);nasStageFailures.set(id,error);}
 else{nasWriteFailures.delete(id);if(nasStageFailures.get(id)===previous)nasStageFailures.delete(id);}
 nasDraftFailure=nasStageFailures.values().next().value||null;
 if(window.workbenchReady)syncNasControls();
}
const nasSavedVersions=new Map();
const nasCatalogRows=new Map();
// 三店操作复用当前账号、原配置草稿和持久操作回执。
let nasOverviewActions;
const overviewNas=()=>nasOverviewActions??=createNasOverviewActions({
 workspace:nasWorkspace,openDialog,closeDialog,esc,toast,
 currentDocument:id=>nasWorkspace.documentFor(state.configs.find(c=>c.id===id)),
 saveCurrent:async()=>{const c=current();if(c&&nasWorkspace.drafts().some(row=>row.id===c.id)){const receipt=await nasWorkspace.submit(c);nasSavedVersions.set(c.id,receipt.version);nasStageFailures.delete(c.id);nasDraftFailure=nasStageFailures.values().next().value||null;acceptedState.configs=acceptedState.configs.map(row=>row.id===c.id?nasWorkspace.documentFor(c):row);await readNasIndex();if(receipt.dependenciesRefreshed)await refreshNasSavedDependencies([c.id]);syncNasControls();}},
 saveCosts:changes=>startNasPlan('costs',changes,{title:'总表三店全局核算价'}),
 refresh:async()=>{await acceptNasPlan({kind:'costs',batches:[]});await loadNasCatalog('sources');renderAll();},
 lock:()=>{const root=$('.workspace'),previous=root.inert;root.inert=true;nasBusy=true;return()=>{nasBusy=false;root.inert=previous;syncNasControls();};},
 linkUpgrade:async(src,part,definition,origin)=>{
  const product=productGroups(available()).find(group=>group.id===src.productId);await loadNasScope(product.configs.map(c=>c.id));
  const sourceIds=[...new Set([origin.id,...catalogRows('sources').filter(row=>row.document.goodsId===origin.goodsId).map(row=>row.id)])];
  const sourceVersions=Object.fromEntries(await Promise.all(sourceIds.map(async id=>[id,(await origin.client.resource('sources',id)).version])));
  if(sourceVersions[origin.id]!==origin.version)throw Error('输出源已变化，请重新预览');
  const targets=product.configs.map(summary=>state.configs.find(c=>c.id===summary.id)).map(c=>({id:c.id,name:c.name,before:clone(c),
   after:applyStructuredUpgrade(c,part,definition,{scope:'link',sources:currentCatalog()})})).filter(row=>!sameNasDocument(row.before,row.after));
  if(!targets.length)return toast('本链接的加购文案、商品、数量和价格已经一致');
  openDialog('加购应用到本链接',`<div class="gtax"><p class="addon-sync-summary">${esc(upgradeAddonSummary(definition))}</p><p>同步 ${targets.length} 套配置的加购商品、数量、替换数量、价格和选配项。</p><ul>${targets.slice(0,8).map(row=>`<li>${esc(row.name)}</li>`).join('')}</ul><p class="hint">以输出源维护的数据为准；应用后点击顶部保存配置。本次只更新本链接，其它链接保留。</p><button id="gup-link-apply" class="primary">同步到本链接</button></div>`);
  $('#gup-link-apply').onclick=async event=>{
   const button=event.currentTarget;button.disabled=true;
   try{
    for(const [id,version] of Object.entries(sourceVersions))if((await origin.client.resource('sources',id)).version!==version)throw Error('输出源已被修改，请重新预览加购同步');
    const live=targets.map(row=>state.configs.find(c=>c.id===row.id));
    if(live.some((c,i)=>!c||!sameNasDocument(c,targets[i].before)))throw Error('配置已变化，请重新预览');
    const ids=targets.map(row=>row.id);
    await nasWorkspace.acceptSourceVersions(ids,sourceVersions);
    checkpointConfig(ids);
    live.forEach((c,i)=>{c.parts=targets[i].after.parts;c.addons=targets[i].after.addons;});
    // 补齐明确来源绑定也不应触发展示清单覆盖独立的实际 BOM。
    rememberDisplayParts(ids);
    changed('完整加购应用到本链接',ids);closeDialog();renderAll();toast('已同步加购商品、数量和价格，点击保存配置后生效');
   }catch(error){toast(nasErrorText(error));}finally{button.disabled=false;}
  };
 }
});
const openNasGlobalTax=(...args)=>overviewNas().tax(...args);
const openNasUpgradeScope=(...args)=>overviewNas().upgrade(...args);
function catalogRows(kind){return [...(nasCatalogRows.get(kind)?.values()||[])];}
function catalogRow(kind,id){return nasCatalogRows.get(kind)?.get(id);}
// 保存成功后的目录刷新与配置草稿分开，只更新来源/成本展示和数据时间。
async function refreshNasSavedDependencies(ids){
 try{
  const metadata=await nasWorkspace.refreshDependencies();
  state.sourceCatalog=metadata.sourceCatalog;state.costSource=metadata.costSource;
  catalog=sourceCatalog(state.sourceCatalog);nasCatalogRows.delete('sources');
  const unsaved=new Set(nasWorkspace.drafts().map(row=>row.id)),saved=new Set(ids);
  const costs=new Map(state.costSource.map(row=>[row.goodsId,row])),sources=new Map(catalog.map(row=>[row.sourceId,row]));
  const refreshed=[];
  for(const config of state.configs)if(saved.has(config.id)&&!unsaved.has(config.id)){
   // 同步展示投影基线与页面值，后续编辑不会把本次刷新误当成用户改动。
   nasWorkspace.applyPresentation(config,row=>{withCurrentSharedSource(row,sources,{deferText:true});visibleNasCosts(row,costs);});refreshed.push(config.id);
  }
  rememberDisplayParts(refreshed);renderAll();
 }catch(error){toast('配置已保存，目录刷新失败：'+nasErrorText(error));}
 finally{void refreshNasDataTime();}
}
function applyNasCatalog(kind,rows){
 nasCatalogRows.set(kind,new Map(rows.map(row=>[row.id,row])));
 const documents=rows.map(row=>clone(row.document));
 if(kind==='sources'){state.sourceCatalog=documents;catalog=sourceCatalog(state.sourceCatalog);}
 if(kind==='gallery')state.caseGallery=documents;
 if(kind==='templates')state.templates=documents;
}
async function loadNasCatalog(kind){
 const rows=await nasWorkspace.catalog().list(kind);
 if(!Array.isArray(rows)||new Set(rows.map(row=>row.id)).size!==rows.length||
  rows.some(row=>typeof row.id!=='string'||typeof row.version!=='string'||!row.document))throw Error('NAS 目录返回不完整。');
 applyNasCatalog(kind,rows);return rows;
}
/** 用本店刚读到的完整目录版本更新干净配置。草稿和在途保存由控制器保留原基线。 */
async function refreshSourceSyncDependencies(shop){
 if(shop!==activeShopId)throw Error('已切换店铺，请重新打开输出源。');
 const index=await readNasIndex();
 if(shop!==activeShopId)throw Error('已切换店铺，请重新打开输出源。');
 const rows=await loadNasCatalog('sources');
 if(shop!==activeShopId)throw Error('已切换店铺，请重新打开输出源。');
 return nasWorkspace.acceptObservedDependencies({
  sources:Object.fromEntries(rows.map(row=>[row.id,row.version])),
  costs:index.metadata.costVersions??{},
 },nasStageFailures);
}
async function readNasIndex(){
 const index=await lazyWorkspace.refresh();
 state.revision=index.revision;state.updatedAt=index.updatedAt;
 if(nasWorkspace.canPlan()){
  state.costSource=index.metadata.costSource;
  state.shopSettings={...state.shopSettings,[activeShopId]:index.metadata.shopSettings[activeShopId]};
 }
 acceptedState={...acceptedState,revision:index.revision,updatedAt:index.updatedAt};
 void refreshNasDataTime();
 return index;
}
// 范围工具只加载所选详情；摘要不能作为保存正文。
async function loadNasScope(ids){
 const loaded=new Set(state.configs.map(c=>c.id));
 const wanted=[...new Set(ids)].filter(id=>!loaded.has(id));
 if(!wanted.length)return;
 const revision=state.revision,counter=changeCounter;
 const raw=await lazyWorkspace.load(wanted),prepared=await prepareDetails(raw);
 if(revision!==state.revision||counter!==changeCounter)throw Error('载入时配置已有改动，请重新打开操作。');
 const currentIds=new Set(state.configs.map(c=>c.id));
 const missing=new Set(wanted.filter(id=>!currentIds.has(id)));
 state.configs.push(...prepared.filter(c=>missing.has(c.id)));
 acceptedState={...acceptedState,configs:[...acceptedState.configs,...raw.filter(c=>missing.has(c.id))]};
 rememberDisplayParts(wanted);
}
/** 载全命中链接后重新核验明细，一次检查点恢复共用价，不写共用成本源。 */
async function restoreOverviewTaxes(entries){
 const requested=new Map();for(const entry of entries){if(!requested.has(entry.configId))requested.set(entry.configId,new Set());requested.get(entry.configId).add(entry.lineKey);}
 const summaries=ordinaryConfigs(liveConfigs(listConfigs())),links=new Set(summaries.filter(c=>requested.has(c.id)).map(c=>JSON.stringify([c.shopId,c.productId])));
 await loadNasScope(summaries.filter(c=>links.has(JSON.stringify([c.shopId,c.productId]))).map(c=>c.id));
 if(nasMain&&(nasBusy||!nasWorkspace.canWrite()||[...requested.keys()].some(id=>nasWorkspace.pending(id))))throw Error('请等待配置保存或回执核对完成');
 const costs=state.costSource||[],index=new Map(costs.map(row=>[String(row.goodsId??''),row]));
 const targets=state.configs.filter(c=>requested.has(c.id)&&!c.deletedAt).map(c=>({config:c,lines:taxOverrideLines(c,index).filter(line=>requested.get(c.id).has(line.lineKey))})).filter(row=>row.lines.length);
 const count=targets.reduce((sum,row)=>sum+row.lines.length,0);if(!count)return false;
 if(!confirm(`确认将 ${targets.length} 套配置的 ${count} 项单独核算价恢复为最新共用价并保存？可用 Ctrl+Z 一步撤销。`))return false;
 const ids=targets.map(row=>row.config.id);checkpointConfig(ids);
 for(const {config,lines} of targets){ensureActualParts(config);const keys=new Set(lines.map(line=>line.lineKey));config.actualParts.forEach((part,i)=>{if(keys.has(taxLineKey(part,i)))resetConfigCost(part,costs);});}
 rememberDisplayParts(ids);changed(`恢复 ${targets.length} 套配置的共用核算价`,ids);continuousWorkbench?.draw();
 // 只提交本批目标，刷新后以服务端结果为准；其它配置的草稿不搭车保存。
 if(nasMain){
  const drafts=nasWorkspace.drafts(),results=await runNasDraftSaves(ids.map(id=>drafts.find(row=>row.id===id)||{id,name:state.configs.find(c=>c.id===id)?.name}));
  if(results.length!==ids.length||results.some(row=>!['saved','unchanged'].includes(row.status)))throw Error('单独核算价已恢复到本机草稿，但部分保存尚未确认，请核对保存结果后重试。');
 }else await save();
 globalThis.workbenchPriceProfitView?.refresh({force:true});return true;
}
// 大范围分批请求详情，期间让出主线程绘制进度；关闭弹窗后停止发起新批次。
async function loadPriceDetails(ids,{isOpen=()=>true,progress=()=>{}}={}){
 if(savePromise)await savePromise;
 if(batchPromise)await batchPromise;
 const loaded=new Set(state.configs.map(c=>c.id)),missing=ids.filter(id=>!loaded.has(id));
 let count=ids.length-missing.length;
 progress(count,ids.length);
 for(let offset=0;offset<missing.length&&isOpen();offset+=64){
  const chunk=missing.slice(offset,offset+64);
  await new Promise(resolve=>setTimeout(resolve,0));
  if(!isOpen())return;
  await loadNasScope(chunk);
  count+=chunk.length;
  progress(count,ids.length);
 }
}
// 批量保存会淘汰旧详情。生成图片前重新读入实际要出图的配置和版式。
async function loadNasBatchExportConfigs(ids){
 const shop=activeShopId,wanted=new Set(ids);
 await loadNasScope(ids);
 return state.configs.filter(config=>config.shopId===shop&&wanted.has(config.id)&&!config.deletedAt);
}
function nasScopeAction(fn,scope=ordinaryAvailable){
 return async(...args)=>{
  try{await loadNasScope(scope(...args).map(c=>c.id));return await fn(...args);}
  catch(error){toast(nasErrorText(error));}
 };
}
const nasGroup=product=>({product_id:product.id,configuration_ids:product.configs.map(c=>c.id)});
const nasApplied=plan=>plan?.batches.flatMap(batch=>batch.status==='done'?batch.result.changes:[])||[];
async function refreshNasPlanButton(){
 const button=$('#nas-workspace-plan');
 if(!button)return;
 try{const upgrade=await overviewNas().pending();button.hidden=!upgrade&&!(await nasWorkspace.queue().read());button.textContent=upgrade?'继续加购应用':'NAS 批量操作';}
 catch(error){toast(nasErrorText(error));}
}
async function acceptNasArchivedDrafts(plan){
 if(plan.kind!=='configurations')return;
 // 只处理已核对的归档回执，失败或未收到回执时保留对应本机草稿。
 const archived=nasApplied(plan).filter(entry=>entry.archived===true||entry.purged===true);
 if(!archived.length)return;
 await nasWorkspace.discardArchivedDrafts(archived);
 for(const entry of archived)nasStageFailures.delete(entry.configuration_id);
 nasDraftFailure=nasStageFailures.values().next().value||null;
}
async function acceptNasPlan(plan,{selectId=null}={}){
 if(plan.kind==='configurations')archivedCounts.delete(activeShopId);
 const applied=nasApplied(plan),removed=applied.filter(row=>row.archived===true).map(row=>row.configuration_id);
 const fallback=removed.includes(active)?configAfterRemoval(available(),active,removed):null;
 const listScroll=$('#config-list').scrollTop,sheetScroll=$('.ov-sheet-scroll')?.scrollTop??0,sheetLeft=$('.ov-sheet-scroll')?.scrollLeft??0;
 const reordered=applied.flatMap(row=>row.reordered??[]);
 // 多批可能重复返回同一配置的不同版本，只应用控制器本次实际接续的那一行。
 const rebased=new Set(await nasWorkspace.acceptRenumber(reordered,row=>{
  applyNasRenumber(state.configs.find(c=>c.id===row.configuration_id),row);
  applyNasRenumber(acceptedState.configs.find(c=>c.id===row.configuration_id),row,false);
 }));
 const expiredImages=new Set([...removed,...reordered.map(row=>row.configuration_id)]);
 for(const id of expiredImages)imageRecords.delete(id);
 if(expiredImages.has(active)||expiredImages.has(previewConfigId)){
  // 正在异步绘制的旧画布失效，在载入选中配置前也不允许旧结果回贴。
  ++previewToken;
  if(previewFrame!==null){cancelAnimationFrame(previewFrame);previewFrame=null;}
  releasePreview();
  $('#saved-image').classList.add('hidden');$('#saved-image').removeAttribute('href');
 }
 await acceptNasArchivedDrafts(plan);
 if(plan.kind==='configurations'&&plan.title==='保存价格利润表'){
  nasWorkspace.priceDraft(acknowledgeNasPriceDraft(plan,nasWorkspace.priceDraft(),sameNasDocument));
 }
 const changedIds=new Set(plan.kind==='configurations'?nasApplied(plan).map(entry=>entry.configuration_id):
  plan.kind==='quotations'?nasApplied(plan).map(entry=>entry.id):[]);
 await readNasIndex();
 // 链接加购包只改店铺保存区，配置草稿和撤销记录不参与本次提交。
 if(plan.kind==='settings'&&plan.batches.some(batch=>batch.body.changes.some(row=>row.fields?.addonPackChange))){
  continuousWorkbench?.draw();schedulePreview();return;
 }
 const draftIds=new Set(nasWorkspace.drafts().map(row=>row.id));
 for(const row of reordered)if(!rebased.has(row.configuration_id)&&!draftIds.has(row.configuration_id))changedIds.add(row.configuration_id);
 if(plan.kind==='costs'){
  await loadNasCatalog('sources');
  const costs=new Map(state.costSource.map(row=>[row.goodsId,row]));
  // 保留原草稿及其版本，只把最新成本叠加到展示和核算的投影。
  for(const config of state.configs){
   if(draftIds.has(config.id))nasWorkspace.applyPresentation(config,row=>visibleNasCosts(row,costs));
   else changedIds.add(config.id);
  }
 }
 for(const id of changedIds){nasWorkspace.release(id);displayBaseline.delete(id);nasStageFailures.delete(id);nasSavedVersions.delete(id);}
 state.configs=state.configs.filter(c=>!changedIds.has(c.id));
 acceptedState={...acceptedState,configs:acceptedState.configs.filter(c=>!changedIds.has(c.id))};
 const ids=new Set(lazyWorkspace.index().summaries.map(c=>c.id));
 selected=new Set([...selected].filter(id=>ids.has(id)));
 // 已保存的换件记录自身会校验字段，可以跨新一批换件保留；普通编辑仍按原规则重置。
 history=plan.partHistory?history.filter(entry=>entry.historyScope==='nas-part-batch'):[];
 redoHistory=plan.partHistory?.sourceEntryId?redoHistory.filter(entry=>entry.historyScope==='nas-part-batch'):[];
 syncHistoryButtons();posterEditor?.clear();
 selectId=selectId??fallback;
 if(selectId&&ids.has(selectId)){active=null;selected.add(selectId);await activate(selectId);}
 else if(active&&ids.has(active)){await loadDetail(active);renderAll();}
 else{active=null;renderAll();}
 const priceView=globalThis.workbenchPriceProfitView;
 if(priceView?.visible()){
  // 链接设置等操作会淘汰旧详情，价格表重新补齐后才刷新利润。
  try{await loadPriceDetails(ordinaryAvailable().map(c=>c.id));priceView.refresh({force:reordered.length>0});}
  catch(error){toast(nasErrorText(error));}
 }
 if(removed.length)requestAnimationFrame(()=>{$('#config-list').scrollTop=listScroll;const sheet=$('.ov-sheet-scroll');if(sheet){sheet.scrollTop=sheetScroll;sheet.scrollLeft=sheetLeft;}if(selectId)continuousWorkbench?.locate(selectId);});
}
async function runNasQueue(action,{selectId=null}={}){
 if(nasBusy)throw Error('请等待正在进行的 NAS 操作。');
 nasBusy=true;const workspace=$('.workspace'),wasInert=workspace.inert;workspace.inert=true;syncNasControls();
 const queue=nasWorkspace.queue();
 try{
  const plan=action==='receipt'?await queue.receipt():action==='retry'?await queue.retry():await queue.submit(plan=>{
   $('#save-status').textContent=`批量已确认 ${nasApplied(plan).length} / ${plan.total} 项`;
  });
  await acceptNasPlan(plan,{selectId});
  if(plan.batches.every(batch=>batch.status==='done')){
   await queue.clear();
   plan.historyEntry=await registerNasPartUndo(plan);
  }
  toast(`NAS 已确认 ${nasApplied(plan).length} / ${plan.total} 项`);
  return plan;
 }catch(error){
  const plan=await queue.read().catch(()=>null),applied=nasApplied(plan).length;
  if(applied)await acceptNasPlan(plan).catch(()=>{});
  if(applied)toast(`已确认 ${applied} / ${plan.total} 项；`+nasErrorText(error));
  throw error;
 }finally{nasBusy=false;workspace.inert=wasInert;syncNasControls();await refreshNasPlanButton();}
}
async function startNasPlan(kind,changes,{title,group=null,selectId=null,partHistory=null}={}){
 if(!nasWorkspace.canPlan())throw Error('当前 NAS 服务没有开放批量维护。');
 const queue=nasWorkspace.queue();
 if(await queue.read())throw Object.assign(Error('请先处理上一项批量操作。'),{code:'WORKSPACE_PLAN_PENDING'});
 const plan=buildNasOperationPlan(kind,changes,{group,title});
 if(partHistory)plan.partHistory=partHistory;
 if(plan.batches.length>1&&!confirm(`${title}含 ${plan.total} 项，将分 ${plan.batches.length} 批保存，每批单独生效。如果某批失败或结果未知，其余批次会暂停。继续？`))return null;
 await queue.add(plan);
 try{return await runNasQueue('submit',{selectId});}
 catch(error){error.nasPlanId=plan.id;throw error;}
}
function snapshotNasCosts(){
 return new Map(state.costSource.filter(row=>/^\d{1,20}$/.test(row.goodsId||'')).map(row=>[row.goodsId,{version:nasWorkspace.costVersion(row.goodsId),document:clone(row)}]));
}
let nasErpUi;
function nasCostContext(){
 // 大库差异按读取时的本店成本版本确认，页面草稿不参与此写计划。
 return JSON.stringify([state.revision,activeShopId,[...snapshotNasCosts()].map(([id,row])=>[id,row.version])]);
}
function lastNasErp(){
 const times=state.costSource.map(row=>nasTimeStamp(row.stockUpdatedAt)).filter(Boolean).sort();
 return times.at(-1)||null;
}
function bindNasErp(){
 const adapter=createNasErpUiAdapter({read:(...args)=>nasWorkspace.readErp(...args),snapshot:snapshotNasCosts,readSyncSnapshot:()=>nasWorkspace.costSyncSnapshot(),shopId:activeShopId,context:nasCostContext,shopName:currentShop().shortName,
  apply:(changes,kind)=>startNasPlan('costs',changes,{title:kind==='erp'?'同步三店 ERP 库存和成本':'同步三店含税成本表'})});
 nasErpUi=bindErpSync({nas:true,...adapter,openDialog,toast,flush:save,operator:()=>operator,
  context:nasCostContext,hasPending:()=>nasBusy||!!nasDraftFailure,receive:result=>result?.committed===true,
  errorText:error=>error.code==='VERSION_CONFLICT'?
   (error.details?.goods_id?'货号 '+error.details.goods_id+' 的':'')+'服务端成本已变化。请在「NAS 批量操作」核对并结束旧计划，再重新读取预览。':
   error.code==='NAS_COST_SYNC_NOT_INSTALLED'?'服务器尚未启用三店成本同步，请联系管理员。':nasErrorText(error),
  erpStatus:()=>({lastSuccess:{stockUpdatedAt:lastNasErp()}})});
}
function openNasErp(){nasErpUi?.setup();}
function openNasCosts(goodsId){
 const shop=activeShopId;
 const versions=new Map([...snapshotNasCosts()].map(([id,row])=>[id,row.version]));
 let workbookPrices=new Map();
 const checkShop=()=>{if(activeShopId!==shop)throw Error('当前店铺已切换，请重新打开核算价。');};
 async function readWorkbook(ids){
  const result=await nasWorkspace.readErp('tax-current',ids);
  if(!Array.isArray(result.rows))throw Error('成本表读取结果不完整。');
  const keys=new Set(ids),prices=new Map();
  for(const row of result.rows){
   if(!keys.has(row.goods_id)||prices.has(row.goods_id)||!Number.isFinite(row.tax)||row.tax<0)
    throw Error('成本表返回的商品或核算价无效。');
   prices.set(row.goods_id,row.tax);
  }
  return {prices,source:result.workbook};
 }
 async function apply(entries,action,title){
  checkShop();
  const date=new Date().toISOString(),changes=entries.map(row=>({id:row.goodsId,action,
   expected_version:versions.get(row.goodsId)??null,fields:{tax:row.tax,taxUpdatedAt:date}}));
  const outcome=await startNasPlan('costs',changes,{title});
  if(!outcome)throw Error('已取消。');
  const confirmed=nasApplied(outcome);
  for(const row of confirmed)versions.set(row.id,row.version);
  if(confirmed.length!==changes.length)throw Error(`已确认 ${confirmed.length} / ${changes.length} 条，请在 NAS 批量操作中查看余下项目。`);
 }
 openCostEditor({nas:true,openDialog,lastErp:lastNasErp,focusGoodsId:typeof goodsId==='string'?goodsId:null,
  // 重读成本表只更新预览，已手改的行继续显示服务端价。
  getRows:()=>selectableComponents(state.costSource).map(row=>row.nasManualTax!==true&&workbookPrices.has(row.goodsId)?{...row,tax:workbookPrices.get(row.goodsId)}:row),
  reloadCosts:async()=>{
   workbookPrices.clear();
   const {prices,source}=await readWorkbook([...versions.keys()]);
   checkShop();workbookPrices=prices;
   return `${source?.name||'主机成本表'}${source?.modified?' · 文件时间 '+new Date(source.modified).toLocaleString('zh-CN'):''} · 匹配 ${workbookPrices.size} 条`;
  },
  apply:entries=>apply(entries,'tax_edit','更新'+currentShop().shortName+'含税成本'),
  resume:async goodsId=>{
   checkShop();
   const {prices}=await readWorkbook([goodsId]);
   if(!prices.has(goodsId))throw Error('成本表中没有这个配件的有效核算价，已保留手动核算价。');
   const tax=prices.get(goodsId);
   await apply([{goodsId,tax}],'tax_resume','重新同步核算价');
   workbookPrices.set(goodsId,tax);
   return tax;
  }});
}
function openNasActivity(){
 openActivity({openDialog,esc,toast,shop:currentShop(),ownUid:nasWorkspace.memberUid(),errorText:nasErrorText,
  loadNasPage:query=>nasWorkspace.activityPage(query),
  purgeNas:nasWorkspace.canPlan()?body=>nasWorkspace.purgeActivity(body):null,locate:async target=>{
  closeDialog();
  if(target.type==='configuration'||target.type==='quotation'){
   const row=available().find(c=>c.id===target.id);if(!row)return toast('当前列表找不到这套配置，可打开回收站核对。');
   $('#search').value='';$('#link-category-filter').value='';listPinnedProduct=row.productId;await activate(row.id);
   if(active!==row.id)return;
   if(target.type==='quotation')return openNasQuotation(row.id);
   return $('#locate-editing')?.click();
  }
  if(target.type==='source'){
   await openNasSources({focusSourceId:target.id});
  }else if(target.type==='component'){
   openNasCosts(target.goodsId);
  }else if(target.type==='price-changes'){
   await showPriceChanges();
  }else if(target.type==='gallery'){
   await openNasGallery();const row=catalogRow('gallery',target.id)?.document,input=$('#gallery-search');
   if(input&&row){input.value=row.name;input.dispatchEvent(new Event('input'));[...$$('[data-gallery-open]')].find(b=>b.dataset.galleryOpen===target.id)?.click();}
  }else if(target.type==='template')await openTemplates();
  else if(target.type==='settings')await openShopSettings();
 }});
}
async function saveNasSettings(fields,expected=nasWorkspace.settingsVersion()){
 const result=await startNasPlan('settings',[{id:activeShopId,action:'replace',expected_version:expected,fields}],{title:'保存'+currentShop().shortName+'店铺设置'});
 if(!result)throw Error('已取消。');
 return result;
}

let addonPackDrafts;
function currentAddonDrafts(){
 return addonPackDrafts??=createAddonPackDrafts(localStorage,nasWorkspace.serverDisplayScope());
}
function refreshAddonDrafts(){
 syncNasControls();continuousWorkbench?.draw();schedulePreview();
}
function discardAddonDrafts(ids){
 if(!nasMain||nasBusy)throw Error('请等待工作台保存结束后再放弃草稿。');
 const drafts=currentAddonDrafts();
 // 重置正在显示的编辑对象，防止它继续写回已经放弃的值。
 let failed=false;
 for(const id of ids){
  if(!drafts.has(id))continue;
  if(!drafts.delete(id)){failed=true;continue;}
  for(const [key,selected] of selectedAddonPacks)
   if(selected===id&&!savedAddonPacks(activeShopId).some(pack=>pack.id===id))selectedAddonPacks.delete(key);
 }
 if(tab==='addon-packs')renderAddonPage(current());
 refreshAddonDrafts();
 if(failed)throw Error('部分草稿无法从本机移除，请重试。');
}
async function locateAddonPack(pack){
 const target=ordinaryAvailable().find(config=>config.productId===pack.productId),shop=activeShopId;
 if(!target)return toast('链接已无在用配置');
 closeDialog();
 if(current()?.productId!==pack.productId)await activate(target.id);
 if(shop===activeShopId&&current()?.productId===pack.productId){
  selectedAddonPacks.set(pack.productId,pack.id);switchTab('addon-packs');
 }
}
const selectedAddonPacks=new Map();
let addonPageGeneration=0,unmountAddonPage;
const savedAddonPacks=shopId=>state?.shopSettings?.[shopId]?.addonPacks??[];
let addonPackInputCache;
function currentAddonInputs(){
 const source=state.sourceCatalog,costs=state.costSource;
 if(!addonPackInputCache||addonPackInputCache.shop!==activeShopId||addonPackInputCache.source!==source||addonPackInputCache.costs!==costs)
  addonPackInputCache={shop:activeShopId,source,costs,inputs:addonPackInputs(currentCatalog(),costs||[])};
 return addonPackInputCache.inputs;
}
function matchingAddonText(config,includeDrafts){
 const saved=savedAddonPacks(config.shopId);
 const drafts=includeDrafts&&nasMain&&nasWorkspace.supportsAddonPacks()?currentAddonDrafts().values():[];
 if(!saved.length&&!includeDrafts)return [];
 const plans=includeDrafts?new Map(saved.map(pack=>[pack.id,pack])):null;
 if(plans)for(const {pack} of drafts)plans.set(pack.id,pack);
 if(plans&&!plans.size)return [];
 return addonPackRows(config,plans?[...plans.values()]:saved,currentAddonInputs());
}
// 配置图渲染时临时合入链接加购文案。
function withAddonPackText(config,includeDrafts=true){
 return appendAddonPackText(config,matchingAddonText(config,includeDrafts));
}
function appendAddonPackText(config,packs){
 const rows=packs.filter(row=>row.text).map(({id,mode,text})=>({id,mode,text}));
 if(!rows.length)return config;
 const projected={...config,posterAddonPacks:rows};
 // 旧配置缺少加购模块时为本次显示补上，保留用户明确设置的隐藏状态。
 if(!posterModules(config).some(module=>module.type==='addons')){
  projected.modules=clone(config.modules||[]);
  setPosterExtraVisible(projected,'addons',true);
 }
 return projected;
}

function configurationBenefits(config){
 if(!nasWorkspace?.supportsAddonPacks())return [];
 return posterModules(config).some(module=>module.type==='benefits'&&module.visible)
  ?posterExtraRows(config,'benefits').map(row=>[row.text?.trim(),row.note?.trim()].filter(Boolean).join('　')).filter(Boolean):[];
}
async function renderAddonPage(config){
 const host=$('#link-addon-editor'),generation=++addonPageGeneration;
 unmountAddonPage?.();unmountAddonPage=null;
 host.hidden=!config;
 if(!config){host.replaceChildren();return;}
 const id=config.id;
 const isDirty=()=>nasStageFailures.has(id)||nasWorkspace.drafts().some(row=>row.id===id);
 const saveConfigCopy=async()=>{
  if(nasBusy||!nasWorkspace.canWrite())return;
  const row=nasWorkspace.drafts().find(row=>row.id===id)??(nasStageFailures.has(id)?{id,name:config.name,pending:false}:null);
  if(row)await runNasDraftSaves([row]);
 };
 if(tab==='benefits'){
  const kind='benefits';
  const update=message=>changed(message,[id]);
  mountAddonBenefits(host,{config,esc,rows:posterExtraRows(config,kind),
   visible:posterModules(config).some(module=>module.type===kind&&module.visible),
   isDirty,
   onBegin:()=>checkpointConfig([id]),
   onEdit:(index,field,value)=>{editPosterExtra(config,kind,index,field,value);update('编辑福利文案');},
   onAdd:()=>{checkpointConfig([id]);addPosterExtra(config,kind);update('添加福利点');renderEditor();[...host.querySelectorAll('[data-extra-field="text"]')].at(-1)?.focus();},
   onRemove:index=>{checkpointConfig([id]);removePosterExtra(config,kind,index);update('移除福利点');renderEditor();host.querySelector('[data-add-extra]')?.focus();},
   onVisible:visible=>{checkpointConfig([id]);setPosterExtraVisible(config,kind,visible);update('切换福利点显示');},
   onSave:saveConfigCopy});
  return;
 }
 const product=currentProduct();
 if(!product){host.replaceChildren();return;}
 host.innerHTML='<p class="pack-empty" role="status">正在载入链接配置…</p>';
 try{
  const shop=activeShopId;
  await loadNasScope(product.configs.map(config=>config.id));
  if(generation!==addonPageGeneration||shop!==activeShopId||active!==config.id||tab!=='addon-packs')return;
  const loaded=new Map(state.configs.filter(config=>config.shopId===shop&&!config.deletedAt).map(config=>[config.id,config]));
  const configs=product.configs.map(({id})=>loaded.get(id)).filter(Boolean);
  const target=loaded.get(id);
  if(!target||!configs.length)throw Error('当前链接没有可用的配置。');
  // 仅文案继续走当前配置的保存与撤销，链接级方案使用独立的店铺设置。
  const configCopy={rows:()=>posterAddonCopyRows(target),isDirty,onBegin:()=>checkpointConfig([id]),
   onAdd:()=>{const index=addPosterExtra(target,'addons');changed('添加配置图加购文案',[id]);return index;},
   onEdit:(index,field,value)=>{editPosterExtra(target,'addons',index,field,value);changed('编辑配置图加购文案',[id]);},
   onRemove:index=>{removePosterAddonCopy(target,index);changed('移除配置图加购文案',[id]);},
   onSave:saveConfigCopy};
  unmountAddonPage=mountAddonPackEditor(host,{openDialog,closeDialog,product,configs,esc,inputs:currentAddonInputs(),drafts:currentAddonDrafts(),currentId:active,activate,
   configCopy,
   initialId:selectedAddonPacks.get(product.id),selected:id=>selectedAddonPacks.set(product.id,id),
   saved:()=>savedAddonPacks(shop),productName:id=>ordinaryAvailable().find(config=>config.productId===id)?.product||'已归档链接',
   save:async(change,base)=>{
    // 先核对同一方案的原始内容，再由 NAS 设置版本兜住读写间的并发变更。
    const {metadata}=await readNasIndex();
    const remote=metadata.shopSettings[shop]?.addonPacks?.find(pack=>pack.id===change.id)??null;
    if(!sameNasDocument(remote,base))
     throw Error('这份加购包已被更新。可放弃本机草稿并载入已保存版本。');
    await saveNasSettings({addonPackChange:change},metadata.settingsVersion);
   },
   refresh:refreshAddonDrafts,errorText:nasErrorText});
 }catch(error){if(generation===addonPageGeneration)host.innerHTML=`<p class="pack-empty" role="status">${esc(nasErrorText(error))}</p>`;}
}
async function openAddonPackOverview(){
 const shop=activeShopId,packs=()=>mergeAddonPackDrafts(savedAddonPacks(shop),currentAddonDrafts());
 const ids=new Set(packs().map(pack=>pack.productId));
 try{
  const configs=ordinaryAvailable().filter(config=>ids.has(config.productId));
  await loadNasScope(configs.map(config=>config.id));
  if(shop!==activeShopId)return;
  openAddonPackMaintenance({openDialog,esc,packs,inputs:currentAddonInputs(),
   configs:state.configs.filter(config=>config.shopId===shop&&!config.deletedAt&&ids.has(config.productId)),
   edit:pack=>locateAddonPack(pack).catch(error=>toast(nasErrorText(error))),
   discard:id=>{try{discardAddonDrafts([id]);}catch(error){toast(nasErrorText(error));}}});
 }catch(error){toast(nasErrorText(error));}
}
async function openNasQuotation(id=active){
 if(activeShopId!=='intel')return toast('当前店铺尚未配置维护表对外报价。');
 if(!id)return toast('请先选择英特尔配置。');
 try{
  const info=await nasWorkspace.quotation(id);
  if(active!==id)return;
  openDialog('维护表报价与销售可见状态',`<p>SPU ${esc(info.spu||'缺失')} · SKU ${esc(info.sku_id||'缺失')}</p>
   <p>${info.amount_cents===null?'未确认维护表价':`已确认到手价 ¥${money(Number(info.amount_cents)/100)}`} · ${info.published?'已向销售发布':'未向销售发布'}</p>
   <p class="hint">工作台定价、成本和利润均不用于销售报价。重新确认维护表价格以后，需要再次明确发布。</p><div class="actions">
   <button id="nas-quotation-import">从维护表读取</button><button id="nas-quotation-publish" class="primary"
    ${!info.published&&(info.amount_cents===null||!info.spu||!info.sku_id)?'disabled':''}>${info.published?'撤回销售发布':'发布给销售'}</button></div>`);
  $('#nas-quotation-import').onclick=()=>openNasWorkbookQuotes([id]);
  const button=$('#nas-quotation-publish');
  button.onclick=async()=>{
   if(nasWorkspace.drafts().some(row=>row.id===id))return toast('请先保存或放弃当前配置的本机草稿。');
   if(!confirm(info.published?'确认撤回该配置的销售发布？':'确认将当前配置和已确认维护表价发布给授权销售？'))return;
   button.disabled=true;
   try{await startNasPlan('quotations',[{id,action:info.published?'withdraw':'publish',expected_version:info.version}],{title:info.published?'撤回销售发布':'发布选定维护表报价'});if(button.isConnected)await openNasQuotation(id);}
   catch(error){toast(nasErrorText(error));}finally{button.disabled=false;}
  };
 }catch(error){toast(nasErrorText(error));}
}
async function openNasWorkbookQuotes(only=null){
 let index;
 try{index=(await readNasIndex()).summaries;}catch(error){toast(nasErrorText(error));return;}
 const requested=new Set(only||index.map(row=>row.id));
 const scope=index.filter(row=>requested.has(row.id));
 const identities=new Map();
 for(const row of index)if(row.spu&&row.skuId){
  const key=JSON.stringify([row.spu,row.skuId]),list=identities.get(key)||[];list.push(row);identities.set(key,list);
 }
 openDialog('核对维护表报价',`<p class="hint">只读 XLSB「综合表」INTEL 行，按文本 SPU/SKU 核对 H 列已保存到手价。本次核对 ${scope.length} 套配置。未匹配、重复或空价保持原样。提交后不会自动向销售发布。</p>
  <div class="actions"><button id="nas-quote-file">选择维护表</button></div><p id="nas-quote-message" role="status"></p>
  <div id="nas-quote-preview"></div><div class="actions"><button id="nas-quote-apply" class="primary" disabled>确认选定维护表价格</button></div>`);
 const input=$('#nas-quote-file'),button=$('#nas-quote-apply'),status=$('#nas-quote-message'),preview=$('#nas-quote-preview');
 let plan=null,busy=false;
 input.onclick=async()=>{
  if(busy)return;busy=true;input.disabled=true;button.disabled=true;plan=null;preview.textContent='';
  try{
   const data=await nasWorkspace.readErp('quote-file',[]);
   if(!button.isConnected||data.cancelled)return;
   if(!Array.isArray(data.rows)||!/^([a-f0-9]{64})$/.test(data.workbook_sha256||''))throw Error('维护表读取结果不完整。');
   const exact=new Map();
   for(const row of data.rows){
    const key=JSON.stringify([row.spu,row.sku]),list=exact.get(key)||[];
    list.push(row);exact.set(key,list);
   }
   const drafts=new Set(nasWorkspace.drafts().map(row=>row.id));
   const matches=[];
   for(const item of scope){
    const key=JSON.stringify([item.spu,item.skuId]),rows=exact.get(key);
    if(!item.nasVersion||identities.get(key)?.length!==1||rows?.length!==1||rows[0].amount_cents===null||drafts.has(item.id))continue;
    const row=rows[0];
    matches.push({id:item.id,action:'select_workbook',expected_version:item.nasVersion,spu:row.spu,sku:row.sku,
     amount_cents:row.amount_cents,workbook_row:row.workbook_row,workbook_sha256:data.workbook_sha256});
   }
   plan=matches;
   status.textContent=`唯一匹配 ${matches.length} 套；其余 ${scope.length-matches.length} 套（含未保存草稿）保留原报价。`;
   if(data.invalidCount)status.textContent+=` 工作簿另有 ${data.invalidCount} 行平台码无法精确识别。`;
   preview.innerHTML=matches.slice(0,30).map(row=>`<div class="list-card"><span>SPU ${esc(row.spu)} · SKU ${esc(row.sku)}</span><strong>¥${money(Number(row.amount_cents)/100)} · 第 ${row.workbook_row} 行</strong></div>`).join('');
   button.disabled=!matches.length;
  }catch(error){if(button.isConnected)status.textContent=nasErrorText(error);}
  finally{busy=false;input.disabled=false;}
 };
 button.onclick=async()=>{
  if(!plan?.length||busy)return;busy=true;button.disabled=true;input.disabled=true;
  try{
   const outcome=await startNasPlan('quotations',plan,{title:'选定维护表报价'});
   if(outcome&&button.isConnected){status.textContent=`已确认 ${nasApplied(outcome).length} 套维护表到手价；未自动发布。`;plan=null;}
  }catch(error){if(button.isConnected)status.textContent=nasErrorText(error);}
  finally{busy=false;button.disabled=!plan;input.disabled=false;}
 };
}
async function openNasPlanStatus(){
 try{
  const queue=nasWorkspace.queue(),plan=await queue.read();
  if(!plan)return refreshNasPlanButton();
  const unknown=plan.batches.some(batch=>batch.status==='unknown'),rejected=plan.batches.some(batch=>batch.status==='rejected');
  openDialog('NAS 批量操作',`<p class="hint">${esc(plan.title)}：已确认 ${nasApplied(plan).length} / ${plan.total} 项。</p>
   <p>${unknown?'后续批次尚未发送。可只查询回执，或确认后按原编号重试当前一批。':rejected?'本次操作有一批未通过，已确认批次已保存。请刷新、重新核对后再新建计划。':'可主动继续尚未发送的批次。'}</p>
   <div class="actions">${unknown?'<button id="nas-plan-receipt" class="primary">查询原回执</button><button id="nas-plan-retry">重试原批次</button>':
    `${rejected?'':'<button id="nas-plan-continue" class="primary">继续未提交批次</button>'}<button id="nas-plan-clear">结束计划</button>`}</div>`);
  for(const [id,action] of [['nas-plan-receipt','receipt'],['nas-plan-retry','retry'],['nas-plan-continue','submit']]){
   const button=$('#'+id);if(!button)continue;
   button.onclick=async()=>{
    if(action==='retry'&&!confirm('确认重试原批次？只使用原编号和原内容，后续批次不会自动发送。'))return;
    button.disabled=true;try{await runNasQueue(action);if(await queue.read())await openNasPlanStatus();else closeDialog();}
    catch(error){toast(nasErrorText(error));if(error.code==='VERSION_CONFLICT'&&action==='retry')await openNasPlanStatus();else button.disabled=false;}
   };
  }
  const clear=$('#nas-plan-clear');
  if(clear)clear.onclick=async()=>{try{
   const latest=await queue.read();
   if(latest)await acceptNasArchivedDrafts(latest);
   await queue.clear();
   await registerNasPartUndo(latest);
   syncNasControls();closeDialog();await refreshNasPlanButton();
  }catch(error){toast(nasErrorText(error));}};
 }catch(error){toast(nasErrorText(error));}
}
async function commitNasConfigs(rows,{sourceSync=false,...options}={}){
 if(!rows.length)return null;
 const changes=await nasWorkspace.configurationChanges(rows,{sourceSync});
 if(sourceSync)for(const {id} of rows)if(nasStageFailures.has(id))throw nasStageFailures.get(id);
 return startNasPlan('configurations',changes,options);
}
function nasNewDocument(config,order){
 const row=clone(config);
 row.workspaceOrder=order;row.skuId='';
 delete row.deletedAt;delete row.deletionSessionId;delete row.quotation;delete row.published;delete row.final_price_cents;
 for(const key of ['parts','actualParts'])row[key]=(row[key]||[]).map(part=>({...part,lineId:part.lineId||crypto.randomUUID(),name:part.name||'',goodsId:part.goodsId||'',qty:part.qty??1}));
 row.addons=(row.addons||[]).map(addon=>({...addon,items:addon.items??(addon.goodsId?[{goodsId:addon.goodsId,qty:addon.qty??1}]:[])}));
 return row;
}
async function openNasLegacyImport(){
 openDialog('导入旧工作台配置',`<p class="hint">只将备份中明确属于当前店铺、未删除的配置导入为新链接。原链接、其他店铺、款号、报价和旧同步记录保持原样。引用的图片须已在 NAS 登记。</p>
  <label class="field">旧工作台 JSON 备份<input id="nas-import-file" type="file" accept=".json,application/json"></label>
  <div id="nas-import-preview" aria-live="polite"></div><div class="actions"><button id="nas-import-download">导出当前店铺配置</button>
  <button id="nas-import-apply" class="primary" disabled>导入通过核对的配置</button></div>`);
 const input=$('#nas-import-file'),button=$('#nas-import-apply'),status=$('#nas-import-preview');
 let selectedRows=null,generation=0;
 input.onchange=async()=>{
  const token=++generation,file=input.files[0];selectedRows=null;button.disabled=true;status.textContent='';
  if(!file)return;
  try{
   if(file.size>80*1024*1024)throw Error('文件超过 80 MiB，请先拆分旧备份。');
   const result=prepareLegacyNasImport(await file.text(),{shopId:activeShopId}),found=new Set();
   for(let i=0;i<result.images.length;i+=1000){
    const check=await nasWorkspace.checkImportImages(result.images.slice(i,i+1000));
    if(!Array.isArray(check?.found))throw Error('不能确认 NAS 图片登记结果。');
    check.found.forEach(path=>found.add(path));
   }
   if(token!==generation||!button.isConnected)return;
   const sources=new Set(currentCatalog().map(row=>row.sourceId));
   const refs=row=>[...row.parts,...row.actualParts,...row.addons.filter(addon=>addon.followPolicy==='follow')].some(part=>part.sourceId&&!sources.has(part.sourceId));
   for(const row of result.valid){
    if(row.images.some(path=>!found.has(path)))result.invalid.push({name:row.document.name,reason:'有图片尚未在 NAS 登记'});
    else if(refs(row.document))result.invalid.push({name:row.document.name,reason:'关联输出源尚未导入或已回收'});
   }
   selectedRows=result.valid.filter(row=>row.images.every(path=>found.has(path))&&!refs(row.document)).map(row=>row.document);
   const errors=result.invalid.slice(0,30).map(row=>`<li>${esc(row.name)}：${esc(row.reason)}</li>`).join('');
   status.innerHTML=`<p>可导入 ${selectedRows.length} 套，因缺字段或依赖跳过 ${result.invalid.length} 套，忽略其他店铺或已删除 ${result.ignored} 套。</p>${errors?`<ul>${errors}</ul>`:''}`;
   button.disabled=!selectedRows.length;
  }catch(error){if(token===generation&&button.isConnected)status.textContent=nasErrorText(error);}
 };
 button.onclick=async()=>{
  if(!selectedRows?.length)return;button.disabled=true;
  try{if(await createNasConfigs(selectedRows,'旧备份导入'+currentShop().shortName+'配置'))closeDialog();}
  catch(error){toast(nasErrorText(error));}finally{button.disabled=false;}
 };
 $('#nas-import-download').onclick=async()=>{
  try{
   const ids=available().map(c=>c.id);await loadNasScope(ids);
   const configs=ids.map(id=>nasWorkspace.documentFor(state.configs.find(c=>c.id===id)));
   downloadBlob(new Blob([JSON.stringify({format:'diy-'+activeShopId+'-nas-configs-v1',configs})],{type:'application/json'}),currentShop().shortName+'NAS配置_'+new Date().toISOString().slice(0,10)+'.json');
  }catch(error){toast(nasErrorText(error));}
 };
}
// 本地与测试入口共用既有标准商品弹窗和保存编排，名称映射只由领域模块维护。
function openLocalStandardProduct(){
 openStandardProduct({openDialog,closeDialog,toast,esc,product:currentProduct,shop:currentShop,state:()=>state,request,flush:save,download:downloadBlob,
  apply:async(plan,p)=>{
   if(currentProduct()?.id!==p.id||activeShopId!==p.shopId)throw Error('当前链接已变化，请重新打开商品同步');
   const result=applyStandardProduct(plan,state,p);checkpoint();state=result.next;rememberDisplayParts();
   changed(`导入标准商品：更新 ${plan.updated} 套，新增 ${plan.added} 套`,result.ids);renderAll();await save();
  }
 });
}
async function openNasStandardProduct(){
 const product=currentProduct();
 if(!product)return toast('请先选择本店商品链接。');
 try{
  await loadNasScope(product.configs.map(c=>c.id));
  if(currentProduct()?.id!==product.id)return;
  openStandardProduct({nas:true,openDialog,closeDialog,toast,esc,product:currentProduct,shop:currentShop,state:()=>state,request,flush:save,download:downloadBlob,
   apply:async(plan,p)=>{
    if(currentProduct()?.id!==p.id)throw Error('当前链接已变化，请重新打开。');
    const result=applyStandardProduct(plan,state,p),existing=new Set(p.configs.map(c=>c.id));
    const rows=result.ids.map(id=>{
     const c=result.next.configs.find(row=>row.id===id),wasPresent=existing.has(id);
     // 标准商品明确核对同一 SPU 和 SKU，除此之外的复制导入一律清 SKU。
     const document=wasPresent?c:{...nasNewDocument(c,c.workspaceOrder),skuId:c.skuId};
     return {id,action:wasPresent?'replace':'create',document};
    });
    if(!await commitNasConfigs(rows,{title:'应用标准商品 JSON',group:nasGroup(p),selectId:active}))throw Error('已取消。');
   }
  });
 }catch(error){toast(nasErrorText(error));}
}
async function createNasConfigs(configs,title,group=null,afterId=null){
 const max=Math.max(0,...available().map(c=>Number(c.workspaceOrder)||0));
 let changes=configs.map((config,i)=>({id:config.id,action:'create',document:nasNewDocument(config,max+100*(i+1))}));
 if(afterId){const product=productGroups(available()).find(group=>group.configs.some(row=>row.id===afterId)),index=product?.configs.findIndex(c=>c.id===afterId),before=Number(product.configs[index]?.workspaceOrder),after=Number(product.configs[index+1]?.workspaceOrder);
  const order=index<0?NaN:product.configs[index+1]?(before+after)/2:before+100;
  if(!Number.isFinite(order)||order<=before||(product.configs[index+1]&&order>=after))throw Error('配置排序间隔不足，请先调整配置顺序');
  changes[0].document.workspaceOrder=order;}
 return commitNasConfigs(changes,{title,group,selectId:configs[0].id});
}
async function updateNasProduct(product,fields,title){
 const ids=product.configs.map(c=>c.id);
 await loadNasScope(ids);
 const rows=ids.map(id=>({id,action:'replace',document:{...clone(state.configs.find(c=>c.id===id)),...fields}}));
 return commitNasConfigs(rows,{title,group:nasGroup(product),selectId:active});
}
async function replaceNasFields(fields,title,group=null){
 const ids=[...new Set(fields.map(row=>row.id))];
 await loadNasScope(ids);
 const docs=new Map(state.configs.filter(c=>ids.includes(c.id)).map(c=>[c.id,clone(c)]));
 for(const row of fields)Object.assign(docs.get(row.id),row.fields);
 return commitNasConfigs(ids.map(id=>({id,action:'replace',document:docs.get(id)})),{title,group});
}
async function moveNasConfig(from,to,after){
 if(!nasWorkspace.canPlan())return;
 const view=available(),row=view.find(c=>c.id===from),product=productGroups(view).find(c=>c.id===row?.productId);
 const moved=moveConfig(view,from,to,after);
 if(!product||!moved)return;
 try{
  // 只重新安排本链接的排序值，不改变其他链接在列表中的位置。
  const baseline=product.configs.map(c=>Number(c.workspaceOrder));
  const usable=baseline.every((v,i)=>Number.isFinite(v)&&(!i||v>baseline[i-1])),start=Number.isFinite(baseline[0])?baseline[0]:0;
  const fields=moved.filter(c=>c.productId===product.id).map((c,i)=>({id:c.id,fields:{workspaceOrder:usable?baseline[i]:start+i/1000}}));
  await replaceNasFields(fields,'调整商品链接内配置顺序',nasGroup(product));
 }catch(error){toast(nasErrorText(error));}
}
async function addNasToProduct(product,special=false,afterId=null){
 try{
  if(product.installment===null)return toast('请先统一本链接的分期设置。');
  const linkRows=await loadShopRateRows(activeShopId,product.id);
  const c=blankConfig(current(),{...product,configs:linkRows},special?'颜值升级包':'配置'+(product.configs.length+1),defaultServiceText(state,activeShopId));
  c.overviewFeeRate=commonOverviewFeeRate(linkRows.length?linkRows:await loadShopRateRows(activeShopId)).rate;
  if(special){
   c.version='';c.footer='';c.posterFields={name:true,version:false,subtitle:false};
   c.modules=modulesDefault(c.shopId,c.theme).map(m=>({...m,visible:m.type==='header'}));
   c.modules.push({id:crypto.randomUUID(),type:'custom',title:'颜值升级包',text:'点击预览文字编辑内容',visible:true,size:22,weight:600,gap:16});
  }
  await createNasConfigs([c],special?'新增升级展示页':'新增链接配置',nasGroup(product),afterId);
 }catch(error){toast(nasErrorText(error));}
}
// 链接卡片「创建副本」：整条链接复制到草稿区，不沿用平台 SPU、SKU 或网址。
async function duplicateLinkToDraft(group){
 const shopId=activeShopId,ids=group.configs.map(c=>c.id),productId=crypto.randomUUID();
 if(nasMain&&!nasWorkspace.canPlan())return toast('当前 NAS 服务未开放商品维护。');
 const reveal=firstId=>{selectZone('draft');collapsedZones.delete('draft');collapsedProducts.delete(productId);searchCollapse.products.delete(productId);if(firstId){active=firstId;selected=new Set([firstId]);}};
 if(nasMain){
  try{
   if(ids.some(id=>nasWorkspace.pending(id)))return toast('请先确认该链接内未核实的提交。');
   await loadNasScope(ids);
   const rows=duplicateLinkConfigs(ids.map(id=>nasWorkspace.documentFor(state.configs.find(c=>c.id===id))),{productId});
   if(!rows.length)return;
   if(!await createNasConfigs(rows,'创建链接副本'))return;
   reveal(null);renderList();toast(`已创建副本「${rows[0].product}」，放在草稿区。`);
  }catch(error){toast(nasErrorText(error));}
  return;
 }
 try{await fullAction(()=>{
  if(activeShopId!==shopId)throw Error('店铺已切换，请重试');
  const sources=state.configs.filter(c=>c.shopId===shopId&&!c.deletedAt&&ids.includes(c.id));
  if(sources.length!==ids.length)throw Error('链接范围已变化，请重试');
  const capacityError=configCapacityMessage(state.configs,shopId,sources.length);if(capacityError)return toast(capacityError);
  const rows=duplicateLinkConfigs(sources,{productId});
  checkpoint();state.configs.push(...rows);reveal(rows[0].id);
  changed('创建链接副本',rows.map(c=>c.id));renderAll();
  toast(`已创建副本「${rows[0].product}」，放在草稿区。`);
 })();}catch{}
}
// 拖动链接卡片：同区上下移动，或拖进另一区（草稿区 / 链接区）。
async function moveLinkTo(fromId,{toId,after,zone}){
 const draft=zone==='draft',list=$('#config-list'),keep=list.scrollTop;
 const groups=productGroups(ordinaryConfigs(available())),source=groups.find(g=>g.id===fromId);
 if(!source)return;
 const isDraft=g=>g.configs.some(c=>c.productDraft),zoneChanged=isDraft(source)!==draft;
 if(!toId){const first=groups.find(g=>g.id!==fromId&&isDraft(g)===draft);if(first){toId=first.id;after=false;}}
 const label=zoneChanged?(draft?'移到草稿区':'移回链接区'):'调整链接顺序';
 if(nasMain){
  if(!nasWorkspace.canPlan())return toast('当前 NAS 服务未开放商品维护，不能调整链接顺序。');
  try{
   const values=linkOrderValues(groups,fromId,toId,after);
   if(!values&&!zoneChanged)return;
   const fields=source.configs.map((c,i)=>({id:c.id,fields:{...(values?{workspaceOrder:values[i]}:{}),...(zoneChanged?{productDraft:draft}:{})}}));
   await replaceNasFields(fields,label,nasGroup(source));
  }catch(error){toast(nasErrorText(error));}
  return;
 }
 try{await fullAction(()=>{
  const next=moveLink(state.configs,{shopId:activeShopId,fromId,toId,after,draft});
  if(!next)return;
  checkpoint();state.configs=next;
  if(zoneChanged)changed(label,source.configs.map(c=>c.id),false,null,true);else changed(label,[],true);
  renderList();list.scrollTop=keep;
  if(zoneChanged)toast(source.name+' 已'+label);
 })();}catch{}
}
async function duplicateNasConfig(id=current()?.id){
 const c=state.configs.find(row=>row.id===id&&!row.deletedAt);if(!c)return;
 if(nasWorkspace.pending(c.id))return toast('请先确认这套配置的提交结果。');
 const copy=nasWorkspace.documentFor(c);
 copy.id=crypto.randomUUID();copy.name+=' · 副本';
 try{await createNasConfigs([copy],'复制配置',null,c.id);}catch(error){toast(nasErrorText(error));}
}
async function archiveNasConfigs(ids,product=null,{selectAfterRemoval=false}={}){
 const wanted=[...new Set(ids)].filter(id=>available().some(c=>c.id===id));
 if(!wanted.length||!confirm(`将 ${wanted.length} 套配置移入 NAS 回收站？所选配置的未保存改动将丢弃，已发布配置会撤下。回收站保留 7 天，恢复后不会自动发布给销售。`))return;
 try{
  await loadNasScope(wanted);
  // 行内删除根据明确点击的配置预先确定邻项，不依赖异步焦点是否已切换完成。
  const selectId=selectAfterRemoval?configAfterRemoval(available(),wanted[0],wanted):null;
  const result=await commitNasConfigs(wanted.map(id=>({id,action:'archive'})),{title:'配置移入回收站',group:product?nasGroup(product):null,selectId});
  if(wanted.length===1&&result){const saved=nasApplied(result).find(row=>row.configuration_id===wanted[0]);if(saved){history.push({historyScope:'nas-archive',id:wanted[0],action:'restore',version:saved.version});redoHistory=[];syncHistoryButtons();toast('已移入回收站，可按 Ctrl+Z 恢复');}}
 }catch(error){toast(nasErrorText(error));}
}
async function readNasTemplateConfigs(product){
 for(const row of product.configs)await loadDetail(row.id);
 if(currentProduct()?.id!==product.id)throw Error('当前链接已变化，请重新打开模板。');
 // 取完整快照，不提交还未保存的正式配置本身。
 return product.configs.map(row=>nasWorkspace.documentFor(state.configs.find(c=>c.id===row.id)));
}
async function openNasSaveProductTemplate(){
 const product=currentProduct();
 if(!product||!nasWorkspace.canManage())return toast('当前账号不能保存这套 NAS 模板。');
 try{
  await loadNasCatalog('templates');
  const configs=await readNasTemplateConfigs(product);
  let trial=null,busy=false;
  openDialog('整组存为模板','');
  if(!reactWorkbench.dialog($('#dialog-body'),'template-save',{name:product.name,count:configs.length}))
   openDialog('整组存为模板',`<p>保存当前链接下 ${configs.length} 套配置的快照。</p><label class="field">模板名称<input id="template-name" value="${esc(product.name)}"></label><button id="template-save" class="primary">保存整组模板</button>`);
  $('#template-save').onclick=async()=>{
   if(busy)return;
   const name=$('#template-name').value.trim();if(!name)return toast('请输入模板名称');
   if(trial&&trial.name!==name)trial={...trial,name};else if(!trial)trial=productTemplate(configs,name);
   busy=true;const button=$('#template-save');button.disabled=true;
   try{await saveNasCatalog('templates',trial.id,'create',trial);closeDialog();openHostTemplate('saved',trial.id);toast('已保存到主机模板');}
   catch(error){toast(nasErrorText(error));}
   finally{busy=false;button.disabled=false;}
  };
 }catch(error){toast(nasErrorText(error));}
}
async function saveNasCatalog(kind,id,action,document=null,other={}){
 const row=catalogRow(kind,id);
 let result;
 try{result=await nasWorkspace.catalog().save(kind,id,action,{
  ...(action==='create'?{}:{expected_version:row?.version}),...(document?{document}:{}),...other
 });scheduleNasDataTime();}finally{syncNasControls();}
 if(action!=='apply'&&kind!=='assets'){
  const previous=action==='copy'||action==='create'?{owner_shop:activeShopId,shared:false,editable:true}:row;
  const next=catalogRows(kind).filter(item=>item.id!==result.resource_id);
  if(action!=='purge')next.push({...previous,id:result.resource_id,version:result.version,document:result.document});
  applyNasCatalog(kind,next);
 }
 return result;
}
const formatNasCatalogError=error=>Object.assign(Error(nasErrorText(error)),{code:error?.code});
function showNasCatalogReceipts(){
 const manager=nasWorkspace.catalog(),pending=manager.pending();
 openDialog('核对 NAS 目录保存结果',`<p class="hint">查询不会提交资料。重试会先查回执，仍未查到时用原编号和原内容提交。</p><div>
  ${pending.length?pending.map((row,i)=>`<div class="list-card"><span>${esc({sources:'输出源',addons:'共享加购',templates:'模板',gallery:'机箱图库',assets:'图片'}[row.kind]||'目录资料')}</span>
  <button data-nas-catalog-receipt="${i}">查询原回执</button>
  ${row.kind==='assets'?'<label>重试上传时选择原文件<input type="file" accept="image/png,image/jpeg"></label>':''}
  <button data-nas-catalog-retry="${i}">重试原提交</button><small data-catalog-result></small></div>`).join(''):'<p>没有待查询的目录保存。</p>'}</div>`);
 for(const button of $$('[data-nas-catalog-receipt],[data-nas-catalog-retry]'))button.onclick=async()=>{
  const retry=button.hasAttribute('data-nas-catalog-retry');
  if(retry&&!confirm('确认重试原提交？只使用原编号和原内容。'))return;
  const operation=pending[Number(button.dataset.nasCatalogReceipt??button.dataset.nasCatalogRetry)];
  const row=button.parentElement,controls=[...row.querySelectorAll('button,input')];
  controls.forEach(input=>input.disabled=true);
  const label=row.querySelector('[data-catalog-result]');
  try{
   if(retry)await manager.retry(operation,row.querySelector('input')?.files?.[0]);
   else await manager.receipt(operation);
   scheduleNasDataTime();
   label.textContent=operation.kind==='assets'?'已确认原图上传。若图库条目尚未保存，请返回图库继续。':'已确认保存，可重新打开目录查看。';
  }catch(error){label.textContent=nasErrorText(error);controls.forEach(input=>input.disabled=false);}
  finally{syncNasControls();}
 };
}
/** 把共用事务接到原来源编辑与目录回执。按原编号核对未知结果。 */
async function openSharedSourceSession(shop){
 const client=nasWorkspace.catalog(),scopes=nasWorkspace.shops();
 const canCreate=scopes.length===3;
 let bySource,documents;
 const confirmed=new Map();
 const reload=async()=>{
  const entries=await client.list('shared-sources');
  if(!Array.isArray(entries)||entries.some(row=>row.document?.id!==row.id||typeof row.version!=='string'||
   !row.document?.stores||Object.values(row.document.stores).some(aliases=>!Array.isArray(aliases))||
   !row.document?.common))throw Error('共用输出源返回不完整。');
  // 完整授权目录用于全屏投影，旧快捷弹窗仍按当前店限制范围。
  documents=entries.map(row=>({...row.document,version:row.version}));
  bySource=new Map(documents.flatMap(row=>Object.values(row.stores).flat().map(alias=>[alias.sourceId,row])));
 };
 await reload();
 const record=row=>bySource.get(row.sourceId);
 return {record,entries:()=>documents,refresh:reload,canCreate,defaultScope:canCreate?'shared':shop,scopes:canCreate?['shared',...scopes]:scopes,
  searchNames:row=>{
   const entry=record(row);
   return entry?[entry.common.name,...Object.values(entry.stores).flatMap(aliases=>aliases.map(alias=>alias.fields.name))]:[];
  },
  dedupe:rows=>[...Map.groupBy(rows,row=>record(row)?.id??row.sourceId).values()].map(aliases=>aliases[0]),
  async save(changes){
   const sourceIds={};let count=0;
   try{
    if(await nasWorkspace.queue().read())throw Error('请先处理上一项批量操作。');
    for(const {row,managed} of changes){
     if(!managed)throw Error('这条历史来源需要先在共用目录中核对。');
     const {id,version,...fields}=managed;
     const document={id,...fields};
     const match=JSON.stringify([version,document]);
     if(confirmed.get(id)!==match){
      await client.save('shared-sources',id,version?'replace':'create',{document,...(version?{expected_version:version}:{})});
      confirmed.set(id,match);
     }
     if(!version)sourceIds[row.sourceId]='shared-src:'+id;
     count++;
    }
    await reload();
    const clean=await refreshSourceSyncDependencies(shop);
    // 草稿和在途保存同时保留原依赖、当前显示内容及其投影基线，以免下次编辑覆盖手填值。
    const costs=new Map(state.costSource.map(row=>[row.goodsId,row]));
    const sources=new Map(catalog.map(row=>[row.sourceId,row]));
    for(const config of state.configs)if(clean.has(config.id))nasWorkspace.applyPresentation(config,row=>{
     withCurrentSharedSource(row,sources,{deferText:true});visibleNasCosts(row,costs);
    });
    rememberDisplayParts([...clean]);
    renderAll();scheduleNasDataTime();
    confirmed.clear();
    return {count,sourceIds,configIds:[],autoChanges:[]};
   }catch(error){throw Error((count?`已确认 ${count} 条，其余修改仍保留。`:'')+nasErrorText(error));}
   finally{syncNasControls();}
  }};
}
async function openNasSources({storeOnly=false,focusSourceId=null,quickEdit=false}={}){
 if(window.workbenchSourceEditor?.hasPending()){window.workbenchSourceEditor.restore();return;}
 if(!quickEdit&&!storeOnly&&window.workbenchSourceEditor?.sheet){
  window.workbenchSourceEditor.restore();
  if(focusSourceId)window.workbenchSourceEditor.locate(focusSourceId);
  return;
 }
 try{
  const rows=await loadNasCatalog('sources');
  const read=()=>catalogRows('sources').filter(row=>row.document.shopId===activeShopId).map(row=>row.document);
  const shop=activeShopId;
  let sharedSources=null,previewUnavailable=false;
  if(nasWorkspace.hasSharedSources())sharedSources=await openSharedSourceSession(shop);
  else if(!storeOnly&&nasWorkspace.shops().length>1){
   try{
    sharedSources=createSharedSourcePreview({shop,storage:localStorage,
     scope:nasWorkspace.sharedPreviewScope(),snapshots:await nasWorkspace.sharedPreviewSnapshot()});
   }catch{
    // 其他店铺或本机验收资料暂不可用时，本店正式目录仍可维护。
    previewUnavailable=true;
   }
  }
  if(activeShopId!==shop)return;
  // 行内修改只写当前店的输出源字段，不改三店共用值。
  if(quickEdit&&sharedSources)sharedSources={...sharedSources,defaultScope:shop,scopes:[shop]};
  const lookupProduct=nasWorkspace.canPlan()?goodsId=>lookupNasSourceProduct((kind,ids)=>{
   if(nasWorkspace.shop()!==shop)throw Error('已切换店铺，请重新打开输出源。');
   return nasWorkspace.readErp(kind,ids);
  },goodsId):undefined;
  let follow;
  await openSourceMaintenance({nas:true,focusSourceId,quickEdit,canManage:nasWorkspace.canManage(),project:projectNasEdits,lookupProduct,sharedSources,
   shopIds:storeOnly?[shop]:nasWorkspace.shops(),
   getDeletedSources:async()=>{
    const latest=await nasWorkspace.catalog().list('sources');
    if(shop!==activeShopId)throw Error('店铺已切换，请重新打开输出源。');
    if(!Array.isArray(latest)||latest.some(row=>!row.document||typeof row.version!=='string'))throw Error('NAS 输出源目录返回不完整。');
    applyNasCatalog('sources',latest);
    await sharedSources?.refresh?.();
    return latest.filter(row=>row.document.deletedAt!=null).map(row=>({...row.document,ownerShop:row.owner_shop,shared:row.shared,
     version:row.version,references:row.references,editable:row.editable}));
   },
   changeDeletedSources:sharedSources?.preview||!nasWorkspace.canManage()?null:async(targets,action,confirmed)=>{
    for(const target of targets){
     if(shop!==activeShopId)throw Error('店铺已切换，剩余操作已停止。');
     try{await saveNasCatalog('sources',target.sourceId,action,null,{expected_version:target.version});}
     catch(error){
      if(error.code==='CATALOG_IN_USE'&&deletedSourceUses(error.details)!==null)throw Error('仍被 '+error.details.configurations+' 套配置、'+error.details.templates+' 个模板引用。');
      throw formatNasCatalogError(error);
     }
     confirmed(target);
    }
   },
   erpSearch:nasWorkspace.canManage()&&nasWorkspace.canPlan()&&nasWorkspace.hasSharedSources()?findErpCandidates:null,
   readTaxCurrent:readSourceSheetTax,adoptErp:!sharedSources?.preview&&nasWorkspace.hasSharedSources()?adoptSourceSheetErp:null,
   getSheetRows:sharedSources?.preview?sharedSources.rows:()=>catalogRows('sources').map(row=>row.document),
   openStoreOnly:sharedSources?.preview?()=>openNasSources({storeOnly:true}):null,
   canEdit:row=>nasWorkspace.canManage()&&(sharedSources?row.deletedAt!=null?catalogRow('sources',row.sourceId)?.editable===true:!!sharedSources.record(row)||sharedSources.canCreate&&!rows.some(x=>x.id===row.sourceId):
    catalogRow('sources',row.sourceId)?.editable??!rows.some(x=>x.id===row.sourceId)),
   openDialog,render:(container,model)=>reactWorkbench.dialog(container,'source-editor',model),
   renderDetail:(container,model)=>reactWorkbench.dialog(container,'source-editor-detail',model),release:container=>reactWorkbench.release(container),
   flush:async()=>{await save();await refreshSourceSyncDependencies(shop);await loadNasScope(ordinaryAvailable().map(c=>c.id));},
   errorText:error=>nasErrorText(error,listConfigs()),getCosts:()=>state.costSource,getRows:sharedSources?.preview?sharedSources.rows:read,getAllRows:sharedSources?.preview?sharedSources.rows:read,shopId:()=>activeShopId,download:downloadBlob,
   getConfigs:ordinaryAvailable,currentProductId:()=>current()?.productId,selectedIds:()=>[...selected],
   updateLinkCosts:sharedSources?.preview?null:async anchorId=>{
    const product=productGroups(ordinaryAvailable()).find(group=>group.configs.some(c=>c.id===anchorId));
    if(!product)throw Error('链接已变化，请重新打开输出源。');
    await loadNasScope(product.configs.map(c=>c.id));
    const target=clone(state.configs.filter(c=>c.productId===product.id)),byId=new Map(target.map(c=>[c.id,c]));
    const result=updateLinkConfigCosts(target,activeShopId,anchorId,state.costSource);
    if(result.ids.length&&!await commitNasConfigs(result.ids.map(id=>({id,action:'replace',document:byId.get(id)})),
     {title:'链接恢复共用核算价',group:nasGroup(product)}))throw Error('未应用共用核算价。');
    return result;
   },
   applySync:sharedSources?.preview?null:async plan=>{
    const targetIds=new Set(plan.changes.map(row=>row.id));
    await refreshSourceSyncDependencies(shop);await loadNasScope([...targetIds]);
    const docs=clone(state.configs.filter(row=>targetIds.has(row.id))),byId=new Map(docs.map(c=>[c.id,c]));
    const ids=applySourceSync(plan,docs,sourceReviewRows());
    if(ids.length){
     const applied=await commitNasConfigs(ids.map(id=>({id,action:'replace',document:byId.get(id)})),{title:sourceActionTitle(plan.action),sourceSync:true});
     if(nasApplied(applied).length!==ids.length)throw Error('配置未全部确认保存，请先核对 NAS 批量操作。');
     await loadNasScope(ids);
    }
   },
   validateImage:async config=>{
    const current=available().find(row=>row.id===config.id);
    if(!current||!sameNasDocument({...config,layout:current.layout},current))throw Error('配置已变化，请重新准备导图。');
   },saveSkuMode,
   applyBatch:async changes=>{
    if(sharedSources)return sharedSources.save(changes);
    let count=0;
    try{
     const signature=JSON.stringify(changes);
     if(!follow||follow.signature!==signature){
      if(follow?.saved)throw Error('来源上一轮已部分保存，请先核对原操作结果或重新打开来源。');
      if(await nasWorkspace.queue().read())throw Error('请先处理上一项批量操作。');
      const sourceIds=changes.map(({row})=>row.sourceId),goods=[...new Set(changes.flatMap(({row,before})=>[row.goodsId,before?.goodsId]).filter(Boolean))];
      const ids=await nasWorkspace.sourceUsage(sourceIds,goods);
      await loadNasScope(ids);
      if(nasWorkspace.drafts().some(row=>ids.includes(row.id)))throw Error('相关配置仍有未保存修改，请先保存或核对草稿。');
      const scoped={...state,sourceCatalog:read(),configs:state.configs.filter(c=>ids.includes(c.id))};
      const calculated=changes.map(change=>({...change,row:{...change.row,tax:change.row.tax??null},
       before:change.before?{...change.before,tax:change.before.tax??null}:null}));
      const result=sourceBatch(scoped,calculated,undefined,{deferText:true}),docs=new Map(result.next.configs.map(c=>[c.id,c]));
      const costs=[...new Map(changes.filter(({before,row})=>/^\d{1,20}$/.test(row.goodsId||'')&&
       Object.hasOwn(row,'tax')&&(before?row.tax!==before.tax:row.tax!=null)).map(({row})=>[row.goodsId,{
        id:row.goodsId,action:'tax_edit',expected_version:nasWorkspace.costVersion(row.goodsId),fields:{tax:row.tax,taxUpdatedAt:new Date().toISOString()}
       }])).values()];
      follow={signature,docs,result,costs,versions:{sources:{},costs:{}},
       configVersions:new Map(result.configIds.map(id=>[id,nasWorkspace.configurationVersion(id)])),saved:0,costDone:false};
     }
     for(const {before,row} of changes){
      const previous=catalogRow('sources',row.sourceId);
      // 已有批次前几项成功时，重复点保存只继续未保存的项目。
      if(previous&&(follow.versions.sources[row.sourceId]===previous.version||sameNasDocument(previous.document,row))){
       count++;follow.versions.sources[row.sourceId]=previous.version;continue;
      }
      if(before&&(!previous||!sameNasDocument(before,previous.document)))throw Error('来源已变化，请比较后再加载。');
      const saved=follow.result.next.sourceCatalog.find(source=>source.sourceId===row.sourceId);
      const receipt=await saveNasCatalog('sources',row.sourceId,previous?'replace':'create',{...row,updatedAt:saved.updatedAt});
      follow.versions.sources[row.sourceId]=receipt.version;follow.saved=++count;
     }
     if(!follow.costDone&&follow.costs.length){
      const pending=follow.costs.filter(row=>{
       const current=state.costSource.find(cost=>cost.goodsId===row.id);
       if(!current||current.tax!==row.fields.tax||current.taxUpdatedAt!==row.fields.taxUpdatedAt)return true;
       follow.versions.costs[row.id]=nasWorkspace.costVersion(row.id);return false;
      });
      if(pending.length){
       const receipts=nasApplied(await startNasPlan('costs',pending,{title:'应用输出源核算价'}));
       if(receipts.length!==pending.length)throw Error('来源已保存，核算价仍待核对。');
       for(const row of receipts)follow.versions.costs[row.id]=row.version;
      }
      follow.costDone=true;
     }
     const {configIds,autoChanges,autoUpdatedFields}=follow.result;
     if(configIds.length){
      await loadNasScope(configIds);
      const applied=await commitNasConfigs(configIds.map(id=>({id,action:'replace',document:follow.docs.get(id),
       expected_version:follow.configVersions.get(id),dependencyOverrides:follow.versions})),
       {title:'应用输出源跟随'});
      if(nasApplied(applied).length!==configIds.length)throw Error('来源已保存，配置跟随仍待核对。');
     }
     follow=null;return {count,configIds,autoChanges,autoUpdatedFields};
    }catch(error){throw Error((count?`已确认 ${count} 条，其余草稿仍保留；`:'')+nasErrorText(error));}
   },
   setDeleted:sharedSources?.preview?null:async(id,deleted)=>{try{await saveNasCatalog('sources',id,deleted?'archive':'restore');}catch(error){throw formatNasCatalogError(error);}}
  });
  if(previewUnavailable)toast('三店验收暂不可用，已打开本店正式维护。');
 }catch(error){toast(nasErrorText(error));}
}
async function openNasGallery(pick=false,onPick=null){
 try{
  const target=current();
  if(pick&&!target)return toast('请先选择要更换图片的配置。');
  await loadNasCatalog('gallery');
  openCaseGallery({openDialog,closeDialog,esc,toast,uploadImage,nas:true,
   canUpload:nasWorkspace.canUpload(),canEdit:row=>catalogRow('gallery',row.id)?.editable===true,
   canCopy:row=>nasWorkspace.canManage()&&catalogRow('gallery',row.id)?.owner_shop==='shared'&&!row.deletedAt,
   copy:async row=>{try{return (await saveNasCatalog('gallery',row.id,'copy',null,{target_id:crypto.randomUUID()})).document;}catch(error){throw formatNasCatalogError(error);}},
   references:id=>nasWorkspace.catalog().list('gallery',id).then(row=>row.references),
   render:model=>reactWorkbench.dialog($('#dialog-body'),'case-gallery',model),
   renderRegion:(container,kind,model)=>reactWorkbench.dialog(container,kind,model),release:container=>reactWorkbench.release(container),
   operator:()=>operator,getRows:()=>state.caseGallery,getConfigs:()=>state.configs,
   saveRows:async rows=>{
    try{
     const changedRows=rows.filter(row=>!sameNasDocument(catalogRow('gallery',row.id)?.document,row));
     if(changedRows.length!==1)throw Error('图库记录已变化，请重新打开后再保存。');
     const row=changedRows[0],old=catalogRow('gallery',row.id)?.document;
     const action=old?!!old.deletedAt!==!!row.deletedAt?row.deletedAt?'archive':'restore':'replace':'create';
     await saveNasCatalog('gallery',row.id,action,['create','replace'].includes(action)?row:null);
    }catch(error){throw formatNasCatalogError(error);}
   },
   useImage:async row=>{
    if(current()!==target||nasEditorLocked())throw Error('当前配置已切换，请重新选择图片。');
    if(onPick)await onPick(row);
    else{checkpointConfig([target.id]);useGalleryImage(target,row);changed('从 NAS 图库更换机箱图片',[target.id],'asset');}
   }
  },{pick,append:!!onPick});
 }catch(error){toast(nasErrorText(error));}
}
function stageNasDrafts(ids){
 nasSaveSummary=null;
 for(const id of ids){
  const config=state.configs.find(c=>c.id===id);
  if(!config)continue;
  try{nasWorkspace.stage(config);nasSavedVersions.delete(id);if(!nasWriteFailures.has(id))nasStageFailures.delete(id);}
  catch(error){nasStageFailures.set(id,error);}
 }
 nasDraftFailure=nasStageFailures.values().next().value||null;
 syncNasControls();
}
function nasEditorLocked(){return nasBusy||!nasWorkspace.canWrite()||nasWorkspace.pending(active);}
const nasDateDisplay=new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',
 hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'});
const nasServerDisplayKey=()=>'diy-nas-server-display:'+nasWorkspace.serverDisplayScope();
function drawNasServerStatus(){
 const top=$('#nas-server-status');if(!top)return;
 const config=current(),version=config?nasWorkspace.serverVersion(config.id):null;
 const setText=(selector,text)=>{const target=top.querySelector(selector);if(target.textContent!==text)target.textContent=text;};
 setText('#nas-server-version',`当前配置服务端版本：${version?'v'+version:config?'暂无':'未选择配置'}`);
 setText('#nas-data-time-label',nasDataTime.firstImport?'首次导入：':'工作区最近更新：');
 const time=top.querySelector('#nas-data-time');
 if(nasDataTime.updatedAt){
  const fields=Object.fromEntries(nasDateDisplay.formatToParts(new Date(nasDataTime.updatedAt)).map(part=>[part.type,part.value]));
  setText('#nas-data-time',`${fields.year}-${fields.month}-${fields.day} ${fields.hour}:${fields.minute}:${fields.second}`);
  if(time.dateTime!==nasDataTime.updatedAt)time.dateTime=nasDataTime.updatedAt;
 }else{setText('#nas-data-time','暂无');if(time.hasAttribute('datetime'))time.removeAttribute('datetime');}
 setText('#nas-data-time-state',nasDataTime.state==='failed'?'（未刷新）':nasDataTime.state==='checking'?'（读取中）':'');
 const update=nasUpdateHint.time(),button=$('#workspace-sync'),badge=top.querySelector('#nas-update-hint');
 if(!badge)return;
 const hasDraft=dirty||Boolean(addonPackDrafts?.size||hostTemplateHasDrafts()||window.workbenchSourceEditor?.hasPending());
 const style=update?(hasDraft?'draft':'available'):'';
 if(button.dataset.update!==style){
  button.dataset.update=style;
  button.textContent=update?'刷新工作台 · 有更新':'刷新工作台';
  button.title=update?(hasDraft?'刷新会保留已存到本机的草稿，建议先保存到服务端。':'服务端有新操作，点击刷新工作台。'):'重新载入当前工作台';
 }
 badge.hidden=!update;
 if(update){
  const fields=Object.fromEntries(nasDateDisplay.formatToParts(new Date(update)).map(part=>[part.type,part.value]));
  setText('#nas-update-hint',`服务端有更新 ${fields.hour}:${fields.minute}`);
 }
}
function restoreNasDataTime(){
 // 仅记同端点、同账号确认过的服务端时间，让刷新失败时还能呈现上一条可靠值。
 try{
  const prior=JSON.parse(sessionStorage.getItem(nasServerDisplayKey())||'null');
  const updatedAt=nasTimeStamp(prior?.updatedAt);
  if(updatedAt)nasDataTime={updatedAt,firstImport:prior.firstImport===true,state:'checking'};
 }catch{}
}
async function refreshNasDataTime(poll=false){
 if(!stopNasUpdateWatch)return;
 nasPollDue||=poll;
 clearTimeout(nasDataTimeTimer);
 const generation=++nasDataTimeGeneration;
 const waitForReceipt=()=>{
  if(!nasPollDue||!nasWorkspace.isCommitting())return false;
  nasDataTimeTimer=setTimeout(()=>void refreshNasDataTime(true),1000);return true;
 };
 if(waitForReceipt())return;
 if(!poll){nasDataTime={...nasDataTime,state:'checking'};drawNasServerStatus();}
 try{
  const value=await nasWorkspace.serverDataTime({includeActivity:true});
  if(generation!==nasDataTimeGeneration)return;
  // 审计可能先于本机保存回执到达；等这次提交返回后再判断是谁的改动。
  if(waitForReceipt())return;
  nasUpdateHint.observe(value,nasPollDue);
  nasPollDue=false;
  nasDataTime={updatedAt:value.updatedAt,firstImport:value.firstImport,state:'confirmed'};
  try{sessionStorage.setItem(nasServerDisplayKey(),JSON.stringify(nasDataTime));}catch{}
 }catch{
  if(generation!==nasDataTimeGeneration)return;
  nasPollDue=false;
  if(poll)return;
  nasDataTime={...nasDataTime,state:'failed'};
 }
 drawNasServerStatus();
}
function scheduleNasDataTime(){
 if(!stopNasUpdateWatch)return;
 // 连续目录保存或图片加登记时合并只读查询，不让旧的飞行响应覆盖新确认。
 ++nasDataTimeGeneration;clearTimeout(nasDataTimeTimer);
 nasDataTime={...nasDataTime,state:'checking'};drawNasServerStatus();
 nasDataTimeTimer=setTimeout(()=>void refreshNasDataTime(),400);
}
function stopNasUpdateChecks(){
 stopNasUpdateWatch?.();stopNasUpdateWatch=null;
 ++nasDataTimeGeneration;clearTimeout(nasDataTimeTimer);
}
function syncNasControls(){
 if(!nasMain||!state)return;
 const c=current(),pending=!!c&&nasWorkspace.pending(c.id),locked=nasEditorLocked();
 $('.main').inert=locked;
 $('#poster-stage').inert=locked;$('#poster-inspector').inert=locked;
 const previewTools=$('.preview-controls');if(previewTools)previewTools.inert=locked;
 let drafts=[],oldPriceDrafts=[],draftReadError=null;
 try{drafts=nasWorkspace.drafts();oldPriceDrafts=nasWorkspace.priceDraft();}catch(error){draftReadError=error;}
 const oldPrices=oldPriceDrafts.length;
 const saveButton=$('#save');saveButton.disabled=nasBusy||!nasWorkspace.canWrite()||(!drafts.length&&!oldPrices&&!nasDraftFailure&&!draftReadError);
 saveButton.textContent=drafts.length&&drafts.every(row=>row.pending)&&!nasDraftFailure?'查询保存结果':'保存到服务端';
 const pendingConfigs=new Set([...drafts,...oldPriceDrafts].map(row=>row.id).concat([...nasStageFailures.keys()])).size;
 globalThis.workbenchPriceProfitView?.saveStatus({disabled:saveButton.disabled,label:saveButton.textContent,count:pendingConfigs});
 const retryButton=$('#nas-retry-save');if(retryButton){retryButton.hidden=!pending;retryButton.disabled=saveButton.disabled;}
 $('#workspace-sync').disabled=nasBusy||!!nasDraftFailure||!!draftReadError;
 $('#operator-open').disabled=nasBusy||!!nasDraftFailure||!!draftReadError;
 dirty=Boolean(nasDraftFailure||draftReadError||drafts.length||oldPrices);
 const addonCount=currentAddonDrafts().size;
 const syncStatus=$('#workspace-sync-status');
 syncStatus.textContent=[addonCount&&'本机留有 '+addonCount+' 份加购包草稿',drafts.length&&'本机留有 '+drafts.length+' 份配置草稿',
  oldPrices&&oldPrices+' 份旧版价格草稿'].filter(Boolean).join(' · ')||currentShop().shortName+' · NAS';
 syncStatus.title=syncStatus.textContent;syncStatus.toggleAttribute('data-addon-drafts',addonCount>0);
 const receiptButton=$('#nas-catalog-receipts');if(receiptButton)receiptButton.hidden=!nasWorkspace.catalog().pending().length;
 if(nasBusy)$('#save-status').textContent='正在处理 NAS 请求…';
 else if(nasDraftFailure||draftReadError)$('#save-status').textContent=nasErrorText(nasDraftFailure||draftReadError);
 else if(nasSaveSummary)$('#save-status').textContent=nasSaveSummary;
 else if(pending)$('#save-status').textContent='等待查询原提交回执';
 else if(c&&nasWorkspace.conflict(c.id))$('#save-status').textContent='服务器版本已更新 · 草稿保留';
 else $('#save-status').textContent=drafts.length?`本机有 ${drafts.length} 套配置待保存`:!nasWorkspace.canWrite()?'NAS 只读':nasSavedVersions.has(c?.id)?'NAS 已保存 · 版本 '+nasSavedVersions.get(c.id):'已载入服务端配置';
 drawNasServerStatus();
}
async function compareNasConfig(id=current()?.id){
 if(!id||nasBusy)return;
 try{
  // 弹窗关闭时总表会恢复单元格焦点；冲突处理始终绑定显式目标，不随当前行漂移。
  const value=await nasWorkspace.compare(id);
  drawNasServerStatus();
  openDialog('处理配置冲突',`<p class="hint">服务器版本 v${esc(value.remote.version)}。本机草稿仍保留，关闭即可继续查看草稿。</p>
   <div class="list-card"><div><strong>服务端配置</strong><small>${esc(value.remote.document.name||id)}</small></div>
   <div><strong>本机草稿</strong><small>${esc(value.draft.name||id)}</small></div></div>
   ${nasConfigConflictHtml(value,esc)}
   <div class="actions"><button id="nas-use-server" ${nasWorkspace.pending(id)?'disabled':''}>放弃草稿并载入服务器版本</button></div>`);
  $('#nas-use-server').onclick=async()=>{
   if(nasBusy||nasWorkspace.pending(id)||!confirm('确定放弃这套配置的本机草稿？'))return;
   try{
    const raw=nasWorkspace.useServer(id),[prepared]=await prepareDetails([raw]);
    state.configs=state.configs.map(row=>row.id===id?prepared:row);
    acceptedState={...acceptedState,configs:acceptedState.configs.map(row=>row.id===id?raw:row)};
    lazyWorkspace.confirm(state.revision,state.updatedAt,[raw]);displayBaseline.delete(id);rememberDisplayParts([id]);
    nasSaveSummary=null;history=[];redoHistory=[];posterEditor?.clear();syncHistoryButtons();closeDialog();renderAll();
   }catch(error){toast(nasErrorText(error));}
  };
 }catch(error){toast(nasErrorText(error));}
}
function nasSaveReport(results){
 const count=status=>results.filter(row=>row.status===status).length;
 return [`已保存 ${count('saved')} 套`,...[
  ['unchanged','无新改动'],['failed','未保存'],['pending','待查回执'],['unsent','本次未处理']
 ].filter(([status])=>count(status)).map(([status,label])=>`${label} ${count(status)} 套`)].join(' · ');
}
function showNasSaveResults(results){
 const compareCodes=['VERSION_CONFLICT','DEPENDENCY_CONFLICT','OPERATION_REUSED'];
 const detail=row=>row.status==='saved'?`已保存 · 版本 ${row.receipt.version}`:row.status==='unchanged'?'没有新改动':
  row.status==='unsent'?(row.pending?'原提交待核对，本次未查询':'本次未发送，草稿保留'):nasErrorText(row.error);
 openDialog('保存配置结果',`<p class="hint">${esc(nasSaveReport(results))}</p>${results.map(row=>`<div class="list-card">
  <div><strong>${esc(row.name||row.id)}</strong><small>${esc(detail(row))}</small></div>
  ${row.status==='pending'||row.status==='unsent'&&row.pending?`<button type="button" data-nas-save-retry="${esc(row.id)}">重试原提交</button>`:
   row.status==='failed'||row.status==='unsent'?`<button type="button" data-nas-save-locate="${esc(row.id)}" ${compareCodes.includes(row.error?.code)?'data-compare':''}>${compareCodes.includes(row.error?.code)?'处理冲突':'定位配置'}</button>`:''}</div>`).join('')}`);
 for(const button of $$('[data-nas-save-retry]'))button.onclick=()=>retryNasConfiguration(button.dataset.nasSaveRetry);
 for(const button of $$('[data-nas-save-locate]'))button.onclick=async()=>{
  if(nasBusy)return;
  const id=button.dataset.nasSaveLocate;
  if(!lazyWorkspace.index().summaries.some(row=>row.id===id))return toast('这套配置不在当前列表中，原草稿仍保留。');
  closeDialog();
  if(current()?.id!==id)await activate(id);
  if(button.hasAttribute('data-compare'))await compareNasConfig(id);
 };
}
async function runNasDraftSaves(rows,{retry=false,automatic=false,fromPricePage=false}={}){
 // 固定这次要提交的配置；锁住选择和编辑，父级关闭/退出也会等回执。
 nasBusy=true;const workspace=$('.workspace'),wasInert=workspace.inert;workspace.inert=true;syncNasControls();
 let results;
 try{
  results=await submitNasDraftSet(rows,{
   isPending:id=>nasWorkspace.pendingState(id),
   onProgress:checked=>{$('#save-status').textContent=`已核对 ${checked} / ${rows.length} 套配置`;},
   submit:async row=>{
    const config=state.configs.find(c=>c.id===row.id);
    if(!row.pending&&nasStageFailures.has(row.id)){
     if(!config)throw nasStageFailures.get(row.id);
     nasWorkspace.stage(config);if(!nasWriteFailures.has(row.id))nasStageFailures.delete(row.id);
    }
    const saved=await nasWorkspace.submitDraft(row.id,{config,retry});
    nasSavedVersions.set(row.id,saved.version);
    const base=nasWorkspace.acceptedDocument(row.id);
    if(base)acceptedState={...acceptedState,configs:acceptedState.configs.map(c=>c.id===row.id?base:c)};
    return saved;
   }
  });
  if(results.some(row=>row.status==='saved'&&row.receipt.dependenciesRefreshed))await refreshNasSavedDependencies(results.filter(row=>row.status==='saved').map(row=>row.id));
  nasSaveSummary=(automatic?'自动保存 · ':'')+nasSaveReport(results);
 }catch(error){
  nasSaveSummary=nasErrorText(error);
 }finally{
  nasDraftFailure=nasStageFailures.values().next().value||null;
  nasBusy=false;workspace.inert=wasInert;syncNasControls();
 }
 if(!automatic)toast(nasSaveSummary);
 if(!fromPricePage&&results?.some(row=>row.status==='saved'))refreshPriceSaveMarkers();
 if(results?.some(row=>row.status==='saved'||row.error?.code==='VERSION_CONFLICT'))void refreshNasDataTime();
 if(!automatic&&results?.some(row=>!['saved','unchanged'].includes(row.status)))showNasSaveResults(results);
 return results||[];
}
async function saveAllNasConfigurations({fromPricePage=false}={}){
 if(nasBusy||!nasWorkspace.canWrite())return;
 let rows;
 try{
  const old=nasWorkspace.priceDraft();
  if(old.length){
   const workspace=$('.workspace'),inert=workspace.inert;
   nasBusy=true;workspace.inert=true;syncNasControls();
   try{
    const available=new Set(ordinaryAvailable().map(c=>c.id));
    await loadNasScope(old.filter(row=>available.has(row.id)).map(row=>row.id));
    const safe=old.filter(row=>nasWorkspace.canMergePriceDraft(row)),ids=safe.map(row=>row.id);
    if(ids.length){
     checkpointConfig(ids);for(const row of safe)Object.assign(state.configs.find(c=>c.id===row.id),row.fields);
     changed('合入旧版价格利润草稿',ids,false,null,true);
     nasWorkspace.priceDraft(old.filter(row=>!ids.includes(row.id)||nasStageFailures.has(row.id)));
    }
    if(nasWorkspace.priceDraft().length)toast('有旧版价格利润草稿与服务器或新草稿冲突，已保留，请到价格利润表处理。');
   }finally{
    nasBusy=false;workspace.inert=inert;syncNasControls();
   }
  }
  rows=nasWorkspace.drafts();
 }catch(error){return toast(nasErrorText(error));}
 const persisted=new Set(rows.map(row=>row.id));
 for(const id of nasStageFailures.keys())if(!persisted.has(id))rows.push({id,name:state.configs.find(row=>row.id===id)?.name,pending:false});
 if(!rows.length)return toast('没有需要保存的配置修改。');
 await runNasDraftSaves(rows,{fromPricePage});
}
async function retryNasConfiguration(id){
 if(nasBusy||!nasWorkspace.canWrite()||!id)return;
 let row;
 try{row=nasWorkspace.drafts().find(row=>row.id===id&&row.pending);}catch(error){return toast(nasErrorText(error));}
 if(!row||!confirm('确认重试原提交？会先查原回执，必要时只发送原编号和原配置内容。'))return;
 if($('#dialog').open)closeDialog();
 await runNasDraftSaves([row],{retry:true});
}
function bindNasAutosave(){
 const canRun=()=>!!state&&!nasBusy&&!nasDraftFailure&&nasWorkspace.canWrite()&&!$('#dialog').open&&
  !window.parent.workbenchUpdatePending&&!window.parent.workbenchClosePending&&
  !document.activeElement?.matches('input,textarea,select,[contenteditable="true"]')&&
  !window.workbenchSourceEditor?.hasPending()&&!nasWorkspace.catalog().pending().length;
 nasAutosave=createNasAutosave({storage:localStorage,scope:nasWorkspace.serverDisplayScope(),canRun,
  drafts:()=>nasWorkspace.drafts(),isConflict:row=>nasWorkspace.conflict(row.id),
  submit:async rows=>{
   if(await nasWorkspace.queue().read()||!canRun()||!nasAutosave.enabled())return [];
   const pending=nasWorkspace.drafts();if(pending.some(row=>row.pending))return [];
   const versions=new Map(pending.map(row=>[row.id,row.version]));
   const eligible=rows.filter(row=>versions.get(row.id)===row.version&&!nasWorkspace.conflict(row.id));
   return eligible.length?runNasDraftSaves(eligible,{automatic:true}):[];
  },
  onBlocked:()=>{nasSaveSummary='自动保存已暂停 · 请先查询原保存结果';syncNasControls();},onError:error=>toast(nasErrorText(error))});
 function settings(){
  if(nasBusy||$('#dialog').open)return;
  openDialog('自动保存设置',`<label><input type="checkbox" id="nas-auto-save-toggle" ${nasAutosave.enabled()?'checked':''}> 自动保存到服务端（每 2 小时）</label>
   <p class="hint">自动保存本工作区已编辑的配置；关闭后仍可手动保存。</p><p id="nas-auto-save-status" role="status"></p>`);
  const input=$('#nas-auto-save-toggle');input.onchange=()=>{
   try{nasAutosave.setEnabled(input.checked);$('#nas-auto-save-status').textContent=input.checked?'已开启自动保存':'已关闭自动保存';}
   catch(error){$('#nas-auto-save-status').textContent=nasErrorText(error);}
  };
 }
 window.addEventListener('message',event=>{if(event.origin===location.origin&&event.source===window.parent&&event.data?.type==='workbench-nas-autosave-settings')settings();});
 window.addEventListener('focus',()=>void nasAutosave.checkDue());
 window.addEventListener('pagehide',event=>{if(!event.persisted)nasAutosave.dispose();});
 document.addEventListener('visibilitychange',()=>{if(!document.hidden)void nasAutosave.checkDue();});
}
function pickNasImage(onPick){
 const target=current();
 if(!target||nasEditorLocked())return toast('请先选择可编辑的配置。');
 const rows=state.caseGallery.filter(row=>!row.deletedAt&&/^\/uploads\/[0-9a-f]{64}\.(png|jpe?g)$/.test(row.url));
 openDialog('从 NAS 图库选择',`<label class="field">搜索品牌、型号或图片名称<input id="nas-gallery-search"></label>
  <p class="hint">选用图库中已有的原图。</p><div id="nas-gallery-results"></div><div class="actions">
  <button id="nas-gallery-prev">上一页</button><button id="nas-gallery-next">下一页</button></div>`);
 let page=0,busy=false;
 const list=$('#nas-gallery-results'),search=$('#nas-gallery-search'),prev=$('#nas-gallery-prev'),next=$('#nas-gallery-next');
 function draw(){
  const q=search.value.trim().toLowerCase(),hits=rows.filter(row=>[row.name,row.brand,row.model,row.color,row.edition].join(' ').toLowerCase().includes(q));
  const slice=hits.slice(page*12,page*12+12);
  list.innerHTML=slice.length?slice.map(row=>`<div class="list-card"><img width="64" height="64" loading="lazy" crossorigin="anonymous"
   src="${esc(globalThis.resolveWorkbenchAsset?.(row.url)||row.url)}" alt=""><div><strong>${esc(row.name)}</strong>
   <small>${esc([row.brand,row.model,row.color,row.edition].filter(Boolean).join(' · '))}</small></div>
   <button type="button" data-nas-image="${esc(row.id)}">使用图片</button></div>`).join(''):'<p class="hint">没有符合条件的图片。</p>';
  prev.disabled=page===0;next.disabled=(page+1)*12>=hits.length;
  for(const button of list.querySelectorAll('[data-nas-image]'))button.onclick=async()=>{
   if(busy||current()!==target||nasEditorLocked())return;
   const row=slice.find(entry=>entry.id===button.dataset.nasImage);if(!row)return;
   busy=true;button.disabled=true;
   try{
    if(onPick)await onPick(row);
    else{checkpointConfig();target.caseImage=row.url;changed('从 NAS 图库更换机箱图片',[target.id],'asset');}
    if(list.isConnected&&current()===target)closeDialog();
   }catch(error){toast(nasErrorText(error));}
   finally{busy=false;button.disabled=false;}
  };
 }
 prev.onclick=()=>{page--;draw();};next.onclick=()=>{page++;draw();};search.oninput=()=>{page=0;draw();};draw();
}
function bindNasMain(){
 document.body.classList.add('nas-main');
 void refreshHostTemplateList();
 document.querySelector('.topbar .prototype').textContent=currentShop().shortName+' · NAS';
 const hidden=['copy-shop','saved-image'];
 if(!nasWorkspace.canPlan())hidden.push('delete-current','delete-selected','duplicate','empty-create','new-product','link-recycle-shortcut',
  'ids','renumber','link-parts','link-upgrades','link-display-names','batch-style','global-batch-open','shop-settings','erp-sync','product-sync-open','price-profit-open',
  'inventory-check-open','inventory-export-open','price-changes-open','logs-open');
 for(const id of hidden){const element=$('#'+id);if(element){element.hidden=true;element.removeAttribute('onclick');element.onclick=null;}}
 for(const element of $$('[data-nav="cost-source"],[data-nav="logs"],.erp-sync-controls'))
  element.hidden=!nasWorkspace.canPlan();
 for(const el of $$('[data-nav="cost-source"]'))el.textContent='当前店铺核算价';
 const note=$('.sidebar-note');if(note)note.textContent=currentShop().shortName+'业务数据保存在 NAS。';
 if(nasWorkspace.canPlan()){
  $('#erp-sync').textContent='ERP 同步';bindNasErp();
  $('#price-changes-open').onclick=()=>showPriceChanges();
  $('#inventory-export-open').onclick=nasScopeAction(()=>openInventoryExport({openDialog,esc,getConfigs:ordinaryAvailable,shop:currentShop(),download:downloadBlob,toast}));
  $('#logs-open').onclick=openNasActivity;
 }
 if(nasWorkspace.supportsAddonPacks()){
  for(const name of ['addon-packs','benefits'])$(`[data-tab="${name}"]`).hidden=false;
  $('[data-tab="perks"]').hidden=true;
  const button=document.createElement('button');button.type='button';button.id='addon-pack-maintenance-open';
  button.textContent='加购包维护';button.onclick=openAddonPackOverview;$('#global-batch-open').after(button);
 }
 if(nasWorkspace.canWrite())bindNasAutosave();
 const picker=$('#shop-picker'),allowed=nasWorkspace.shops();
 for(const option of [...picker.options])if(!allowed.includes(option.value))option.remove();
 picker.disabled=allowed.length<2;
 picker.onchange=async()=>{
  const next=picker.value;picker.value=activeShopId;
  if(next===activeShopId||!allowed.includes(next))return;
  if(hostTemplateHasDrafts())return toast('请先保存主机模板或恢复到已保存版本。');
  if(nasBusy||nasDraftFailure||addonPackDrafts?.hasFailure()||hasDraftDialog()||window.workbenchSourceEditor?.hasPending()||
    window.parent.workbenchClosePending||window.parent.workbenchUpdatePending){
   toast('请先完成当前操作，处理未写入本机的草稿并关闭编辑窗口。');return;
  }
  if(!leaveSourceSheet())return;
  // 重建编辑器以隔开同 ID 的配置、选中项、撤销记录、成本缓存和图片预览。
  // 草稿和未知回执已按店存到本机；切店不调用保存和重试。
  try{await flushConfigDrafts();}catch(error){toast(error.message);return;}
  stopNasUpdateChecks();nasAutosave?.dispose();nasWorkspace.close();reactWorkbench?.dispose?.();
  const nextUrl=new URL(location.href);nextUrl.searchParams.set('nas_shop',next);location.replace(nextUrl.href);
 };
 $('#asset-file').onchange=null;$('#backup-file').onchange=null;
 $('#asset-button').onclick=()=>nasWorkspace.canManage()?openNasGallery(true):pickNasImage();
 $('#case-gallery-open').onclick=()=>openNasGallery();
 if(nasWorkspace.canPlan()){
  $('#duplicate').onclick=()=>duplicateNasConfig();
  if($('#product-sync-open')){$('#product-sync-open').hidden=false;$('#product-sync-open').onclick=openNasStandardProduct;}
  // 保持原三列标题栏，导入放入「列表操作」。
  const importButton=document.createElement('button');importButton.id='nas-legacy-import';importButton.type='button';
  importButton.textContent='导入配置备份';importButton.onclick=openNasLegacyImport;$('.list-actions-menu .config-delete-tools').append(importButton);
  const planButton=document.createElement('button');planButton.type='button';planButton.id='nas-workspace-plan';planButton.textContent='NAS 批量操作';
  planButton.hidden=true;planButton.onclick=async()=>{try{const upgrade=await overviewNas().pending();if(upgrade)overviewNas().showJob(upgrade);else openNasPlanStatus();}catch(error){toast(nasErrorText(error));}};$('#save').before(planButton);
  refreshNasPlanButton();
 }
 $('#save').onclick=saveAllNasConfigurations;
 const retrySave=document.createElement('button');retrySave.type='button';retrySave.id='nas-retry-save';
 retrySave.textContent='重试原提交';retrySave.hidden=true;retrySave.onclick=()=>retryNasConfiguration(current()?.id);$('#save').before(retrySave);
 $('#workspace-sync').textContent='刷新工作台';
 $('#workspace-sync').onclick=async()=>{
  if(hostTemplateHasDrafts())return toast('请先保存主机模板或恢复到已保存版本。');
  if(window.workbenchSourceEditor?.hasPending())return toast('请先保存或放弃输出源的待保存修改。');
  if(addonPackDrafts?.hasFailure())return toast('有加购草稿未写入本机，请先保存加购包。');
  try{await flushConfigDrafts();if(!nasBusy&&!nasDraftFailure)location.reload();}catch(error){toast(error.message);}
 };
 const serverStatus=document.createElement('div');serverStatus.id='nas-server-status';
 serverStatus.setAttribute('role','status');serverStatus.title='工作区时间取自服务端操作记录，以北京时间显示。';
 serverStatus.innerHTML='<small id="nas-server-version"></small><small><span id="nas-data-time-label"></span><time id="nas-data-time"></time><span id="nas-data-time-state"></span><span id="nas-update-hint" hidden></span></small>';
 $('.workspace-sync-controls').after(serverStatus);
 stopNasUpdateWatch=watchNasUpdates(()=>refreshNasDataTime(true));
 window.addEventListener('pagehide',event=>{if(!event.persisted)stopNasUpdateChecks();});
 restoreNasDataTime();void refreshNasDataTime();
 const receipts=document.createElement('button');receipts.type='button';receipts.id='nas-catalog-receipts';receipts.textContent='查询目录回执';
 receipts.hidden=true;receipts.onclick=showNasCatalogReceipts;$('#save').before(receipts);
 const leave=$('#operator-open');leave.textContent='退出账号';
 leave.onclick=async()=>{
  if(hostTemplateHasDrafts())return toast('请先保存主机模板或恢复到已保存版本。');
  if(addonPackDrafts?.hasFailure())return toast('有加购草稿未写入本机，请先保存加购包。');
  if(nasBusy||nasDraftFailure||window.workbenchSourceEditor?.hasPending()||!confirm('退出 NAS 工作区？已保存在本机的草稿可在同一账号重新登录后继续。'))return;
  try{
   // 退出后 iframe 关闭监听会卸载，须先确认并等 ERP 停止，避免登录页关闭绕过保护。
   if(erpMatching&&!await erpMatching.stopForLeave('后台 ERP 匹配尚未结束。确认停止后续配置、等待当前配置完成后退出工作台账号？'))return;
   await flushConfigDrafts();
   const result=await fetch('/api/native-nas-identity/logout',{method:'POST',body:'{}'});
   if(!result.ok)throw Error('账号未退出，请重试');
   const logout=await result.json();
   stopNasUpdateChecks();nasAutosave?.dispose();nasWorkspace.close();
   window.parent.postMessage({type:'workbench-signed-out',nasLogoutUnconfirmed:logout.nas_session_revoked===false},location.origin);
  }catch(error){toast(nasErrorText(error));}
 };
 // 恢复原版的链接主题范围，先加载完整配置再暂存变化；模板只影响自身。
 for(const button of $$('[data-theme]'))button.onclick=async()=>{
  const c=current(),product=currentProduct();if(!c||nasEditorLocked()||!product)return;
  const legacy=isLegacyTemplateConfig(c),wanted=(legacy?[c]:product.configs).map(row=>row.id);
  try{
   await loadNasScope(wanted);
   if(current()?.id!==c.id||nasEditorLocked())return;
   if(wanted.some(id=>nasWorkspace.pending(id)))throw Error('此链接有待查询的保存结果，请先确认。');
   checkpointConfig(wanted);const ids=setProductTheme(state.configs.filter(row=>wanted.includes(row.id)),button.dataset.theme);
   if(ids.length)changed(legacy?'修改主机模板图片主题':'修改链接图片主题',ids,'asset');
   $$('[data-theme]').forEach(option=>option.classList.toggle('active',option===button));if(tab==='modules')renderEditor();
  }catch(error){toast(nasErrorText(error));}
 };
}
// 绑定工作台按钮、导航和退出保护，仅在启动初始化时调用。
function bind(){
 // 原生关闭事件可能排在再次打开之后，只清理仍关闭的对话框，避免释放新表单。
 $('#dialog').addEventListener('close',()=>{if($('#dialog').open)return;window.workbenchSourceEditor?.detachForDialog?.();$('#dialog-body').querySelectorAll('.product-search').forEach(destroyProductSearch);reactWorkbench.release($('#dialog-body'));});
 $('#dialog').addEventListener('close',()=>setTimeout(()=>{if($('#dialog').open||!window.workbenchSourceEditor?.sheet&&window.workbenchSourceEditor?.hasPending())return;reactWorkbench.release($('#dialog-body'));$('#dialog-body').replaceChildren();compactWorkspace().catch(()=>{});},0));
 // 独立区域复用工作区草稿、历史记录、冲突检查以及正式保存路径。
 const priceConfigs=()=>ordinaryConfigs(liveConfigs(listConfigs()));
 // 价格页和配置页共用草稿，隐藏的基本信息、链接、总表和预览也跟随最新草稿。
 const renderPriceEdit=()=>{
  renderList();
  if(!current())return;
  renderConfigFields();renderProduct();continuousWorkbench?.draw();schedulePreview();
 };
 const applyPriceEdits=async(input,message,{scopeIds=[]}={})=>{
   // 先一次载全所有涉及链接，再生成并验证最终矩阵；不在 checkpoint 后做任何异步读取。
   const rows=priceConfigs(),requested=new Set(scopeIds.length?scopeIds:input.map(row=>row.id));
   const links=new Set(rows.filter(c=>requested.has(c.id)).map(c=>JSON.stringify([c.shopId,c.productId])));
   await loadNasScope(rows.filter(c=>links.has(JSON.stringify([c.shopId,c.productId]))).map(c=>c.id));
   const plan=typeof input==='function'?input(state.configs):input;
   const ids=[...new Set(plan.map(row=>row.id))];if(!ids.length)return;
   if(nasMain&&(!nasWorkspace.canWrite()||nasBusy||ids.some(id=>nasWorkspace.pending(id))))throw Error('请确认写入权限并等待配置保存或回执查询完成。');
   const configs=new Map(state.configs.filter(c=>!c.deletedAt&&(!nasMain||c.shopId===activeShopId)).map(c=>[c.id,c]));
   if(ids.some(id=>!configs.has(id)))throw Error('配置已变化，请重新选择。');
   checkpointConfig(ids);
   for(const row of plan){const config=configs.get(row.id);Object.assign(config,row.fields);if(Object.hasOwn(row.fields,'shortName'))syncPosterShortName(config);}
   changed(message,ids,false,null,true);renderPriceEdit();
 };
 const priceProfitView=globalThis.workbenchPriceProfitView=mountPriceProfit($('#price-profit-page'),{
  shops:nasMain?shops.filter(s=>s.id===activeShopId):shops,activeShop:()=>activeShopId,currentConfig:current,settings:id=>settingsFor(state,id),costs:()=>state.costSource||[],
  links:priceConfigs,nas:nasMain,openStockCheck:(product,shopId)=>openStockCheckFull(product,shopId),
  rows:()=>priceConfigs().filter(c=>!c.emptyLinkDraft),
  allConfigs:listConfigs,history:()=>[history.length,redoHistory.length],
  restoreTaxes:restoreOverviewTaxes,errorText:error=>nasErrorText(error,listConfigs()),
  batchProfit:async(ids,key,shopId)=>{
   const seed=priceConfigs().find(c=>ids.includes(c.id))||priceConfigs().find(c=>JSON.stringify([c.shopId,c.productId])===key)||current();
   const targetShop=shopId==='all'?(seed?.shopId||activeShopId):shopId,live=priceConfigs().filter(c=>c.shopId===targetShop&&!c.emptyLinkDraft);
   const checked=live.filter(c=>ids.includes(c.id)),link=live.filter(c=>c.productId===seed?.productId);
   const related=list=>{const links=new Set(list.map(c=>c.productId));return live.filter(c=>links.has(c.productId));};
   const details=list=>list.map(row=>state.configs.find(c=>c.id===row.id));
   const scope=(key,label,list,preferred=false)=>({key,label,count:list.length,links:new Set(list.map(c=>c.productId)).size,preferred,configs:()=>details(list),related:()=>details(related(list))});
   try{
    await loadNasScope(related([...checked,...link]).map(c=>c.id));
    openBatchProfitPrice({openDialog,esc,toast,settings:()=>settingsFor(state,targetShop),
     scopes:[scope('selected','勾选的配置',checked,!!checked.length),scope('link','当前链接',link,!checked.length),scope('all','本店全部链接',live)],
     loadAll:options=>loadPriceDetails(live.map(c=>c.id),options),
     apply:async(plan,message)=>{await applyPriceEdits(plan.map(p=>({id:p.id,fields:{price:p.price,...(p.installmentMode!=='keep'?{installment:p.installment}:{}),...(p.price99Mode!=='keep'?{overviewPrice99:p.price99}:{})}})),message);closeDialog();priceProfitView.refresh({force:true});}
    });
   }catch(error){toast(error.message);}
  },
  // 基线也走同一只读成本/来源投影，成本同步不能被误画为配置未保存。
  accepted:()=>{
   const configs=ordinaryConfigs(liveConfigs(acceptedState.configs));
   if(!nasMain)return configs;
   const costs=new Map((state.costSource||[]).map(row=>[row.goodsId,row])),sources=nasWorkspace.hasSharedSources()?new Map(catalog.map(row=>[row.sourceId,row])):null;
   return configs.map(raw=>{const base=nasWorkspace.acceptedDocument(raw.id)??raw;return presentNasConfig(base,base.addons,costs,sources,settingsFor(state,base.shopId));});
  },
  renderCard:(container,id)=>continuousWorkbench?.renderCard(container,id),releaseCard:container=>continuousWorkbench?.releaseCard(container),
  apply:applyPriceEdits,
  setAlert:(id,value)=>{if(nasMain)return saveNasSettings({profitAlert:value});checkpoint();state.shopSettings[id].profitAlert=value;changed('修改店铺利润预警',[]);},
  openErpMatching:()=>erpMatching?.open(),onErpSelection:count=>erpMatching?.selected(count),
  editShop:id=>openShopSettings(id),editLink:c=>openProduct(true,c),newLink:id=>openProduct(false,null,'',id),
  undo:()=>stepHistory(history,redoHistory,'撤销编辑'),redo:()=>stepHistory(redoHistory,history,'重做编辑'),
  save:()=>nasMain?saveAllNasConfigurations({fromPricePage:true}):$('#save').onclick(),
  oldPriceDraft:()=>nasMain?nasWorkspace.priceDraft():[],
  discard:()=>{if(nasMain&&nasWorkspace.priceDraft().length&&confirm('放弃旧版价格利润草稿？当前配置草稿仍保留。')){nasWorkspace.priceDraft([]);syncNasControls();}},
  openDialog,closeDialog,toast,download:downloadBlob,
  onClose:()=>{renderAll();setTimeout(()=>compactWorkspace().catch(()=>{}),0);},
  locate:async c=>{if(activeShopId!==c.shopId){activeShopId=c.shopId;localStorage.setItem('diy-active-shop',activeShopId);selected.clear();collapsedProducts.clear();}await activate(c.id);if(current()?.id===c.id){switchTab('parts');continuousWorkbench?.locate(c.id);}}
 });
 // 每次打开匹配窗口刷新本机名称索引，后台轮询只按 GoodID 查表。
 const matchingPartNames=new Map();
 function openMatchingDialog(title,html){
  matchingPartNames.clear();
  const remember=(row,name)=>{
   const id=String(row.goodsId??''),label=String(name??'').trim();
   if(id&&label&&!matchingPartNames.has(id))matchingPartNames.set(id,label);
  };
  for(const row of state.costSource??[])remember(row,latestErpName(row));
  for(const row of catalog??[])remember(row,row.erpName||row.name);
  for(const shop of shops){
   for(const row of shopErpExtras(shop.id,settingsFor(state,shop.id)))remember(row,row.name);
  }
  for(const raw of acceptedState.configs){
   const config=nasMain?(nasWorkspace.acceptedDocument(raw.id)??raw):raw;
   for(const row of config.actualParts??[])remember(row,row.erpName||row.name);
  }
  openDialog(title,html);
  const subtitle=document.createElement('small');
  subtitle.textContent='按店铺、SPU、SKU 精确核对，执行后回读套餐 BOM';
  $('#dialog-title').append(subtitle);
 }
 erpMatching=createErpMatchingUi({request:erpMatchingRequest,openDialog:openMatchingDialog,closeDialog,errorText:error=>nasErrorText(error,listConfigs()),
  selectedIds:()=>priceProfitView.selectedIds(),
  partName:id=>matchingPartNames.get(id),
  onLabel:(label,disabled)=>{const button=$('#pp-erp-match');button.textContent=label;button.disabled=disabled;},
  snapshots:async selectedIds=>{
   await priceProfitView.flush();const ids=selectedIds??priceProfitView.selectedIds();
   if(!ids.length)throw Error('请先勾选要匹配的已保存配置。');
   await loadNasScope(ids);
   if(nasMain){
    const drafts=new Set([...nasWorkspace.drafts(),...nasWorkspace.priceDraft()].map(row=>row.id));
    const blocked=ids.filter(id=>drafts.has(id)||nasStageFailures.has(id));
    if(blocked.length){const error=Error('UNSAVED_DRAFT');error.code='UNSAVED_DRAFT';error.details={configuration_ids:blocked};throw error;}
    if(nasBusy||await nasWorkspace.queue().read())throw Error('请先完成 NAS 保存或待确认的批量操作。');
   }else if(dirty||savePromise||batchPending||ordinaryPending)throw Error('存在未保存的本地草稿，请先保存后再匹配。');
   return ids.map(id=>{
    const saved=nasMain?nasWorkspace.acceptedDocument(id):acceptedState.configs.find(c=>c.id===id);
    if(!saved||saved.deletedAt)throw Error('配置尚未保存或已移入回收站，请重新选择。');
    return matchingSnapshot(saved,settingsFor(state,saved.shopId),{version:nasMain?nasWorkspace.configurationVersion(id):acceptedState.revision,costs:state.costSource});
   });
  }
 });
 window.addEventListener('unload',()=>erpMatching?.dispose(),{once:true});
 $('#price-profit-open').onclick=async()=>{
  if(!leaveInventoryPage()||!leaveSourceSheet())return;
  if(!nasMain)return fullAction(()=>priceProfitView.show())().catch(()=>{});
  const button=$('#price-profit-open');if(button.disabled||nasBusy)return;
  button.disabled=true;nasBusy=true;syncNasControls();
  const scope=$('.workspace'),wasInert=scope.inert;scope.inert=true;
  try{
   // 分块准备完整价格资料并让出主线程；并发点击不会重复启动全店加载。
   await loadPriceDetails(ordinaryAvailable().map(c=>c.id),{progress:(count,total)=>{
    $('#save-status').textContent=`正在载入价格资料 ${count} / ${total}`;
   }});
   priceProfitView.show();
  }catch(error){toast(nasErrorText(error));}
  finally{scope.inert=wasInert;nasBusy=false;button.disabled=false;syncNasControls();}
 };
 mountNameFormatEntry(openNameFormats);
 $('#operator-open').textContent='操作人：'+operator;$('#operator-open').onclick=()=>workspaceSyncUi?.open();$('#shop-settings').onclick=()=>openShopSettings();
 $('#shop-picker').onchange=async()=>{const next=$('#shop-picker').value;if(next===activeShopId)return;const previous=activeShopId;if(!leaveSourceSheet()){$('#shop-picker').value=previous;return;}try{await save();posterEditor?.clear();activeShopId=next;templateSectionOpen=false;localStorage.setItem('diy-active-shop',next);active=fullWorkspace?(ordinaryConfigs(available())[0]?.id||null):null;selected=new Set(active?[active]:[]);collapsedProducts.clear();if(!fullWorkspace)productGroups(available()).forEach(p=>collapsedProducts.add(p.id));listPinnedProduct=null;$('#search').value='';$('#link-category-filter').value='';renderAll();}catch(e){activeShopId=previous;$('#shop-picker').value=previous;toast(e.message);}};
 if(!nasMain)bindErpSync({openDialog,toast,operator:()=>operator,flush:save,receive:result=>receiveErpForPrices(result,{syncDialog:true}),afterApply:checkPriceChanges,context:()=>JSON.stringify([state.revision,changeCounter,activeShopId,active,tab]),hasPending:()=>window.workbenchHasPendingChanges()||conflict});
 if($('#product-sync-open'))$('#product-sync-open').onclick=fullAction(openLocalStandardProduct);
 $$('[data-config]').forEach(input=>{input.onfocus=()=>checkpointConfig();input.oninput=()=>{current()[input.dataset.config]=input.value;if(input.dataset.config==='shortName'){current().shortNameAuto=false;syncPosterShortName(current());}changed('编辑配置基本信息');};});
 // 高级编辑复用既有业务事件；主界面继续保留总表、加购福利与图片样式三个页签。
 $$('[data-editor-open]').forEach(button=>button.onclick=()=>{if(!current())return;button.closest('details').open=false;switchTab(button.dataset.editorOpen);});
 $$('[data-tab]').forEach(b=>b.onclick=()=>switchTab(b.dataset.tab));$('#search').oninput=()=>{renderList();};$('#link-category-filter').onchange=()=>{renderList();$('#config-list').scrollTop=0;};document.querySelector('.list-actions-menu').addEventListener('click',e=>{if(e.target.closest('button'))document.querySelector('.list-actions-menu').open=false;});document.addEventListener('pointerdown',e=>{const menu=document.querySelector('.list-actions-menu');if(!menu.contains(e.target))menu.open=false;});document.addEventListener('keydown',e=>{if(e.key==='Escape')document.querySelector('.list-actions-menu').open=false;});{const box=$('#link-expand-on-open');if(box){box.checked=expandOnOpen();box.onchange=()=>{localStorage.setItem('diy-link-expand-on-open',box.checked?'1':'0');toast(box.checked?'点开链接时会同时展开配置':'点开链接时不再展开配置');};}}$('#collapse-all-links').onclick=()=>{productGroups(available()).forEach(g=>collapsedProducts.add(g.id));listPinnedProduct=null;renderList();$('#config-list').scrollTop=0;};$('#select-all').onchange=()=>{listedConfigs().forEach(c=>$('#select-all').checked?selected.add(c.id):selected.delete(c.id));renderList();};
 $('#save').onclick=nasMain?saveAllNasConfigurations:async()=>{try{await save();toast('本地配置已保存');}catch(e){toast(e.message);}};
 syncHistoryButtons();$('#undo').onclick=()=>stepHistory(history,redoHistory,'撤销编辑');$('#redo').onclick=()=>stepHistory(redoHistory,history,'重做编辑');
 $('#duplicate').onclick=fullAction(()=>{const capacityError=configCapacityMessage(state.configs,activeShopId,1);if(capacityError)return toast(capacityError);checkpoint();const c=clone(current());c.id=crypto.randomUUID();c.name+=' · 副本';c.skuId='';state.configs=insertConfigAfter(state.configs,active,c);active=c.id;selected.add(c.id);changed('复制配置');renderAll();});
 $('#delete-current').onclick=()=>removeConfigurations([active]);$('#delete-selected').onclick=()=>removeConfigurations([...selected]);$('#link-recycle-shortcut').onclick=openDeletedConfigs;$('#empty-create').onclick=()=>openProduct();
 $('#new-product').onclick=()=>selectedZone==='templates'?openProduct(false,null,'主机模板'):openProduct();$('#copy-shop').onclick=openCopyToShop;
$('#name-generate').onclick=()=>{checkpointConfig();current().shortNameAuto=true;current().nameFormat=$('#name-format').value;syncPosterShortName(current());changed('生成简称');renderAll();};$('#ids').onclick=openIds;$('#renumber').onclick=nasMain?openRenumberFull:fullAction(openRenumberFull);$('#link-parts').onclick=openLinkPartsDialog;
 // 先用摘要确定范围。勾选范围的同链配置也需加载，因为分期和尾数设置作用于整链。
 $('#batch-profit-price').onclick=async event=>{
  const button=event.currentTarget;
  if(button.disabled||nasBusy)return;
  const label=button.textContent,shop=activeShopId,product=current()?.productId;
  const live=ordinaryAvailable().filter(c=>c.productCategory!=='主机模板'&&!c.emptyLinkDraft);
  const checked=live.filter(c=>selected.has(c.id)),link=live.filter(c=>c.productId===product);
  const initialLinks=new Set([product,...checked.map(c=>c.productId)]);
  const detailRows=list=>{
   const details=new Map(state.configs.map(c=>[c.id,c]));
   return list.map(c=>details.get(c.id));
  };
  const scope=(key,label,list,preferred=false)=>{
   const links=new Set(list.map(c=>c.productId)),related=key==='all'?live:live.filter(c=>links.has(c.productId));
   return {key,label,count:list.length,links:links.size,preferred,configs:()=>detailRows(list),related:()=>detailRows(related)};
  };
  button.disabled=true;button.textContent='正在载入定价配置…';
  try{
   await loadPriceDetails(live.filter(c=>initialLinks.has(c.productId)).map(c=>c.id));
   if(shop!==activeShopId||product!==current()?.productId||$('#dialog').open)return;
   openBatchProfitPrice({openDialog,esc,toast,settings:currentSettings,
   scopes:[scope('selected','勾选的配置',checked,checked.length>1),scope('link','当前链接',link,true),scope('all','本店全部链接',live)],
   loadAll:options=>loadPriceDetails(live.map(c=>c.id),options),
   apply:(plan,message)=>{
    const configs=new Map(state.configs.filter(c=>!c.deletedAt&&c.shopId===activeShopId).map(c=>[c.id,c]));
    const ids=plan.map(p=>p.id);
    if(ids.some(id=>!configs.has(id)))throw Error('配置范围已变化，请重新打开定价弹窗。');
    if(nasMain&&(!nasWorkspace.canWrite()||nasBusy||ids.some(id=>nasWorkspace.pending(id))))throw Error('请确认写入权限并等待 NAS 保存或回执查询完成。');
    checkpointConfig(ids);
    for(const p of plan){
     const c=configs.get(p.id);
     // 显式整链改动已完整列入预览；仅写计划中的配置，保持项绝不向同链接广播。
     if(p.installmentMode==='on'||p.installmentMode==='off')c.installment=p.installment;
     if(p.price99Mode==='on'||p.price99Mode==='off')c.overviewPrice99=!!p.price99;
     c.price=p.price;
    }
    changed(message,ids);closeDialog();renderAll();
   }});
  }catch(error){toast(nasMain?nasErrorText(error):error.message);}
  finally{button.textContent=label;button.disabled=false;}
 };
 $('#batch-style').onclick=openBatchStyle;$('#global-batch-open').onclick=openGlobalParts;$('#link-upgrades').onclick=()=>openUpgradeDescriptions(true);$('#link-display-names').onclick=()=>openUpgradeDescriptions(true,'displayName');$('#inventory-check-open').onclick=openStockCheck;$('#price-changes-open').onclick=()=>showPriceChanges();$('#inventory-export-open').onclick=fullAction(()=>openInventoryExport({openDialog,esc,getConfigs:()=>state.configs.filter(config=>!isLegacyTemplateConfig(config)),shop:currentShop(),download:downloadBlob,toast}));
 $('#poster-auto-width').onchange=()=>{checkpointConfig();const c=current();c.autoWidth=$('#poster-auto-width').checked;delete c.freeCanvasLayouts?.[c.layout];delete c.textTransforms?.[c.layout];delete c.moduleTransforms?.[c.layout];posterEditor?.clear();changed('按型号适配图片宽度');};
 $('#sku-mode').onchange=async()=>{try{await saveSkuMode([current().id],$('#sku-mode').value);renderAll();}catch(e){toast(e.message);}};
 $('#layout').onchange=()=>setPosterView({layout:$('#layout').value,skuMode:skuImageMode(current())});$$('[data-theme]').forEach(b=>b.onclick=fullAction(()=>{checkpoint();const legacy=isLegacyTemplateConfig(current());const ids=legacy?setProductTheme([current()],b.dataset.theme):setProductTheme(currentProduct().configs,b.dataset.theme);changed(legacy?'修改主机模板图片主题':'修改链接图片主题',ids,'asset');$$('[data-theme]').forEach(x=>x.classList.toggle('active',x===b));if(tab==='modules')renderEditor();toast((legacy?'当前主机模板':'当前链接')+'已切换为'+(b.dataset.theme==='dark'?'深色':'浅色')); }));$('#export-width').onchange=()=>toast('导出宽度已调整，预览使用默认尺寸，导出使用所选宽度');
 $('#download').onclick=exportCurrent;$('#batch-export').onclick=batchExport;
 const exportKind=$('#image-export-kind'),exportSkuMode=$('#image-export-sku-mode'),skuChoice=$('#image-export-sku-choice');
 exportKind.onchange=()=>{
  const kind=exportKind.value;
  skuChoice.classList.toggle('hidden',kind==='long');
  if(overviewPreviewActive()&&kind!=='both')setOverviewPreviewLayout(kind);
 };
 exportSkuMode.onchange=()=>{
  if(overviewPreviewActive()&&(exportSkuMode.value!=='saved'||overviewPreviewLayout==='square'))setOverviewPreviewLayout('square');
 };
 $('#backup-file').onchange=async e=>{const file=e.target.files[0];if(!file)return;try{const incoming=JSON.parse(await file.text());if(!Array.isArray(incoming.configs)||!incoming.configs.length||incoming.configs.some(c=>!c.id||!Array.isArray(c.parts)||!Array.isArray(c.modules)))throw Error('备份格式不正确');openDialog('恢复本地备份',`<p class="hint">备份有 ${incoming.configs.length} 套配置，将替换当前原型数据。可先下载当前备份。恢复后可撤销。</p><div class="actions"><button id="restore-backup-first">备份当前数据</button><button id="restore-apply" class="primary">恢复这些配置</button></div>`);$('#restore-backup-first').onclick=backup;$('#restore-apply').onclick=async()=>{await ensureFullWorkspace();const counter=changeCounter,prepared=await prepareWorkspaceState({...incoming,revision:state.revision,caseGallery:incoming.caseGallery??state.caseGallery},baseCatalog);if(counter!==changeCounter||savePromise||batchPromise||conflict)return toast('恢复准备期间配置已有新的修改，请重新打开备份');checkpoint();state=prepared.state;catalog=prepared.catalog;if(!shops.some(shop=>shop.id===activeShopId))activeShopId='intel';active=ordinaryConfigs(available())[0]?.id||null;selected=new Set(active?[active]:[]);changed('恢复备份',state.configs.map(c=>c.id));renderAll();closeDialog();};}catch(err){toast(err.message);}e.target.value='';};
 $('#asset-button').onclick=()=>openGallery(true);$('#asset-file').onchange=async e=>{const f=e.target.files[0];if(!f)return;try{if(f.size>24*1024*1024)throw Error('素材请小于 24MB');const data=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result.split(',')[1]);reader.onerror=reject;reader.readAsDataURL(f);});const r=await request('/api/asset',{method:'POST',body:JSON.stringify({base64:data})});checkpointConfig();current().caseImage=r.url;changed('更换机箱素材');toast('机箱图已更新，保持原图比例');}catch(err){toast(err.message);}e.target.value='';};
 posterEditor=bindPosterEditor({previewResolutionChanged:schedulePreview,current:()=>posterEditorConfig(current()),checkpoint:()=>checkpointConfig(),changed,imageChanged:message=>changed(message,[active],true),transformChanged:message=>changed(message,[active],'layout'),toast,uploadImage,openDialog,closeDialog,allowLocalUpload:!nasMain||nasWorkspace.canUpload(),pickGallery:onPick=>nasMain&&!nasWorkspace.canManage()?pickNasImage(onPick):openGallery(true,onPick)});
 mountWorkspaceResize($('.workspace'));
 previewNavigation=mountPreviewNavigation($('#preview-config-nav'),{current,configs:()=>available().filter(c=>isLegacyTemplateConfig(c)===isLegacyTemplateConfig(current())),activate:id=>{$('#poster-stage').inert=true;$('#poster-inspector').inert=true;activate(id);}});
 const previewSide=$('.preview-side'),previewExpand=$('#preview-expand');
 const expandPreview=expanded=>{
  if(previewSide.classList.contains('preview-expanded')===expanded)return;
  previewSide.classList.toggle('preview-expanded',expanded);
  previewExpand.textContent=expanded?'收起编辑':'自由编辑';
  previewExpand.setAttribute('aria-expanded',String(expanded));
  if(!expanded)updateOverviewPreviewButtons();
  // 点击收起和按 Esc 都重新渲染恢复后的预览版式。
  schedulePreview();
 };
 previewExpand.onclick=()=>expandPreview(!previewSide.classList.contains('preview-expanded'));
 for(const button of $$('[data-ov-preview]'))button.onclick=()=>{
  const mode=button.dataset.ovPreview;
  if(mode==='long'){setOverviewPreviewLayout('long');return;}
  exportSkuMode.value=mode;
  // 从“仅配置图”进入 SKU 预览时，恢复可见的 SKU 导出选项。
  if(exportKind.value==='long'){
   exportKind.value='square';
   skuChoice.classList.remove('hidden');
  }
  setOverviewPreviewLayout('square');
 };
 $('#ov-preview-enlarge').onclick=()=>{
  if(previewBusy||previewConfigId!==current()?.id||!$('#poster').width)return toast('请等当前配置图生成完成');
  const image=$('#poster').toDataURL('image/png');
  openDialog('出图预览','<img class="ov-expanded-poster" alt="当前配置图" src="'+image+'">');
 };
 $('#ov-preview-copy').onclick=async()=>{
  const c=current();if(!c)return;
  const upgrade=posterModules(c).some(module=>module.type==='addons'&&module.visible!==false);
  const text=[c.name+' · '+c.version+' · '+(c.shortName||c.name),...posterParts(c).flatMap(part=>{
   const addon=upgrade?partUpgradeText(part,c):'';
   const count=part.qty>1&&!isSpecialComponent(part)?' ×'+part.qty:'';
   return [part.slot+'\t'+part.name+count,...(addon?['\t'+addon]:[])];
  })].join('\n');
  try{await navigator.clipboard.writeText(text);toast('已复制当前配置清单');}
  catch{toast('无法访问剪贴板，请重试');}
 };window.addEventListener('keydown',e=>{if(e.key==='Escape'){expandPreview(false);document.querySelectorAll('.action-menu[open]').forEach(el=>el.open=false);}});
 $$('[data-nav]').forEach(b=>b.onclick=async()=>{if(b.dataset.nav==='gallery')openGallery();else if(b.dataset.nav==='cost-source')openCosts();else if(b.dataset.nav==='source')openSources();else if(b.dataset.nav==='templates')openTemplates();else if(b.dataset.nav==='configs'){if(!leaveInventoryPage()||!leaveSourceSheet())return;await globalThis.workbenchPriceProfitView?.hide();$('#config-list').scrollIntoView({block:'nearest'});}else if(b.dataset.nav==='exports')openDialog('图片与导出',`<p class="hint">已勾选 ${selected.size} 套。保存配置后，详情图默认 1000px、方图默认 1400px，图片自动保存到本机；也可在右侧导出指定宽度的 PNG 或 ZIP。</p>${[...imageRecords].map(([id,r])=>`<div class="list-card"><span>${esc(state.configs.find(c=>c.id===id)?.name)} · r${r.revision}</span><a href="${esc(globalThis.resolveWorkbenchAsset?.(r.url)||r.url)}" target="_blank">查看图片</a></div>`).join('')||'<p class="hint">暂无本次会话生成的图片，点击“保存配置”开始生成。</p>'}`);else if(b.dataset.nav==='logs')showActivity().catch(e=>toast(e.message));});
 new ResizeObserver(()=>$$('textarea[data-part-name]').forEach(fitPartText)).observe($('#editor'));
 window.addEventListener('beforeunload',e=>{if(window.workbenchHasPendingChanges()){e.preventDefault();e.returnValue='';}});
}
const openShopSettings=nasMain?openShopSettingsFull:fullAction(openShopSettingsFull);
const openCopy=nasMain?nasScopeAction(openCopyFull,(configs=chosen())=>configs):fullAction(openCopyFull);
const openIds=nasMain?openIdsFull:fullAction(openIdsFull);
const openBatchStyle=nasMain?openBatchStyleFull:fullAction(openBatchStyleFull);
const removeConfigurations=nasMain?archiveNasConfigs:fullAction(removeConfigurationsFull);
const openDeletedConfigs=openConfigRecycle;
const openProduct=nasMain?(...args)=>nasWorkspace.canPlan()?openProductFull(...args):toast('当前 NAS 服务未开放商品维护。'):fullAction(openProductFull);
const openNameFormats=nasMain?nasScopeAction(openNameFormatsFull,()=>chosen().length?chosen():[current()].filter(Boolean)):fullAction(openNameFormatsFull);
const openSaveProductTemplate=nasMain?openNasSaveProductTemplate:fullAction(openSaveProductTemplateFull);
const openCopyToShop=fullAction(openCopyToShopFull);
const openOverview=nasMain?nasScopeAction(openOverviewFull,()=>currentProduct()?.configs||[]):fullAction(openOverviewFull);
const openMaintenancePrices=nasMain?nasScopeAction(openNasMaintenancePrices,()=>currentProduct()?.configs||[]):fullAction(openMaintenancePricesFull);
const openTemplates=nasMain?async()=>{try{await loadNasCatalog('templates');openTemplatesFull();}catch(error){toast(nasErrorText(error));}}:fullAction(openTemplatesFull);
const batchExport=nasMain?async()=>{
 const ids=chosen().map(c=>c.id);
 if(!ids.length)return toast('请先选择要导出的配置');
 try{for(const id of ids)await loadDetail(id);await batchExportFull();}catch(error){toast(nasErrorText(error));}
}:fullAction(batchExportFull);
const openStockCheck=nasMain?()=>openStockCheckFull():fullAction(()=>openStockCheckFull());
const openSources=nasMain?openNasSources:fullAction(openSourcesFull);
/** 从配件行进入维护：来源 ID 优先；没有来源 ID 才使用唯一商品 ID 或名称，歧义时停止。 */
async function openPartSource(id,slot){
 const config=state.configs.find(row=>row.id===id&&!row.deletedAt&&row.shopId===activeShopId);
 if(!config)throw Error('配置已变化，请重新选择');
 const part=config.parts.find(row=>row.slot===slot),actual=actualParts(config).find(row=>row.slot===slot);
 // 实际配件可以和展示型号不同，ERP 新建后应维护这一行实际采用的货号。
 const reference=actual?.sourceId||actual?.goodsId||actual?.name?actual:part;
 const rows=currentCatalog().filter(row=>!row.deletedAt);
 const matches=reference?.sourceId?rows.filter(row=>row.sourceId===reference.sourceId):reference?.goodsId?
  rows.filter(row=>row.goodsId===reference.goodsId):rows.filter(row=>row.name===reference?.name);
 if(matches.length!==1)throw Error(matches.length?'这个配件对应多个输出源，请在输出源维护中核对。':'当前配件没有可维护的输出源，请先选择输出源配件。');
 return openSources({focusSourceId:matches[0].sourceId,quickEdit:true});
}
const openUpgradeDescriptions=nasMain?nasScopeAction(openUpgradeDescriptionsFull,local=>local?currentProduct()?.configs||[]:ordinaryAvailable()):fullAction(openUpgradeDescriptionsFull);
const openLinkPartsDialog=nasMain?nasScopeAction(openLinkPartsDialogFull,()=>currentProduct()?.configs||[]):fullAction(openLinkPartsDialogFull);
const openGlobalParts=nasMain?nasScopeAction(openGlobalPartsFull):fullAction(openGlobalPartsFull);
const openCosts=nasMain?openNasCosts:fullAction(openCostsFull);
const openGallery=nasMain?openNasGallery:fullAction(openGalleryFull);
const setPosterView=nasMain?async view=>{
 const c=current();if(!c||nasEditorLocked())return;
 if(isLegacyTemplateConfig(c)||c.fixedInitialFormat){
  checkpointConfig();applyPosterView([c],view);posterEditor?.clear();normalizePosterDesign(c);updateSkuControls();changed('修改当前配置图样式',[c.id],'asset');return;
 }
 try{
  if(sameNasDocument(currentSettings().posterView,view))return;
  if(nasWorkspace.drafts().some(row=>row.pending))throw Error('请先处理待确认的配置保存。');
  if(!confirm('将此版式设为本店的日常配置图视图？'))return;
  await saveNasSettings({posterView:view});
  // 持久化一个店铺视图，按需显示，不为切换视图批量改写整店配置正文。
  for(const row of state.configs)if(!isLegacyTemplateConfig(row)&&!row.fixedInitialFormat)
   nasWorkspace.applyPresentation(row,document=>applyPosterView([document],view));
  posterEditor?.clear();renderAll();toast('本店日常配置已统一视图');
 }catch(error){toast(nasErrorText(error));}
 finally{if(current()){$('#layout').value=current().layout;updateSkuControls();}}
}:fullAction(setPosterViewFull);
continuousWorkbench=reactWorkbench.continuousAvailable?createContinuousWorkbench({
 current,available,cardAvailable:()=>ordinaryConfigs(liveConfigs(listConfigs())),configs:()=>state.configs,
 // 总表和价格页都按目标配置所属店铺取有效成本，避免换件重新带入来源旧价。
 catalog:shopId=>sourcesFor(state,shopId||activeShopId).filter(row=>!row.deletedAt),
 costs:()=>state.costSource||[],settings:shopId=>shopId?settingsFor(state,shopId):currentPricingSettings(),selected:()=>selected,
 configurationBenefits,errorText:error=>nasErrorText(error,listConfigs()),
 // 总表工具栏复用现有撤销和重做栈。
 canUndo:()=>history.length>0,canRedo:()=>redoHistory.length>0,
 undo:()=>$('#undo').click(),redo:()=>$('#redo').click(),
 // 源记录也可能原位更新，用内容版本保证换店、库存同步和维护后立即失效。
 catalogVersion:()=>JSON.stringify([activeShopId,state.sourceCatalog,state.costSource]),
 select:(id,value)=>{if(value)selected.add(id);else selected.delete(id);renderList();},
 load:loadDetail,loadScope:loadNasScope,restoreTaxes:restoreOverviewTaxes,activate,tab:value=>{if(value)switchTab(value);return tab;},toast,
 editSource:openPartSource,
 erpSearch:findErpCandidates,adoptErp:adoptErpCandidate,
 update:(id,mutate,message,independent=false)=>{const c=state.configs.find(c=>c.id===id&&!c.deletedAt&&(!nasMain||c.shopId===activeShopId));if(!c)throw Error('配置已变化，请重新选择');if(nasMain&&(nasBusy||!nasWorkspace.canWrite()||nasWorkspace.pending(id)))throw Error('请等待配置保存或回执查询完成');const next=clone(c);mutate(next);checkpointConfig([id]);Object.assign(c,next);if(independent)rememberDisplayParts([id]);changed(message,[id]);},
 updateMany:async(ids,mutate,message)=>{
  // 整链编辑先在副本上完成，再通过原草稿与撤销流程提交。
  await loadNasScope(ids);
  const seed=state.configs.find(c=>c.id===ids[0]),targets=ids.map(id=>state.configs.find(c=>c.id===id&&!c.deletedAt&&c.shopId===seed?.shopId&&c.productId===seed?.productId));
  if(targets.some(c=>!c))throw Error('当前链接已变化');
  if(nasMain&&(nasBusy||!nasWorkspace.canWrite()||ids.some(id=>nasWorkspace.pending(id))))throw Error('请等待配置保存或回执查询完成');
  const replacements=targets.map(c=>{const copy=clone(c);mutate(copy);return copy;});
  checkpointConfig(ids);targets.forEach((c,i)=>Object.assign(c,replacements[i]));changed(message,ids,false,null,true);
 },
 // 11-19：总表每套配置下方的「复制当前配置」「插入空白配置」，都插在这一套后面。
 duplicate:id=>{if(nasMain)return duplicateNasConfig(id);return fullAction(()=>{const src=state.configs.find(c=>c.id===id&&!c.deletedAt);if(!src)throw Error('配置已变化');const capacityError=configCapacityMessage(state.configs,activeShopId,1);if(capacityError)return toast(capacityError);checkpoint();const c=clone(src);c.id=crypto.randomUUID();c.name+=' · 副本';c.skuId='';state.configs=insertConfigAfter(state.configs,id,c);selected.add(c.id);changed('复制配置',[c.id]);renderAll();toast('已复制，插在「'+src.name+'」后面');})();},
 remove:id=>{const c=state.configs.find(x=>x.id===id&&!x.deletedAt);if(!c)throw Error('配置已变化');return Promise.resolve(nasMain?archiveNasConfigs([id],null,{selectAfterRemoval:true}):removeConfigurations([id])).catch(()=>{});},
 insertBlank:id=>{const src=state.configs.find(c=>c.id===id&&!c.deletedAt);if(!src)throw Error('配置已变化');const product=productGroups(available()).find(g=>g.id===src.productId);if(nasMain)return addNasToProduct(product,false,id);return fullAction(()=>{const capacityError=configCapacityMessage(state.configs,activeShopId,1);if(capacityError)return toast(capacityError);checkpoint();const c=blankConfig(src,product,'配置'+(product.configs.length+1),defaultServiceText(state,activeShopId));state.configs=insertConfigAfter(state.configs,id,c);changed('插入空白配置',[c.id]);renderAll();toast('已插入空白配置');})();},
 // 全局（三店）预览前先载入完整工作区，否则只数得到已打开的链接。
 applyUpgrade:(id,slot,scope)=>nasMain?openUpgradeScope(id,slot,scope):scope==='all'?fullAction(()=>openUpgradeScope(id,slot,scope))().catch(()=>{}):openUpgradeScope(id,slot,scope),
 applyGlobalTax:(goodsId,value,name,restore)=>openGlobalTax(goodsId,value,name,restore),
 render:(container,model)=>reactWorkbench.continuous(container,model),renderCard:(container,model)=>reactWorkbench.configCard(container,model),release:container=>reactWorkbench.release(container)
}):null;
try{const [index,base,memberSession]=await Promise.all([lazyWorkspace.refresh(),request('/catalog.json'),request('/api/session')]);session=memberSession;operator=localStorage.getItem('diy-operator')||session.defaultOperator;baseCatalog=base;const initialState=await prepareWorkspaceState({...index.metadata,configs:[],revision:index.revision,updatedAt:index.updatedAt},baseCatalog);state=markPartialWorkspace(initialState.state);acceptedState=cloneEditorState(state);catalog=initialState.catalog;const remembered=nasMain?nasWorkspace.shop():localStorage.getItem('diy-active-shop');activeShopId=shops.some(shop=>shop.id===remembered)?remembered:'intel';active=null;selected.clear();productGroups(available()).forEach(p=>collapsedProducts.add(p.id));bind();if(nasMain)bindNasMain();renderAll();window.workbenchReady=true;installColorPicker({current,checkpoint:()=>checkpointConfig()});if(!nasMain)workspaceSyncUi=await bindWorkspaceSync({renderPanel:model=>reactWorkbench.dialog($('#dialog-body'),'workspace-sync',model),getState:()=>state,flush:save,openDialog,esc,toast,onMember:member=>{if(member){operator=member.name;$('#operator-open').textContent='成员：'+operator;$('#operator-open').disabled=false;$('#operator-open').title='账号管理：切换账号或退出登录';}else {$('#operator-open').textContent='请登录';$('#operator-open').disabled=false;}},receive:async()=>{if(!fullWorkspace)return refreshCompactWorkspace();if(dirty||savePromise||hasDraftDialog()||document.activeElement?.matches('input,textarea,select'))return false;const counter=changeCounter;const next=await request('/api/state?logs=none');if(counter!==changeCounter||dirty||savePromise)return false;if(next.revision===state.revision)return;const prepared=await prepareWorkspaceState(next,baseCatalog);if(counter!==changeCounter||dirty||savePromise||hasDraftDialog()||document.activeElement?.matches('input,textarea,select'))return false;state=prepared.state;acceptedState=next;catalog=prepared.catalog;if(!current())active=ordinaryConfigs(available())[0]?.id||null;selected=new Set([...selected].filter(id=>available().some(c=>c.id===id)));history=[];redoHistory=[];imageRecords.clear();syncHistoryButtons();renderAll();}});if(nasMain)syncNasControls();else $('#save-status').textContent=state.updatedAt?'已载入本地保存':'已载入本机配置';pollDerivedStatus().catch(()=>{});}catch(e){$('#save-status').textContent=e.status===404?'需要重启工作台服务':'载入失败';if(e.status===404)$('#config-heading').textContent='请重启工作台以完成更新';$('#editor').innerHTML=`<p class="error">${esc(e.status===404?'工作台已更新，请双击 prototype 文件夹中的「重启原型.cmd」，然后刷新页面。':e.message)}</p>`;}

// Agent 与人工操作共用同一编辑器；有未保存输入时拒绝任务，不代替用户保存草稿。
if(nasMain){window.workbenchAgentActor=nasWorkspace.agentActor;window.workbenchAgentShop=nasWorkspace.shop;}
window.workbenchAgentExecute=nasMain?createNasAgentWorkflow({
 access:nasWorkspace.agentAccess,indexes:nasWorkspace.agentIndexes,activeShop:()=>activeShopId,
 // 来源写入在各新步骤前核对未保存资料，恢复任务可先读取已发出步骤的正式回执。
 sourceHasPending:()=>Boolean(window.workbenchSourceEditor?.hasPending()),
 readErp:(kind,ids,shop)=>nasWorkspace.readErp(kind,ids,undefined,shop),
 blocked:method=>!window.workbenchReady||nasBusy||!!nasDraftFailure||detailLoads.size>0||exportJobs>0||
  (hasDraftDialog()&&!(method==='sources.apply'&&window.workbenchSourceEditor?.sheet))||
  (method!=='sources.apply'&&!!window.workbenchSourceEditor?.hasPending())||Boolean(window.parent.workbenchClosePending||window.parent.workbenchUpdatePending),
 lock:()=>{
  const release=lockAgentEditor(true);nasBusy=true;syncNasControls();
  return()=>{nasBusy=false;release();syncNasControls();};
 },
 refresh:async(shop,receipt,{sources=false}={})=>{
  if(shop!==activeShopId)return false;
  // 重载已确认配置；全店刷新时保留正在编辑的本机草稿。
  await acceptNasPlan(receipt?{kind:'configurations',batches:[{status:'done',result:receipt}]}:{kind:'costs',batches:[]});
  const sheet=window.workbenchSourceEditor;
  if(sources&&sheet?.sheet)return sheet.refreshSaved();
  return true;
 },
 present:(rows,metadata,shop)=>{
  const costs=new Map(metadata.costSource.map(row=>[row.goodsId,row]));
  const sources=nasWorkspace.hasSharedSources()?new Map(metadata.sourceCatalog.map(row=>[row.sourceId,row])):null;
  const inputs=addonPackInputs(sourcesFor(metadata,shop),metadata.costSource);
  return rows.map(row=>{
   const config=presentNasConfig(row.document,visibleNasAddons(row.effective_addons,row.document.addons),costs,sources,metadata.shopSettings[shop]);
   return appendAddonPackText(config,addonPackRows(config,metadata.shopSettings[shop]?.addonPacks??[],inputs));
  });
 },
 render:(config,width)=>imageRenderGate.run(({beforeDraw})=>drawPoster(config,width,{beforeDraw})),
 native:(action,payload)=>window.workbenchAgentNative(action,payload)
}):createAgentWorkflow({
 state:()=>state,
 savedState:()=>acceptedState,
 blocked:()=>!!window.workbenchMaintenancePromise||!window.workbenchReady||workspaceLoad||fullActionBusy||detailLoads.size>0||dirty||savePromise||ordinaryPending||batchPromise||batchPending||conflict||Boolean($('#dialog')?.open)||Boolean(window.workbenchSourceEditor?.hasPending())||Boolean(workspaceSyncUi?.status().running)||Boolean(window.parent.workbenchClosePending||window.parent.workbenchUpdatePending),
 load:ensureFullWorkspace,
 lock:lockAgentEditor,
 apply:(plan,operationId,baseline)=>applyBatchChanges(plan,'Agent 修改配置',{operationId,baseline}),
 resumePending:job=>{
  const pending=batchPending;
  if(job?.method!=='changes.apply'||!pending?.agent||job.params?.operationId!==pending.payload.operationId)return null;
  if(!window.workbenchReady||workspaceLoad||fullActionBusy||detailLoads.size>0||savePromise||ordinaryPending||batchPromise||conflict||$('#dialog')?.open||window.workbenchSourceEditor?.hasPending()||workspaceSyncUi?.status().running||window.parent.workbenchClosePending||window.parent.workbenchUpdatePending)return null;
  // 后续输入、撤销或不同预览均不能借原 operationId 自动保存当前人工草稿。
  if(changeCounter!==pending.agent.counter||!sameEditingState(state,pending.sent)||JSON.stringify(job.params.plan)!==JSON.stringify(pending.agent.plan))return null;
  return async()=>{dirty=false;return {receipt:await sendBatchPending(),baseline:pending.agent.baseline};};
 },
 sync:()=>workspaceSyncUi.runAgent(),
 native:(action,payload)=>window.workbenchAgentNative(action,payload)
});

// 按方图/长图和 SKU 模式更新相关控件的可见性与可用状态。
function updateSkuControls(){
 const c=current(),square=c?.layout==='square',style=skuImageMode(c),padded=square&&style==='padded';
 // 导出选择是右栏的会话状态，翻看配置时保留。顶部高亮重新读取当前配置的默认样式。
 updateOverviewPreviewButtons();
 $('#sku-mode').classList.toggle('hidden',!square);
 $('#sku-mode').value=style;
 $('#sku-mode-hint').classList.toggle('hidden',!padded);
 $('#poster-auto-width').disabled=square;
 $('.canvas-tools').classList.toggle('hidden',padded);
 $('.preview-quick-actions').classList.toggle('hidden',square);
}

// 应用店铺或模板图片视图设置，并标记相应配置需要保存。
function setPosterViewFull(view){checkpoint();const legacy=isLegacyTemplateConfig(current());if(!legacy)currentSettings().posterView=view;const ids=applyPosterView(legacy?[current()]:ordinaryAvailable(),view);posterEditor?.clear();normalizePosterDesign(current());updateSkuControls();changed(legacy?'修改主机模板视图':'统一本店配置图视图',ids,'asset');toast(legacy?'当前主机模板已切换视图':'本店日常配置已统一视图');}
