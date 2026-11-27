# MCP 本机接入

三店 NAS Windows 工作台通过同一 `diytools-agent.exe` 提供 CLI 和本机 stdio MCP。请求经当前 Windows 用户的命名管道进入正在运行的桌面程序，复用其 NAS 登录身份和店铺运营权限。工作台启动时在程序旁准备 CLI 和连接文件。

## 连接

启动带 Agent 的工作台并登录。将客户端的 `command` 指向 `agent-connection.json` 内 `cli` 的绝对路径，并把 `--connection` 指向同一目录的连接文件。以下是通用配置格式。

```json
{
  "mcpServers": {
    "diy-workbench": {
      "command": "D:/你的工作台目录/diytools-agent.exe",
      "args": ["mcp", "--connection", "D:/你的工作台目录/agent-connection.json"]
    }
  }
}
```

工作台需运行、启用 Agent 并登录当前账号。每次工具调用重新读取连接文件的 `instance`，桌面重启后继续使用同一连接文件。MCP 命令本身从客户端的固定路径启动。连接文件缺失、损坏或实例不可用会返回工具错误，不会自动选中其他安装。也可用 `--instance desktop-PID mcp` 固定单个实例，不能与 `--connection` 同用。

以上接入默认只读。要跟随当前账号的本机设置，从工作台「更多 → AI 接口权限」展开 MCP 接入配置并复制 JSON。生成的 `args` 额外包含 `--follow-workbench`。先调用 `workbench_status`，核对账号、实例、`capabilities` 和各店的 `shopCapabilities`。

## 工具与权限

| MCP 工具 | 复用的 Agent 方法 | 启动条件 |
| --- | --- | --- |
| `workbench_status` | `status` | 默认 |
| `workbench_shops_list` | `shops.list` | 默认 |
| `workbench_configs_find` | `configs.find` | 默认 |
| `workbench_configs_get` | `configs.get` | 默认 |
| `workbench_jobs_status` | `jobs.status` | 默认 |
| `workbench_sources_find` | `sources.find` | 默认，三店 NAS |
| `workbench_sources_get` | `sources.get` | 默认，三店 NAS |
| `workbench_inventory_check` | `inventory.check` | 默认，三店 NAS |
| `workbench_activity_list` | `activity.list` | 默认，三店 NAS |
| `workbench_changes_preview` | `changes.preview` | `--allow-writes` |
| `workbench_changes_apply` | `changes.apply` | `--allow-writes` |
| `workbench_draft_preview` / `workbench_draft_apply` | `draft.preview` / `draft.apply` | `--allow-draft-writes`，三店 NAS |
| `workbench_sources_preview` / `workbench_sources_apply` | `sources.preview` / `sources.apply` | `--allow-source-writes`，三店 NAS |
| `workbench_export_start` | `export.start` | `--allow-export` |
| `workbench_sync_run` | `sync.run` | `--allow-sync` |

显式开关各自控制表中对应工具。`--allow-writes` 仅开放已有配置修改。新建草稿需要 `--allow-draft-writes`，维护输出源需要 `--allow-source-writes`。每个工具还受工作台当前账号和 NAS 运营权限约束。可以从 `status.data.shopSourceScopes` 查看各店允许的三店共用维护与配置跟随范围。NAS 模式的 `sync.run` 刷新当前店铺并保留本机草稿。

`--follow-workbench` 可调用表中全部已实现工具，`tools/list` 在会话期间固定。每次业务调用按本机当前账号勾选和 NAS 店铺权限重新裁决，MCP 返回的 `status` 也按本进程工具范围裁剪。旧工作台缺少本机权限策略时，仅靠 `--follow-workbench` 调用保存、导出或同步会收到 `WORKBENCH_POLICY_REQUIRED`。SQLite 离线工作区对新增 NAS 查询返回 `NAS_MODE_REQUIRED`。

工具 Schema 可从 `tools/list` 获取。查询的 SKU/SPU 保持字符串，翻页沿用相同的 `shopId` 和 `revision`。详情查询建议提供 `shopId`，因为各店可能有相同的配置 ID。预览参数为 `{ "request": { "shopId": "…", "targets": [], "action": {} }, "operationId": "UUID" }`，其中 targets 必须填入实际目标；业务正文及 `configFields` 价格/SKU 格式见 [CLI 说明](../packages/agent-cli/README.md)。MCP 直接接收 JSON 参数，无需创建输入文件。导出参数直接使用原 `export.start` 正文，必须含 `operationId`、`images`、`report`、`outputDir`。

## 回执与错误

### 新建草稿和维护来源

这两类预览均接受 `{"operationId":"预览UUID","request":{...},"waitMs":2500}`。预览成功后检查计划摘要，将其中的 `planId` 交给同一类保存工具，并使用新的保存 UUID，例如 `{"operationId":"保存UUID","planId":"预览返回的计划ID","waitMs":2500}`。用户勾选的写入、三店共用和配置跟随权限在提交前重新核对。

- `draft.preview` 的 `request` 填 `shopId`、`mode: "new_draft_link"`、`productName`、`configs`。一批 1–16 套，每套提供 `name` 和 `parts`，可指定 `actualParts` 和到手价 `price`。配件行使用当前店铺有效的 `sourceId`、`slot`、可选正整数 `qty`。板型资料不足时查看 `hardwareWarnings`。保存成功后按 `configIds` 回读各套草稿。
- `sources.preview` 的 `request` 填 `shopId`、`scope`（`shop` / `shared`）、`action`。单店支持 `edit`、`adopt_erp`、`archive`、`restore`。三店共用支持 `edit`、`adopt_erp`、`create_special`。已有来源提供 `sourceId`，ERP 建源提供字符串 `goodsId`。输入业务字段放在 `fields`。仅显式设置 `followConfigs: true` 时规划配置跟随，工作台还需允许跟随与配置修改。
- 保存来源前核对计划的步骤、影响配置与人工文案。工作表有未保存修改时先处理。出现 `partialSuccess: true` 时核对已确认与剩余步骤，用原 `planId` 和原保存 `operationId` 查询或续做。新的维护请求使用新的预览和操作编号。

配置搜索可传 `query`（1–200 字）并与精确筛选组合。输出源列表支持 `category`、`query`、`stockStatus`、核算价范围、`filter` 和 `includeDeleted`。来源翻页时沿用筛选和首屏 `revision`。详情须提供 `sourceId` 或 `goodsId`，同货号命中多个别名会返回 `AMBIGUOUS_SOURCE` 与候选来源 ID。库存读取未获授权时，来源库存字段会脱敏。

库存巡检用 `{"shopId":"intel","operationId":"a1234567-1234-4234-8234-123456789abc","limit":20,"waitMs":2500}` 启动，可用 `productId` 限定单个链接。回执中的 `jobId` 固定本次检查快照。继续调用同一工具并传 `{"jobId":"回执中的ID","offset":20,"limit":20}` 即可取下一页。`workbench_jobs_status` 可查询状态和检查摘要。操作记录用 `from`、`to`（YYYY-MM-DD）、`actor`、`kind`、`page`（从 0 起）和 `pageSize` 查询，旧 NAS 版本无法处理操作人或对象筛选时明确返回 `UNSUPPORTED_FILTER`。

工具结果的 `content[0].text` 是原 Agent JSON envelope，包含 `protocolVersion`、`requestId`、`ok`、`data`、`error`。业务或连接失败返回 `isError: true`，保留原错误码；工具参数校验失败同样是工具错误。未知工具或无效 JSON-RPC 结构返回协议错误。

库存检查、预览、保存、导出和同步支持 `waitMs`（整数 0–10000，默认 0）。MCP 拿到入队回执后每 150 毫秒查询同一任务，窗口内成功的库存检查尽量直接返回结果页。到期返回最近状态及原任务标识，可继续查状态或读取快照。

预览、保存、导出、同步都显式提供 UUID `operationId`。重试沿用原 ID 和参数；传输失败、超时或结果未知时先查原任务。`queued` / `running` 仅表示已接收或执行中，需继续 `workbench_jobs_status` 查询 `succeeded` / `failed` / `interrupted`，核对 `result` / `error`。NAS 保存以 `nasSave: "saved"` 及正式回执为准，随后回读目标配置。按版本导出时提供同店 `shopId`、配置 ID 和 `revision`，也可指定 `sourceOperationId` 按保存回执版本导出。导出成功后核对真实文件路径与摘要。

## 协议范围与验证

使用 [MCP stdio 传输](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)，支持协议版本 `2025-11-25` 与 `2025-06-18`；其他版本协商返回 `2025-11-25`，由客户端判断是否兼容。支持初始化、ping、工具列表和工具调用。当前仅提供 tools；查询和任务回执已由工具覆盖，未增加重复资源或提示模板。

输入每行一个 JSON-RPC 消息，正文限制约 1 MiB；超限返回错误并关闭会话。请求顺序处理，单次管道查询使用 5 秒时限。配件筛选较多时可指定店铺和缩小分页范围。客户端关闭 stdin 后 MCP 退出；取消通知不撤销已进入桌面队列的业务任务，需按原 operationId 查询。未提供 HTTP 服务、远程访问、MCP Tasks 扩展或业务任务取消能力。

本地验证命令：

```powershell
cargo test --locked --manifest-path packages/agent-cli/Cargo.toml
cargo clippy --locked --manifest-path packages/agent-cli/Cargo.toml --all-targets -- -D warnings

# 复用原隔离工作台测试：合成配置、真实 UI 执行与 SQLite 保存，不连接真实 ERP 或云端。
$env:DIYTOOLS_AGENT_CLI_PATH = (Resolve-Path packages/agent-cli/target/debug/diytools-agent.exe).Path
cargo build --locked --manifest-path apps/desktop/src-tauri/Cargo.toml --bin agent-review-host --features review-host,agent-tools
node tools/agent-config-fields-smoke.mjs apps/desktop/src-tauri/target/debug/agent-review-host.exe packages/agent-cli/target/debug/diytools-agent.exe --mcp

# 加验实际导图：三类历史样式、双图/仅 SKU、像素补白、原生 ZIP 与摘要。
node tools/agent-config-fields-smoke.mjs apps/desktop/src-tauri/target/debug/agent-review-host.exe packages/agent-cli/target/debug/diytools-agent.exe --mcp-export

# 在三店合成数据库上启动真实 Tauri、CLI 和 stdio MCP。Fixture 使用项目的纯合成 SQL 种子及测试证书目录。
pwsh.exe -File tools/agent-nas-p1-run.ps1 -Fixture 'D:\隔离样本\fixture' -ActivityVersion 033
pwsh.exe -File tools/agent-nas-p1-run.ps1 -Fixture 'D:\隔离样本\fixture' -ActivityVersion 034

# 用合成 ERP 观察值验证建源、恢复成本价、三店共用、归档和恢复的实际 NAS 回执。
node apps/desktop/tests/agent-source-lifecycle-nas.mjs 'D:\隔离样本\fixture'

# 在另一终端运行 pnpm --dir apps/desktop dev --port 5289 后，核验撤权与已打开工作表的刷新。
node apps/desktop/tests/agent-permissions.browser.mjs
node apps/desktop/tests/agent-source-refresh.browser.mjs
```

端到端脚本使用现有 Playwright 与 Edge，无头运行，不打开产品预览。测试材料保存在源码 `sandbox`；收尾按项目回收站规则处理。
