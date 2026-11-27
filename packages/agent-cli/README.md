# DIY Tools Agent CLI

本机 MCP 客户端可使用 `mcp --connection <绝对连接文件路径>`，默认只读。加 `--follow-workbench` 可跟随三店 NAS 当前账号的界面权限。保存、导出和同步也可通过旧版独立开关启用。详见 [MCP 本机接入](../../docs/MCP.md)。

通过 `agent-core` 连接指定的本机桌面实例。三店 NAS 工作台可查询 NAS 已保存配置、预览修改、正式保存、导出和刷新。启动后读取程序旁 `agent-connection.json` 的 `cli` 与 `instance`。

## 构建与调用

在仓库根目录执行：

```powershell
cargo build --release --manifest-path packages/agent-cli/Cargo.toml
cargo test --manifest-path packages/agent-cli/Cargo.toml
```

一并构建 CLI 与三店 NAS 桌面程序。请先按[开发说明](../../docs/DEVELOPMENT.md)准备 Excel 读取组件。

```powershell
pwsh.exe -File 'D:\diytools\source\packages\agent-cli\build-local.ps1'
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
& $agent --json --instance desktop-12345 configs get --shop-id intel --config-id 'config-id'
& $agent --json --instance desktop-12345 request --method status
& $agent --json --instance desktop-12345 request --method configs.find --input 'D:\queries\find.json'
```

`find` 的筛选条件可省略，默认 `limit=20`、`offset=0`；第一页可省略 `revision`，翻页时必须使用第一页返回的快照版本作为 `--revision`，避免不同页混用版本。筛选字段保持原始 ID，不解析或猜测店铺别名。分页、快照版本和返回字段遵循桌面端协议，CLI 不直接打开数据库。`request --input` 从指定文件读取 JSON 对象，省略时使用 `{}`。例如 `find.json`：

```json
{"shopId":"shop-id","limit":20,"offset":0,"revision":42}
```

## 输出和退出码

### 配置到手价与 SKU 批量维护

通过原有 `changes preview --input` / `changes apply --plan-id` 使用 `configFields` 操作；每批 1–64 套，各配置可设置不同值：

```json
{"shopId":"intel","action":{"type":"configFields"},"targets":[{"configId":"真实配置ID","expected":{"spu":"完整SPU","shortName":"完整配置简称","price":6999,"skuId":""},"changes":{"price":6899,"skuId":"12345678901234567890"}}]}
```

`changes` 只允许 `price` 和 `skuId`，可单独提供其中一个。`price` 是最终到手价，不再扣店铺券，非负且最多两位小数。SKU 必须是 1–64 位数字字符串，保留前导零和长整数，不接受数值或清空。`expected` 必须包含 SPU、完整简称和每个待改字段的原值；原字段缺失用 `null`，空 SKU 用 `""`，不混用。调用者先完成来源匹配，接口按配置 ID 定点修改，不进行模糊匹配。

预览拒绝原值变化、跨店铺、删除/未加载配置、重复目标及同店铺同 SPU 下重复 SKU；保存复核完整计划与工作区版本。只改指定字段，保留配件、简称、样式和导入时间。保存任务必须查询最终回执，并回读配置；失败或结果未知时先按原 operationId 查询，不盲目重试。NAS 保存回执包含目标店铺及各配置的正式版本。旧版客户端不支持此 action，需要更新主程序；无需新增 CLI 子命令。

普通成功输出为便于阅读的缩进数据；`doctor` 同时说明授权和数据范围。脚本使用 `--json`，stdout 只包含一个协议 envelope：`protocolVersion`、`requestId`、`ok`、`data`、`error`。`requestId` 为每次调用生成的 UUID。错误始终输出 JSON envelope，不向 stdout 混入日志。`--help` 和 `--version` 正常输出文字并成功退出。

| 退出码 | 含义 |
| --- | --- |
| `0` | 请求成功，或显示帮助/版本 |
| `1` | 桌面端明确返回失败，查看 `error.code` 和 `error.message` |
| `2` | 参数、输入文件或连接错误，查看 `error.code` 和 `error.message` |

省略 `--instance` 会返回 `INSTANCE_REQUIRED`，包括 `doctor`；CLI 不自动选中其他实例。输入文件不存在、JSON 损坏和输入非对象分别返回 `INPUT_READ_FAILED`、`INVALID_JSON`、`INVALID_INPUT`。输入文件最多 1 MiB，超限返回 `INPUT_TOO_LARGE`；加入协议 envelope 后仍须满足 core 的 1 MiB 帧限制。`limit` 只接受 1 至 100；不合法命令或参数返回 `INVALID_ARGUMENT`。

## 当前能力

当前 Windows 用户可以连接自己运行的实例。NAS 模式按成员的运营权限列出店铺，读取 NAS 已保存配置。`configs get` 遇到多店重名 ID 时要求 `--shop-id`，`nasVersion` 是单套正式配置版本，`revision` 是查询或导出快照标识。`doctor` 通过 `status` 回读相应实例的能力。

`request --method` 开放 `status`、`shops.list`、`configs.find`、`configs.get`、`sources.find`、`sources.get`、`inventory.check`、`activity.list`、`jobs.status`。写入使用下方专用命令。实例和店铺的实际能力见 `status.capabilities`、`status.shopCapabilities`。

三店 NAS 查询示例

```powershell
& $agent --json --instance desktop-12345 configs find --shop-id intel --query '白色'
& $agent --json --instance desktop-12345 sources find --shop-id intel --category 内存 --min-price 100 --max-price 500 --limit 20
& $agent --json --instance desktop-12345 sources get --shop-id intel --source-id '来源ID'
& $agent --json --instance desktop-12345 inventory check --shop-id intel --product-id '链接ID' --threshold 5 --wait-ms 2500
& $agent --json --instance desktop-12345 inventory check --job-id '巡检任务ID' --limit 20 --offset 20
& $agent --json --instance desktop-12345 activity list --shop-id intel --from 2026-11-01 --to 2026-11-15 --kind configurations --page 0 --page-size 30
```

配置和来源列表翻页须带原 `revision`。来源详情也可按 `--goods-id` 查，遇多个候选会返回 `AMBIGUOUS_SOURCE` 和各来源 ID。库存状态筛选、明细及操作日志受库存与操作记录读取权限控制。操作记录筛选在旧版服务上不可用时返回 `UNSUPPORTED_FILTER`。离线 SQLite 宿主保留既有查询，新增 NAS 查询返回 `NAS_MODE_REQUIRED`。

## 预览、保存、导出与同步

### 草稿链接

`draft preview --input 'D:\任务\draft.json'` 以当前店铺的有效来源构造 1–16 套草稿，并检查板型和依赖。正文示例

```json
{"shopId":"intel","mode":"new_draft_link","productName":"直播用白色整机","configs":[{"name":"配置一","price":6999,"parts":[{"sourceId":"本店来源ID","slot":"显卡","qty":1}]}]}
```

需要单独指定实际 BOM 时在该配置内传 `actualParts`，结构同 `parts`。确认预览摘要和板型提示后执行 `draft apply --plan-id '返回的planId' --operation-id '保存UUID' --wait-ms 2500`。新链接和配置 ID 由工作台生成，成功回执会给出正式保存版本。按 `configIds` 继续 `configs get`。

### 输出源

`sources preview --input 'D:\任务\source.json'` 支持下列业务正文，`sources apply --plan-id '返回的planId' --operation-id '保存UUID'` 保存对应计划。预览和保存与原有异步任务使用同一组 `--wait-ms` 和 `jobs status` 接口。

```json
{"shopId":"intel","scope":"shop","action":"edit","sourceId":"本店来源ID","fields":{"name":"新展示型号","tax":1299},"followConfigs":true}
```

| 操作 | 请求 |
| --- | --- |
| 单店编辑、归档或恢复 | `scope: "shop"`，`action: "edit" / "archive" / "restore"`，明确 `sourceId`。编辑可用 `fields` 更改显示名、核算价（元）、结构化加购、硬件或容量覆盖；恢复成本表核算价用 `resumeTax: true`。 |
| ERP 建源 | `action: "adopt_erp"`，以字符串传 `goodsId`。选择 `shop` 或 `shared`，按所选范围核验 ERP 候选。 |
| 三店共用维护 | `scope: "shared"`。使用 `edit` 维护共用字段；`restoreFields` 列出当前店要恢复为共用的字段。用 `create_special` 新建无货号、成本为零的特殊配件。 |
| 关联配置跟随 | `followConfigs: true`，预览核对受影响店铺、链接、配置及保留的人工文案。来源工作表和目标配置中的未保存修改会在提交前提示处理。 |

硬件与容量使用 `fields` 内的扁平键，例如 `"hardwareOverrides.boardType":"MATX"`、`"capacityOverrides.memoryGb":32`。多步保存复用预览时冻结的正文；传输结果未知时先用原保存 UUID 查状态，部分成功时根据正式回执处理剩余步骤并沿用原保存 UUID。

操作 ID 使用标准 UUID。CLI 启动预览、库存检查时可省略 `--operation-id` 并自动生成，其他发起任务的命令须显式提供。同一次操作的重试应保留原 operationId 和原参数，避免重复保存或导出；不同操作使用新 UUID。`requestId` 标识一次传输。

```powershell
& $agent --json --instance desktop-12345 changes preview --input 'D:\queries\change.json' --operation-id 'a1234567-1234-4234-8234-123456789abc'
& $agent --json --instance desktop-12345 jobs status --operation-id 'a1234567-1234-4234-8234-123456789abc'
& $agent --json --instance desktop-12345 changes apply --plan-id '实际预览结果中的planId' --operation-id 'b1234567-1234-4234-8234-123456789abc'
& $agent --json --instance desktop-12345 jobs status --job-id '实际返回的jobId'
& $agent --json --instance desktop-12345 export --input 'D:\queries\export.json' --operation-id 'c1234567-1234-4234-8234-123456789abc'
& $agent --json --instance desktop-12345 sync run --operation-id 'd1234567-1234-4234-8234-123456789abc'
```

`jobs status` 的 `--job-id` 和 `--operation-id` 须选一个。发起任务时默认返回排队回执。可加 `--wait-ms` 指定受理后等候时间（整数 0–10000 毫秒），每 150 毫秒轮询原任务，到期返回最近状态与同一任务标识。库存检查在时间允许时直接返回当前结果页，后续页用 `inventory check --job-id`。核对最终 status、result 与 error。传输超时后先用原 operationId 查任务状态。

`change.json` 只描述请求正文，CLI 将其包装为 `changes.preview` 的 `request` 字段：

```json
{"shopId":"intel","targets":[{"configId":"真实配置ID","partIndex":0,"expectedGoodsId":"原配件ERP码"}],"action":{"type":"displayName","value":"新的展示名称"}}
```

预览不写业务数据。支持的 action 及配件适用性由工作台业务规则校验；成功后从任务结果取 planId。应用要求计划有效、原始基线未变化，且工作台没有未保存编辑或冲突；不满足时拒绝，不覆盖当前编辑。应用成功的本机保存回执不代表已经同步云端。

`export.json` 可使用明确的保存快照：

```json
{"shopId":"intel","configIds":["真实配置ID"],"revision":42,"images":"both","report":true,"outputDir":"D:\\exports\\agent-job"}
```

也可引用成功保存操作的快照：

```json
{"sourceOperationId":"b1234567-1234-4234-8234-123456789abc","images":"both","report":true,"outputDir":"D:\\exports\\agent-job"}
```

`images` 接受 `both`、`long`、`square`；`report` 为布尔值，`outputDir` 必须是绝对路径。输入文件不应包含 operationId，由命令行提供。导出独立于保存，不会重写配置；保存成功而导出失败时，仅重试导出。NAS 模式的应用直接保存至指定店铺，返回 `nasSave` 和正式回执。`sync run` 刷新工作台当前店铺并保留草稿。最终导出任务回执给出实际 ZIP、报告、清单路径；失败不能视为导出成功。
