# 可选 ERP 辅助进程

公开工程保留 JSONL 协议、只读 SKU/BOM 查询与 SQL 读取功能。默认依赖全部来自公共 PyPI，不安装公司私有包，也不内嵌私有 ERP 程序。未安装可选运行时时，本地工作台仍可使用，ERP 操作返回 `ERP_RUNTIME_UNAVAILABLE`。

本机配置使用应用自己的 `data/integrations.json`，不能提交、打包进公开发行物或构建注入。示例地址仅为保留域名：

```json
{
  "version": 1,
  "cloud": {"envId": "example-env", "endpoint": "https://cloud.example.test"},
  "erp": {"domain": "https://erp.example.test/"}
}
```

缺少 `cloud` 时完全使用本地模式；缺少 `erp` 时 ERP 网页登录返回 `ERP_NOT_CONFIGURED`。两种地址都必须使用无账号、无查询参数的 HTTPS 根地址；页面不能自行替换地址。

Windows 工作台兼容手工安装在 `data/runtime/erp-worker.exe` 的旧组件。使用「一键安装组件」或「一键更新组件」后，主程序从 Gitea 独立组件通道下载签名 ZIP，验证成员白名单、长度和摘要，然后在所有 ERP 任务空闲时将新版本目录与 ERP 域名一并原子切换。工作台下次请求即使用新 worker。开发模式在未安装外部 worker 时可使用本目录 `.venv` 的 Python，执行 `main.py`。

```powershell
uv sync --directory services/erp-worker --locked
uv run --directory services/erp-worker --locked --with httpx==0.28.1 python -B -m unittest -v
pwsh -File tools/build-erp-worker.ps1
```

打包脚本使用每次独立的构建环境，默认输出到 `sandbox/erp-worker-build/<本次目录>/optional-runtime/erp-worker.exe`；不会修改已有私有 `.venv` 或主程序资源。可用 `-OutputPath` 指定本机可选运行时目标。公开构建不需要私有包；生成的通用 worker 中没有私有适配器，必须另行在本机安装。

通用 worker 从宿主选定的本机组件目录动态加载 `erp-adapter.py`。旧版目录为 `data/runtime`。适配器提供两个入口，`create_client(credentials, *, domain)` 与 `api_factories()`。前者返回包含 `user`、`client`、`_check_res` 的兼容会话对象，凭据仅留内存；必须在发送登录之前关闭 HTTP 重定向。后者返回网店商品、商品明细、单品信息的三个只读 API 工厂，提供 `base_url`、`url`、`params()`。适配器及其依赖由用户本机维护，禁止进入公开源码、依赖锁文件和发行包。

### 本机套餐匹配协议

价格页只在勾选后由用户触发预览，不在价格主表加载平台 SKU 状态。匹配复用同一内存会话；适配器另提供 `matching_gateway(session, *, domain)`，返回支持 `read(operation, payload, timeout)`、`write(operation, payload, timeout)` 的对象。通用 worker 不包含供应商 SDK、服务地址或供应商 API 参数。缺少此入口或可选包时返回 `PACKAGE_UNAVAILABLE`。

读取操作为 `platform_goods`、`refresh_product`、`find_packages`、`product_info`、`bom`、`search_goods`。平台行含 `shopId/spu/sku/name/onSale/goodsId`；列表含完整 `rows/total`。商品信息含 `goodsId/name/isPackage`；BOM 为 `items[{goodsId,qty}]`。适配器须核验全部分页，保留重复和失效 SKU 供通用层阻断；套餐名必须精确筛选。普通读取 20 秒，平台刷新 120 秒，仅断连读取最多重试两次。

适配器可声明 `concurrent_reads = True` 和 `sku_package_search = True`。前者允许同一会话最多六个只读请求并发，后者支持 `find_packages({sku})` 在套餐分类下返回候选，由 worker 精确核对新旧两个名称。旧适配器继续按单线程和两个全名查询。每次预览共用同店同 SPU 的完整查询，写前检查和写后回读均重新核验平台 SKU 与套餐。

预览默认允许更新已关联套餐的 BOM，历史调用可显式传 `mode: "normal"`。快照中有 `update` 时执行必须携带 `confirmRematch: true`。状态支持按动作传入 `filter`，`actionCounts` 统计全批，`filteredTotal` 统计筛选后的总数。

写操作仅有 `get_code`、`create_package`、`save_bom`、`set_bom_type`、`link_sku`、`repair_link`，每步只发一次；适配器必须禁用 HTTP 自动重试和跨来源重定向。回执为 `{confirmed:true}`，获取编码附带 `code`，创建附带 `goodsId`。创建固定使用编码分类 315、套餐分类 406；单件数量 1 也必须创建套餐。复用只关联，更新只保存原套餐 BOM，均须回读关联与 BOM 验收。

`match_preview/status/detail/execute/recover/stop/search` 为固定 JSONL 动作；预览完成后有效 30 分钟。状态按 50 项分页，完整 BOM 可按配置读取，避免大批量超过协议大小。队列冻结已保存配置和默认附加，`pendingStep` 先 fsync 到宿主指定的 `data/runtime/erp-matching` 再写 ERP；结果未知立即停止本批，仅允许只读核验。反复核验失败保持 `needs_review`，不会重新发出写请求。进程重启也不会自动续写。

同一 `operation.lock` 由操作系统持有，库存/成本读取与匹配互斥；纯 Excel 读取器也使用此锁。密码和 Cookie 不写入队列。退出只关闭本进程 HTTP 客户端，不调用远端 logout。测试使用内存网关：`uv run --locked --with httpx python -m unittest discover -p 'test*.py'`，不登录或写入真实 ERP。

HTTP 只读请求核验配置域名和三个允许的路径，拒绝重定向、歧义、截断分页和超过 500 条结果。关闭会话只清理本机客户端，不调用远端登出。错误响应不透传原始异常、密码或 Cookie。环境检查仅报告适配器能力，不尝试登录或查询。

SQL 入口独立于网页 ERP，保留固定的只读查询及本机预览/确认应用协议。SQL 密码使用 Windows 当前用户 DPAPI，路径由宿主固定为 `data/sql-credentials.dpapi.json`，不会写入业务状态或公开配置；只有读取、规范化和输出大小检查均成功后才保存。公开配置中不要填写账号和密钥。

主程序升级保留本机组件、`integrations.json` 与 DPAPI 凭据。组件可在 Gitea 的 `erp-runtime-updates` 专用通道独立发布，公开客户端发行附件只包含主程序所需文件。

英特尔 NAS 工作台通过专用原生只读动作复用已保存的公司 SQL 连接，没有保存/清除凭据或写 ERP 的动作。原生文件选择器把工作簿交给 worker：含税成本按《主机成本表V2新_修复版.xlsb》「库存数据」M 列商品编号与 Z 列主机含税成本读取；报价仍按英特尔主机维护表「综合表」的 INTEL 文本 SPU/SKU 和 H 列到手价读取，保留摘要及行号。两者都只读取已保存的文件字节，解析后回读摘要，不执行 Excel 重算或回写。
