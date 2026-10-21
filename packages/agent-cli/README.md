# DIY Tools Agent CLI

独立的本机命令行入口，通过 `agent-core` 连接指定的桌面实例。支持保存快照查询，以及经工作台业务接口执行的预览、保存、导出和同步任务。无需加入全局 PATH，也不依赖调用时的工作目录。

## 构建与调用

在仓库根目录执行：

```powershell
cargo build --release --manifest-path packages/agent-cli/Cargo.toml
cargo test --manifest-path packages/agent-cli/Cargo.toml
```

一并构建 CLI 与带 `agent-tools` 的桌面程序：

```powershell
pwsh.exe -File 'D:\diytools\packages\agent-cli\build-local.ps1'
```

脚本只构建本地 EXE，不生成安装包、不安装、不启动或替换现用程序。构建需要现有前端依赖及 Windows Rust/Tauri 开发环境；脚本不会自动安装依赖。Windows agent-tools 构建默认开启入口并内置先行构建的 CLI；启动后读取程序目录的 agent-connection.json。设置 `DIYTOOLS_AGENT_ENABLED=0` 可关闭。未连接或忙碌的界面会明确拒绝任务，CLI 不会绕开业务校验直接修改数据库。

使用生成的 EXE 的绝对路径，可从任意目录运行。下面以仓库位于 `D:\diytools` 为例；如果设置了 `CARGO_TARGET_DIR`，按实际输出目录调整。`desktop-12345` 必须换成已启用入口的桌面进程 ID 对应的实例标识，可用 `Get-Process` 核对路径与 ID；启用方式见[接入说明](../../docs/AGENT-TOOLS.md)。

```powershell
$agent = 'D:\diytools\packages\agent-cli\target\release\diytools-agent.exe'
& $agent --help
& $agent --instance desktop-12345 status
& $agent --json --instance desktop-12345 doctor
& $agent --json --instance desktop-12345 shops list
& $agent --json --instance desktop-12345 configs find --shop-id 'shop-id' --goods-id 'goods-id' --sku 'sku-id' --spu 'spu-id' --limit 20 --offset 0 --revision 42
& $agent --json --instance desktop-12345 configs get --config-id 'config-id'
& $agent --json --instance desktop-12345 request --method status
& $agent --json --instance desktop-12345 request --method configs.find --input 'D:\queries\find.json'
```

`find` 的筛选条件可省略，默认 `limit=20`、`offset=0`；第一页可省略 `revision`，翻页时必须使用第一页返回的快照版本作为 `--revision`，避免不同页混用版本。筛选字段保持原始 ID，不解析或猜测店铺别名。分页、快照版本和返回字段遵循桌面端协议，CLI 不直接打开数据库。`request --input` 从指定文件读取 JSON 对象，省略时使用 `{}`。例如 `find.json`：

```json
{"shopId":"shop-id","limit":20,"offset":0,"revision":42}
```

## 输出和退出码

普通成功输出为便于阅读的缩进数据；`doctor` 同时说明授权和数据范围。脚本使用 `--json`，stdout 只包含一个协议 envelope：`protocolVersion`、`requestId`、`ok`、`data`、`error`。`requestId` 为每次调用生成的 UUID。错误始终输出 JSON envelope，不向 stdout 混入日志。`--help` 和 `--version` 正常输出文字并成功退出。

| 退出码 | 含义 |
| --- | --- |
| `0` | 请求成功，或显示帮助/版本 |
| `1` | 桌面端明确返回失败，查看 `error.code` 和 `error.message` |
| `2` | 参数、输入文件或连接错误，查看 `error.code` 和 `error.message` |

省略 `--instance` 会返回 `INSTANCE_REQUIRED`，包括 `doctor`；CLI 不自动选中其他实例。输入文件不存在、JSON 损坏和输入非对象分别返回 `INPUT_READ_FAILED`、`INVALID_JSON`、`INVALID_INPUT`。输入文件最多 1 MiB，超限返回 `INPUT_TOO_LARGE`；加入协议 envelope 后仍须满足 core 的 1 MiB 帧限制。`limit` 只接受 1 至 100；不合法命令或参数返回 `INVALID_ARGUMENT`。

## 当前能力

所有请求仅在当前 Windows 用户授权范围内访问指定本机桌面实例。读取方法仅查询已保存的 snapshot；未保存编辑不包含在结果中。`doctor` 使用真实 `status` 请求检查连接，并从实例返回的 `capabilities` 判断保存和同步能力，失败返回非零退出码。

`request --method` 仅开放 `status`、`shops.list`、`configs.find`、`configs.get`、`jobs.status` 只读方法；写入只能使用下方专用命令。实例是否支持某项操作以 `status.capabilities` 为准。

## 预览、保存、导出与同步

操作 ID 使用标准 UUID。除预览可省略并自动生成外，其他发起任务的命令都必须显式提供 `--operation-id`。同一次操作的重试应保留原 operationId 和原参数，避免重复保存或导出；不同操作使用新 UUID。`requestId` 仅标识一次传输，与业务 operationId 不同。

```powershell
& $agent --json --instance desktop-12345 changes preview --input 'D:\queries\change.json' --operation-id 'a1234567-1234-4234-8234-123456789abc'
& $agent --json --instance desktop-12345 jobs status --operation-id 'a1234567-1234-4234-8234-123456789abc'
& $agent --json --instance desktop-12345 changes apply --plan-id '实际预览结果中的planId' --operation-id 'b1234567-1234-4234-8234-123456789abc'
& $agent --json --instance desktop-12345 jobs status --job-id '实际返回的jobId'
& $agent --json --instance desktop-12345 export --input 'D:\queries\export.json' --operation-id 'c1234567-1234-4234-8234-123456789abc'
& $agent --json --instance desktop-12345 sync run --operation-id 'd1234567-1234-4234-8234-123456789abc'
```

`jobs status` 的 `--job-id` 和 `--operation-id` 必须且只能选一个。发起长任务后，CLI 只等待排队回执，不等待整个导出或同步完成；返回 jobId/status 并不代表业务成功，需继续查询任务，核对最终 status、result 与 error。传输超时后先用原 operationId 查任务状态，不要生成新 ID 盲目重试。

`change.json` 只描述请求正文，CLI 将其包装为 `changes.preview` 的 `request` 字段：

```json
{"shopId":"intel","targets":[{"configId":"真实配置ID","partIndex":0,"expectedGoodsId":"原配件ERP码"}],"action":{"type":"displayName","value":"新的展示名称"}}
```

预览不写业务数据。支持的 action 及配件适用性由工作台业务规则校验；成功后从任务结果取 planId。应用要求计划有效、原始基线未变化，且工作台没有未保存编辑或冲突；不满足时拒绝，不覆盖当前编辑。应用成功的本机保存回执不代表已经同步云端。

`export.json` 可使用明确的保存快照：

```json
{"configIds":["真实配置ID"],"revision":42,"images":"both","report":true,"outputDir":"D:\\exports\\agent-job"}
```

也可引用成功保存操作的快照：

```json
{"sourceOperationId":"b1234567-1234-4234-8234-123456789abc","images":"both","report":true,"outputDir":"D:\\exports\\agent-job"}
```

`images` 接受 `both`、`long`、`square`；`report` 为布尔值，`outputDir` 必须是绝对路径。输入文件不应包含 operationId，由命令行提供。导出独立于保存，不会重写配置；保存成功而导出失败时，仅重试导出。同步也独立发起，应用或导出不会自动同步。最终导出任务回执给出实际 ZIP、报告、清单路径；失败不能视为导出成功。
