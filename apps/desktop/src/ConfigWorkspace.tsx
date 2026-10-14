/** 独立配置工作区页面：查询配置、维护编辑草稿并执行本机保存。 */
import { useCallback, useEffect, useRef, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { fromDraft, money, parseCents, preview, toDraft } from "./config-model";
import type { Detail, Draft, DraftPart, Summary } from "./config-model";

/** 将列表与编辑表单状态关联，并把未保存状态通知宿主。 */
export default function ConfigWorkspace({ onDirty }: { onDirty: (dirty: boolean) => void }) {
  const desktop = isTauri();
  const [items, setItems] = useState<Summary[]>(desktop ? [] : [preview.config]);
  const [detail, setDetail] = useState<Detail | null>(desktop ? null : preview);
  const [draft, setDraft] = useState<Draft | null>(desktop ? null : toDraft(preview.config));
  const [busy, setBusy] = useState(desktop);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [search, setSearch] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const [undoPending, setUndoPending] = useState(false);
  const dirty = !!detail && !!draft && JSON.stringify(draft) !== JSON.stringify(toDraft(detail.config));
  const dirtyRef = useRef(false);
  dirtyRef.current = dirty || busy;
  useEffect(() => { onDirty(dirty || busy); }, [dirty, busy, onDirty]);
  const accept = useCallback((result: Detail) => {
    setDetail(result); setDraft(toDraft(result.config));
    setItems(previous => previous.map(item => item.id === result.config.id ? { id: result.config.id, name: result.config.name, salePriceCents: result.config.salePriceCents, revision: result.config.revision } : item));
  }, []);

  useEffect(() => {
    if (!desktop) return;
    let cancelled = false;
    void (async () => {
      try {
        const rows = await invoke<Summary[]>("list_configs");
        const first = rows.length ? await invoke<Detail>("get_config", { id: rows[0].id }) : null;
        if (!cancelled) { setItems(rows); if (first) accept(first); }
      } catch (reason) { if (!cancelled) setError(String(reason)); }
      finally { if (!cancelled) setBusy(false); }
    })();
    return () => { cancelled = true; };
  }, [desktop, accept]);

  useEffect(() => {
    if (!desktop) return;
    let cleanup: (() => void) | undefined;
    let disposed = false;
    void getCurrentWindow().onCloseRequested(event => {
      if (dirtyRef.current) {
        event.preventDefault();
        setError("当前有未保存修改或操作正在进行。请先保存、放弃修改或等待操作结束，再关闭窗口。");
      }
    }).then(unlisten => { if (disposed) unlisten(); else cleanup = unlisten; }).catch(reason => setError(`关闭保护未启用：${String(reason)}`));
    return () => { disposed = true; cleanup?.(); };
  }, [desktop]);

  async function load(id: string) {
    setBusy(true); setError(""); setMessage("");
    try { accept(await invoke<Detail>("get_config", { id })); }
    catch (reason) { setError(String(reason)); }
    finally { setBusy(false); }
  }
  function select(id: string) {
    if (id === detail?.config.id || busy || pending || undoPending) return;
    if (dirty) setPending(id); else void load(id);
  }
  async function save() {
    if (!draft || !detail || busy) return;
    setError(""); setMessage("");
    try {
      const config = fromDraft(draft, detail.config);
      setBusy(true);
      accept(await invoke<Detail>("save_config", { config }));
      setMessage("已保存到本机，关闭后重新打开仍会保留。");
    } catch (reason) { setError(String(reason)); }
    finally { setBusy(false); }
  }
  async function undo() {
    setUndoPending(false);
    if (!detail || busy || dirty) return;
    setBusy(true); setError(""); setMessage("");
    try {
      accept(await invoke<Detail>("undo_config", { id: detail.config.id, expectedRevision: detail.config.revision }));
      setMessage("已撤销上次保存，恢复结果已写入本机。");
    } catch (reason) { setError(String(reason)); }
    finally { setBusy(false); }
  }
  function partChange(index: number, field: keyof DraftPart, value: string) {
    if (!draft) return;
    setDraft({ ...draft, actualParts: draft.actualParts.map((p, i) => i === index ? { ...p, [field]: value } : p) });
    setMessage("");
  }
  const visible = items.filter(item => item.name.toLocaleLowerCase().includes(search.toLocaleLowerCase()));
  let total: number | null = null;
  try { if (draft) { total = draft.actualParts.reduce((sum, part) => {
    if (!/^\d+$/.test(part.quantity) || Number(part.quantity) < 1 || Number(part.quantity) > 999) throw new Error();
    return sum + parseCents(part.unitCost) * Number(part.quantity);
  }, 0); } } catch { total = null; }

  return <div className="config-layout">
    <aside className="config-sidebar">
      <div className="sidebar-heading"><h2>本地配置</h2><span>{items.length} 套</span></div>
      <label className="search-label">搜索配置<input placeholder="输入配置名称" value={search} onChange={e => setSearch(e.target.value)} /></label>
      <nav aria-label="配置列表">{visible.map(item => <button key={item.id} className={`config-item ${detail?.config.id === item.id ? "selected" : ""}`} disabled={busy || !!pending || undoPending} aria-current={detail?.config.id === item.id ? "true" : undefined} onClick={() => select(item.id)}><strong>{item.name}</strong><span>¥ {money(item.salePriceCents)}</span></button>)}</nav>
      {!visible.length && <p className="empty">{busy ? "正在读取配置…" : "没有找到配置"}</p>}
      <p className="sample-note">隔离样本<br/>价格与配件均为演示数据</p>
    </aside>
    <section className="config-editor" aria-label="配置编辑">
      <div className="editor-heading"><div><p className="eyebrow">本地配置 / 实际配件</p><h1>{detail?.config.name ?? "读取配置"}</h1></div><span className={`status ${dirty ? "pending" : "ready"}`}>{!desktop ? "只读预览" : busy ? "处理中" : !detail ? "未加载" : dirty ? "未保存" : "本机已保存"}</span></div>
      {!desktop && <p className="notice">浏览器只读样本预览。请在桌面窗口中编辑、保存和撤销。</p>}
      <div aria-live="polite">{error && <p className="notice error" role="alert">{error}</p>}{message && <p className="notice success">{message}</p>}</div>
      {pending && <div className="confirm-panel" role="alert"><p>当前修改尚未保存。放弃修改后继续？</p><button className="secondary" onClick={() => setPending(null)}>继续编辑</button><button onClick={() => { const target = pending; setPending(null); if (target === "discard" && detail) { setDraft(toDraft(detail.config)); setError(""); setMessage("已放弃未保存的修改。"); } else if (target === "reload" && detail) void load(detail.config.id); else void load(target); }}>放弃并继续</button></div>}
      {undoPending && <div className="confirm-panel" role="alert"><p>将当前配置恢复到上次保存之前，恢复结果会立即保存。</p><button className="secondary" onClick={() => setUndoPending(false)}>取消</button><button onClick={() => void undo()}>确认撤销</button></div>}
      {draft && detail && <>
        <fieldset disabled={busy || !desktop || !!pending || undoPending}>
          <div className="config-fields"><label>配置名称<input maxLength={120} value={draft.name} onChange={e => { setDraft({ ...draft, name: e.target.value }); setMessage(""); }} /></label><label>售价（元）<input inputMode="decimal" value={draft.salePrice} onChange={e => { setDraft({ ...draft, salePrice: e.target.value }); setMessage(""); }} /></label></div>
          <div className="parts-heading"><h2>实际配件</h2><span>本轮编辑不涉及展示配件</span></div>
          <div className="parts-scroll"><table><thead><tr><th>类别</th><th>配件名称</th><th>数量</th><th>样本单价 / 元</th><th>小计 / 元</th></tr></thead><tbody>{draft.actualParts.map((part, index) => {
            let subtotal = "—"; try { if (/^\d+$/.test(part.quantity) && Number(part.quantity) >= 1 && Number(part.quantity) <= 999) subtotal = money(parseCents(part.unitCost) * Number(part.quantity)); } catch { /* 未完成输入时不展示错误金额 */ }
            return <tr key={part.id}><td><input aria-label={`第${index + 1}行类别`} value={part.category} maxLength={30} onChange={e => partChange(index, "category", e.target.value)} /></td><td><input aria-label={`第${index + 1}行配件名称`} value={part.name} maxLength={200} onChange={e => partChange(index, "name", e.target.value)} /></td><td><input aria-label={`第${index + 1}行数量`} inputMode="numeric" value={part.quantity} onChange={e => partChange(index, "quantity", e.target.value)} /></td><td><input aria-label={`第${index + 1}行样本单价`} inputMode="decimal" value={part.unitCost} onChange={e => partChange(index, "unitCost", e.target.value)} /></td><td className="numeric">{subtotal}</td></tr>;
          })}</tbody></table></div>
        </fieldset>
        <div className="cost-summary"><span>样本配件成本合计<strong>{total === null ? "请检查输入" : `¥ ${money(total)}`}</strong></span><span>ERP 成本<strong className="unknown">未知 · 暂未接入</strong></span></div>
        <div className="editor-actions"><div><button disabled={!desktop || busy || !dirty || !!pending || undoPending} onClick={() => void save()}>{busy ? "处理中…" : "保存修改"}</button><button className="secondary" disabled={busy || !dirty || !!pending || undoPending} onClick={() => setPending("discard")}>放弃修改</button><button className="secondary" disabled={!desktop || busy || dirty || !detail.undoCount || !!pending || undoPending} onClick={() => setUndoPending(true)}>撤销上次保存</button></div><button className="text-button" disabled={!desktop || busy || !!pending || undoPending} onClick={() => dirty ? setPending("reload") : void load(detail.config.id)}>重新读取</button></div>
        <p className="storage-note">版本 {detail.config.revision} · 可撤销 {detail.undoCount} 次保存 · 样本数据库独立存储</p>
      </>}
      {!detail && !busy && desktop && <button onClick={() => window.location.reload()}>重新加载</button>}
    </section>
  </div>;
}

