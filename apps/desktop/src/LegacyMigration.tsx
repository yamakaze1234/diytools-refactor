/** 旧数据迁移审阅页：查看配置、配件和导入差异，确认后通过本机迁移接口应用。 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { configName, filterConfigs, groupConfigs, isAbsoluteBundlePath, isDeleted, PAGE_SIZE, pageItems, textValue, validName } from "./migration-model";
import type { ImportedDetail, ImportedSummary, ImportPreview, ImportResult, JsonValue, LegacyConfig } from "./migration-model";
import "./migration.css";

type Pending = { kind: "workspace" | "shop" | "link" | "config"; id: string } | { kind: "discard" | "reload" };
/** 以只读列表展示迁移配置中的配件字段。 */
function Parts({ value, title }: { value: JsonValue | undefined; title: string }) {
  const [page, setPage] = useState(0);
  if (!Array.isArray(value)) return <section className="migration-parts"><h2>{title} · 只读</h2><p className="empty">{value === undefined ? "原数据未提供此字段，不从另一套配件补齐。" : value === null ? "原数据为 null，不从另一套配件补齐。" : `原始字段不是数组：${textValue(value)}`}</p></section>;
  return <section className="migration-parts"><div className="parts-heading"><h2>{title} · {value.length} 项</h2><span>按原始顺序 · 只读</span></div>{!value.length ? <p className="empty">原数据明确为空数组。</p> : <><div className="parts-scroll"><table><thead><tr><th>序号</th><th>原始配件字段</th></tr></thead><tbody>{pageItems(value, page).map((part, index) => <tr key={page * PAGE_SIZE + index}><td>{page * PAGE_SIZE + index + 1}</td><td>{part && typeof part === "object" && !Array.isArray(part) ? <dl className="migration-part-fields">{Object.entries(part).map(([key, field]) => <div key={key}><dt>{key}</dt><dd>{textValue(field)}</dd></div>)}</dl> : textValue(part)}</td></tr>)}</tbody></table></div><Pager count={value.length} page={page} setPage={setPage} /></>}</section>;
}
/** 为迁移审阅列表提供分页，避免一次渲染全量配置。 */
function Pager({ count, page, setPage }: { count: number; page: number; setPage: (page: number) => void }) {
  if (count <= PAGE_SIZE) return null;
  return <div className="migration-pager"><button className="secondary" disabled={page === 0} onClick={() => setPage(page - 1)}>上一页</button><span>{page + 1} / {Math.ceil(count / PAGE_SIZE)}</span><button className="secondary" disabled={(page + 1) * PAGE_SIZE >= count} onClick={() => setPage(page + 1)}>下一页</button></div>;
}
/** 维护迁移预览和确认状态，将尚未完成的操作反馈给宿主退出保护。 */
export default function LegacyMigration({ onDirty }: { onDirty: (blocked: boolean) => void }) {
  const desktop = isTauri();
  const [workspaces, setWorkspaces] = useState<ImportedSummary[]>([]);
  const [detail, setDetail] = useState<ImportedDetail | null>(null);
  const [configId, setConfigId] = useState<string | null>(null);
  const [shopKey, setShopKey] = useState("");
  const [linkKey, setLinkKey] = useState("");
  const [draftName, setDraftName] = useState("");
  const [path, setPath] = useState("");
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(desktop);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [search, setSearch] = useState("");
  const [groupSearch, setGroupSearch] = useState("");
  const [page, setPage] = useState(0);
  const [pending, setPending] = useState<Pending | null>(null);
  const [undoPending, setUndoPending] = useState(false);
  const mounted = useRef(true);
  const busyRef = useRef(desktop);
  const groups = useMemo(() => groupConfigs(detail?.state.configs ?? []), [detail]);
  const shop = groups.find(item => item.key === shopKey);
  const link = shop?.links.find(item => item.key === linkKey);
  const config = detail?.state.configs.find(item => item.id === configId);
  const dirty = !!config && draftName !== configName(config);
  const blocked = busy || dirty || !!pending || undoPending;
  const blockedRef = useRef(blocked);
  blockedRef.current = blocked;
  const interactionLocked = busy || !!pending || undoPending;
  useEffect(() => { onDirty(blocked); }, [blocked, onDirty]);
  function startOperation() { if (busyRef.current || !desktop) return false; busyRef.current = true; blockedRef.current = true; setBusy(true); setError(""); setMessage(""); return true; }
  function finishOperation() { busyRef.current = false; if (mounted.current) setBusy(false); }
  const accept = useCallback((result: ImportedDetail, preferredId?: string | null) => {
    const nextGroups = groupConfigs(result.state.configs);
    const target = result.state.configs.find(item => item.id === preferredId) ?? result.state.configs.find(item => !isDeleted(item)) ?? result.state.configs[0];
    const nextShop = nextGroups.find(item => item.links.some(group => group.configs.some(row => row.id === target?.id)));
    const nextLink = nextShop?.links.find(item => item.configs.some(row => row.id === target?.id));
    setDetail(result); setConfigId(target?.id ?? null); setDraftName(target ? configName(target) : ""); setShopKey(nextShop?.key ?? ""); setLinkKey(nextLink?.key ?? ""); setSearch(""); setGroupSearch(""); setPage(0);
  }, []);
  useEffect(() => {
    mounted.current = true;
    let cancelled = false;
    if (desktop) void (async () => {
      try {
        const rows = await invoke<ImportedSummary[]>("list_imported_workspaces");
        const first = rows.length ? await invoke<ImportedDetail>("get_imported_workspace", { workspaceId: rows[0].id }) : null;
        if (!cancelled) { setWorkspaces(rows); if (first) accept(first); }
      } catch (reason) { if (!cancelled) setError(String(reason)); }
      finally { if (!cancelled) finishOperation(); }
    })();
    return () => { cancelled = true; mounted.current = false; };
  }, [desktop, accept]);
  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => { if (blockedRef.current || busyRef.current) { event.preventDefault(); event.returnValue = ""; } };
    window.addEventListener("beforeunload", beforeUnload);
    let disposed = false;
    let cleanup: (() => void) | undefined;
    if (desktop) void getCurrentWindow().onCloseRequested(event => {
      if (blockedRef.current || busyRef.current) { event.preventDefault(); setError("有未保存名称、待确认操作或操作正在进行。请先完成或取消，再关闭窗口。"); }
    }).then(unlisten => { if (disposed) unlisten(); else cleanup = unlisten; }).catch(reason => setError(`关闭保护未启用：${String(reason)}`));
    return () => { disposed = true; cleanup?.(); window.removeEventListener("beforeunload", beforeUnload); };
  }, [desktop]);
  async function load(workspaceId: string) {
    if (!startOperation()) return;
    try { const result = await invoke<ImportedDetail>("get_imported_workspace", { workspaceId }); if (mounted.current) accept(result, detail?.id === workspaceId ? configId : null); }
    catch (reason) { setError(String(reason)); }
    finally { finishOperation(); }
  }
  async function refreshWorkspaces() {
    if (dirty || !startOperation()) return;
    try {
      const rows = await invoke<ImportedSummary[]>("list_imported_workspaces"); setWorkspaces(rows);
      if (!detail && rows.length) accept(await invoke<ImportedDetail>("get_imported_workspace", { workspaceId: rows[0].id }));
    } catch (reason) { setError(String(reason)); }
    finally { finishOperation(); }
  }
  function pickConfig(target?: LegacyConfig) { setConfigId(target?.id ?? null); setDraftName(target ? configName(target) : ""); setError(""); setMessage(""); }
  function perform(action: Pending) {
    if (action.kind === "workspace") { void load(action.id); return; }
    if (action.kind === "reload") { if (detail) void load(detail.id); return; }
    if (action.kind === "discard") { setDraftName(config ? configName(config) : ""); setMessage("已放弃未保存的名称修改。"); return; }
    if (action.kind === "config") { pickConfig(detail?.state.configs.find(item => item.id === action.id)); return; }
    if (action.kind === "shop") {
      const target = groups.find(item => item.key === action.id); setShopKey(action.id); setLinkKey(target?.links[0]?.key ?? ""); pickConfig(target?.links[0]?.configs[0]);
    } else if (action.kind === "link") { const target = shop?.links.find(item => item.key === action.id); setLinkKey(action.id); pickConfig(target?.configs[0]); }
    setSearch(""); setPage(0);
  }
  function select(action: Pending) { if (busyRef.current || pending || undoPending) return; if (dirty) setPending(action); else perform(action); }
  async function previewImport() {
    if (!isAbsoluteBundlePath(path.trim())) { setError("请输入 JSON bundle 文件的绝对路径。"); return; }
    if (!startOperation()) return;
    setPreview(null); setConfirmed(false);
    try { setPreview(await invoke<ImportPreview>("preview_legacy_import", { path: path.trim() })); }
    catch (reason) { setError(String(reason)); }
    finally { finishOperation(); }
  }
  async function importBundle() {
    if (!preview || !confirmed || dirty || !startOperation()) return;
    let applied = false;
    try {
      const result = await invoke<ImportResult>("apply_legacy_import", { path: path.trim(), expectedToken: preview.token });
      applied = true;
      setConfirmed(false); setPreview(null);
      setMessage(result.alreadyImported ? "此 bundle 已导入；已打开现有工作区，保留后来保存的修改。" : "已导入独立迁移数据库。");
      const rows = await invoke<ImportedSummary[]>("list_imported_workspaces"); setWorkspaces(rows);
      accept(await invoke<ImportedDetail>("get_imported_workspace", { workspaceId: result.workspaceId }));
    } catch (reason) { setError(applied ? `导入已完成，但显示刷新失败：${String(reason)}。请刷新工作区列表后打开。` : String(reason)); }
    finally { finishOperation(); }
  }
  async function save() {
    if (!detail || !config || isDeleted(config) || !dirty || !validName(draftName)) { setError("配置名称需要 1–120 个字符，草稿仍保留。"); return; }
    if (!startOperation()) return;
    try { accept(await invoke<ImportedDetail>("rename_imported_config", { workspaceId: detail.id, configId: config.id, name: draftName, expectedRevision: detail.revision }), config.id); setMessage("名称已保存到本机。重新读取或重开应用可核对结果。"); }
    catch (reason) { setError(`保存失败，草稿仍保留：${String(reason)}`); }
    finally { finishOperation(); }
  }
  async function undo() {
    if (!detail || dirty || !detail.undoCount || !startOperation()) return;
    setUndoPending(false);
    try { accept(await invoke<ImportedDetail>("undo_imported_workspace", { workspaceId: detail.id, expectedRevision: detail.revision }), configId); setMessage("已撤销本工作区最近一次名称保存，恢复结果已写入本机。"); }
    catch (reason) { setError(String(reason)); }
    finally { finishOperation(); }
  }
  const visible = filterConfigs(link?.configs ?? [], search);
  const visibleGroups = groups.filter(item => `${item.label} ${item.links.map(row => row.label).join(" ")}`.toLocaleLowerCase().includes(groupSearch.trim().toLocaleLowerCase()));
  const visibleLinks = shop?.links.filter(item => item.label.toLocaleLowerCase().includes(groupSearch.trim().toLocaleLowerCase())) ?? [];
  return <div className="migration-workspace">
    <section className="migration-intro"><p className="eyebrow">本地迁移 / 试运行</p><h1>迁移工作区</h1><p>当前仅支持名称修改与撤销。配件只读，图片尚未迁移，暂不支持全量业务功能。ERP 状态未知，未接入。</p></section>
    {!desktop && <p className="notice">浏览器仅展示入口说明。预览、导入、保存和撤销需在桌面窗口执行。</p>}
    <div aria-live="polite">{error && <p className="notice error" role="alert">{error}</p>}{message && <p className="notice success">{message}</p>}</div>
    <section className="migration-import"><h2>导入 JSON bundle</h2><label>文件绝对路径<input value={path} placeholder="例如 D:\\diytools\\sandbox\\synthetic\\bundle.json" disabled={!desktop || interactionLocked || dirty} onChange={event => { setPath(event.target.value); setPreview(null); setConfirmed(false); setError(""); }} /></label><button disabled={!desktop || interactionLocked || dirty || !path.trim()} onClick={() => void previewImport()}>只读预览</button><p className="empty">先使用迁移脚本生成 bundle，再输入路径。预览不会创建迁移工作区。单个 bundle 上限 64 MiB。</p>
      {preview && <div className="migration-preview"><dl><div><dt>来源</dt><dd>{preview.sourceLabel}</dd></div><div><dt>配置</dt><dd>总计 {preview.configCount} · 活跃 {preview.activeCount} · 店铺 {preview.shopCount}</dd></div></dl><h3>检查问题 · {preview.issues.length} 项</h3>{preview.issues.length ? <ul className="migration-issues">{preview.issues.map((issue, index) => <li key={index}>{issue}</li>)}</ul> : <p className="empty">预览未报告问题。</p>}<label className="migration-confirm"><input type="checkbox" checked={confirmed} disabled={interactionLocked || dirty} onChange={event => setConfirmed(event.target.checked)} />确认将此预览导入独立迁移工作区</label><button disabled={!desktop || interactionLocked || dirty || !confirmed} onClick={() => void importBundle()}>确认导入</button></div>}
    </section>
    {pending && <div className="confirm-panel" role="alert"><p>当前名称尚未保存。放弃草稿后继续？</p><button className="secondary" onClick={() => setPending(null)}>继续编辑</button><button onClick={() => { const action = pending; setPending(null); perform(action); }}>放弃并继续</button></div>}
    {undoPending && <div className="confirm-panel" role="alert"><p>将撤销此工作区最近一次名称保存，恢复结果立即写入本机；可能影响其他配置。</p><button className="secondary" onClick={() => setUndoPending(false)}>取消</button><button onClick={() => void undo()}>确认撤销</button></div>}
    <div className="migration-layout"><aside className="config-sidebar"><h2>已导入工作区 · {workspaces.length}</h2><button className="text-button" disabled={!desktop || interactionLocked || dirty} onClick={() => void refreshWorkspaces()}>刷新工作区列表</button><label className="search-label">工作区<select value={detail?.id ?? ""} disabled={!desktop || interactionLocked} onChange={event => select({ kind: "workspace", id: event.target.value })}><option value="" disabled>选择工作区</option>{workspaces.map(item => <option key={item.id} value={item.id}>{item.sourceLabel} · {item.configCount} 套 · {item.id}</option>)}</select></label>
      <label className="search-label">搜索店铺 / 商品链接 / SPU<input value={groupSearch} disabled={interactionLocked} onChange={event => setGroupSearch(event.target.value)} /></label>
      <label className="search-label">店铺<select value={shopKey} disabled={interactionLocked || !groups.length} onChange={event => select({ kind: "shop", id: event.target.value })}>{!visibleGroups.some(item => item.key === shopKey) && shop && <option value={shop.key}>{shop.label}（当前）</option>}{visibleGroups.map(item => <option key={item.key} value={item.key}>{item.label}</option>)}</select></label>
      <label className="search-label">商品链接<select value={linkKey} disabled={interactionLocked || !shop} onChange={event => select({ kind: "link", id: event.target.value })}>{!visibleLinks.some(item => item.key === linkKey) && link && <option value={link.key}>{link.label}（当前）</option>}{visibleLinks.map(item => <option key={item.key} value={item.key}>{item.label} · {item.configs.length} 套</option>)}</select></label>
      <label className="search-label">搜索配置<input value={search} disabled={interactionLocked} placeholder="名称 / ID / SKU / 商品" onChange={event => { setSearch(event.target.value); setPage(0); }} /></label>
      <p className="empty">本链接 {link?.configs.length ?? 0} 套 · 匹配 {visible.length} 套 · 含已删除记录</p><nav aria-label="迁移配置列表">{pageItems(visible, page).map(item => <button key={item.id} className={`config-item ${item.id === configId ? "selected" : ""}`} disabled={interactionLocked} aria-current={item.id === configId ? "true" : undefined} onClick={() => { if (item.id !== configId) select({ kind: "config", id: item.id }); }}><strong>{configName(item)}</strong><span>{isDeleted(item) ? "已删除 · 只读" : "活跃配置"} · {item.id}</span></button>)}</nav><Pager count={visible.length} page={page} setPage={next => { if (!interactionLocked) setPage(next); }} />{!visible.length && <p className="empty">{busy ? "正在读取…" : !workspaces.length ? "暂无迁移工作区。请先预览并导入 bundle。" : "没有匹配配置。"}</p>}
    </aside><section className="config-editor"><div className="editor-heading"><div><p className="eyebrow">{shop?.label ?? "尚未选择店铺"} / {link?.label ?? "尚未选择链接"}</p><h1>{config ? configName(config) : detail ? "此工作区没有配置" : "选择迁移工作区"}</h1></div><span className={`status ${dirty ? "pending" : "ready"}`}>{busy ? "处理中" : !desktop ? "入口说明" : dirty ? "名称未保存" : config ? isDeleted(config) ? "已删除 · 只读" : "本机已保存" : "未选择配置"}</span></div>
      {config && detail && <><fieldset disabled={!desktop || interactionLocked || isDeleted(config)}><label className="migration-name">配置名称<input value={draftName} onChange={event => { setDraftName(event.target.value); setMessage(""); }} /></label>{!validName(draftName) && <p className="empty" role="alert">配置名称需要 1–120 个字符，当前 {Array.from(draftName).length} 个；草稿仍保留。</p>}</fieldset><dl className="migration-metadata"><div><dt>配置 ID</dt><dd>{config.id}</dd></div><div><dt>SKU</dt><dd>{textValue(config.skuId)}</dd></div><div><dt>商品</dt><dd>{textValue(config.product)}</dd></div><div><dt>原始售价字段 price</dt><dd>{textValue(config.price)} · 只读</dd></div><div><dt>ERP 状态</dt><dd>未知 · 未接入</dd></div>{isDeleted(config) && <div><dt>删除标记 deletedAt</dt><dd>{textValue(config.deletedAt)}</dd></div>}</dl><div className="editor-actions"><div><button disabled={!desktop || interactionLocked || !dirty || isDeleted(config) || !validName(draftName)} onClick={() => void save()}>保存名称</button><button className="secondary" disabled={interactionLocked || !dirty} onClick={() => setPending({ kind: "discard" })}>放弃修改</button><button className="secondary" disabled={!desktop || interactionLocked || dirty || !detail.undoCount} onClick={() => setUndoPending(true)}>撤销最近一次保存</button></div><button className="text-button" disabled={!desktop || interactionLocked} onClick={() => select({ kind: "reload" })}>重新读取</button></div><p className="storage-note">本地版本 {detail.revision} · 本工作区可撤销 {detail.undoCount} 次 · 顺序与原始字段保留</p><Parts key={`${detail.id}:${config.id}:parts`} title="展示配件 parts" value={config.parts} /><Parts key={`${detail.id}:${config.id}:actual`} title="实际配件 actualParts" value={config.actualParts} /></>}
      {!config && <p className="empty">{busy ? "正在读取迁移数据…" : "空工作区也可以正常导入和重新读取。"}</p>}{detail && !config && <button className="secondary" disabled={interactionLocked || !desktop} onClick={() => void load(detail.id)}>重新读取工作区</button>}
    </section></div>
  </div>;
}





