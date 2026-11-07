# MCP 本机接入

源码 CLI 的 `mcp` 子命令提供 stdio MCP 服务，供支持本地子进程的 AI 客户端使用。它复用 `agent-core` 的 Windows 当前用户命名管道和桌面业务接口，不需要 Node.js 或 Python，不直接访问数据库。已安装旧版 CLI 不一定包含此子命令；先用本轮源码构建的 CLI。源码可用不代表已发布或替换现用软件。

## 构建与连接

在源码根目录执行：

```powershell
cargo build --locked --manifest-path packages/agent-cli/Cargo.toml
```

将客户端的 MCP 启动配置指向生成的 EXE。以下为通用 `mcpServers` JSON 示例，按所用客户端配置格式填写。`command` 使用本轮构建的程序绝对路径，`--connection` 使用目标工作台安装目录的实际连接文件路径。

```json
{
  "mcpServers": {
    "diy-workbench": {
      "command": "D:/diytools/source/packages/agent-cli/target/debug/diytools-agent.exe",
      "args": ["mcp", "--connection", "D:/你的工作台目录/agent-connection.json"]
    }
  }
}
```

工作台需要已经运行并启用 Agent。每次工具调用重新读取连接文件的 `instance`，桌面重启后无需手动更新 PID；不会运行文件中的 `cli` 路径。连接文件缺失、损坏或实例不可用会返回工具错误，不会自动选中其他安装。也可用 `--instance desktop-PID mcp` 固定单个实例，不能与 `--connection` 同用。

先调用 `workbench_status`，核对实例、版本及 `capabilities`。`tools/list` 表示适配层允许调用的工具；实际能力仍以目标桌面返回值为准。旧桌面不支持的操作保留原错误。

## 工具与权限

| MCP 工具 | 复用的 Agent 方法 | 启动条件 |
| --- | --- | --- |
| `workbench_status` | `status` | 默认 |
| `workbench_shops_list` | `shops.list` | 默认 |
| `workbench_configs_find` | `configs.find` | 默认 |
| `workbench_configs_get` | `configs.get` | 默认 |
| `workbench_jobs_status` | `jobs.status` | 默认 |
| `workbench_changes_preview` | `changes.preview` | `--allow-writes` |
| `workbench_changes_apply` | `changes.apply` | `--allow-writes` |
| `workbench_export_start` | `export.start` | `--allow-export` |
| `workbench_sync_run` | `sync.run` | `--allow-sync` |

开关相互独立，按允许的任务范围添加到 `args`。启用工具并不代表任何业务请求已经获得用户授权。本机保存后的桌面自动同步仍遵循工作台原有设置；`--allow-sync` 仅控制 MCP 显式发起同步，不会关闭桌面自动同步。验证写能力应使用没有真实云连接的隔离宿主。

工具 Schema 可从 `tools/list` 获取。查询的 SKU/SPU 保持字符串，翻页传回相同 `revision`。预览参数为 `{ "request": { "shopId": "…", "targets": [], "action": {} }, "operationId": "UUID" }`，其中 targets 必须填入实际目标；业务正文及 `configFields` 价格/SKU 格式见 [CLI 说明](../packages/agent-cli/README.md)。MCP 直接接收 JSON 参数，无需创建输入文件。导出参数直接使用原 `export.start` 正文，必须含 `operationId`、`images`、`report`、`outputDir`。

## 回执与错误

工具结果的 `content[0].text` 是原 Agent JSON envelope，包含 `protocolVersion`、`requestId`、`ok`、`data`、`error`。业务或连接失败返回 `isError: true`，保留原错误码；工具参数校验失败同样是工具错误。未知工具或无效 JSON-RPC 结构返回协议错误。

预览、保存、导出、同步都显式提供 UUID `operationId`。重试沿用原 ID 和参数；传输失败、超时或结果未知时先查原任务。`queued` / `running` 仅表示已接收或执行中，需继续 `workbench_jobs_status` 查询 `succeeded` / `failed` / `interrupted`，核对 `result` / `error`。保存成功再回读目标配置；导出成功核对真实文件路径与摘要。本机保存与云同步分别确认。

## 协议范围与验证

使用 [MCP stdio 传输](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)，支持协议版本 `2025-11-25` 与 `2025-06-18`；其他版本协商返回 `2025-11-25`，由客户端判断是否兼容。支持初始化、ping、工具列表和工具调用。当前仅提供 tools；查询和任务回执已由工具覆盖，未增加重复资源或提示模板。

输入每行一个 JSON-RPC 消息，正文限制约 1 MiB；超限返回错误并关闭会话。请求顺序处理，单次管道传输使用既有 5 秒时限。客户端关闭 stdin 后 MCP 退出；取消通知不撤销已进入桌面队列的业务任务，需按原 operationId 查询。未提供 HTTP 服务、远程访问、MCP Tasks 扩展或业务任务取消能力。

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
```

端到端脚本使用现有 Playwright 与 Edge，无头运行，不打开产品预览。测试材料保存在源码 `sandbox`；收尾按项目回收站规则处理。
