# 本机 AI 与 CLI 操作入口

支持 MCP 的本地 AI 客户端可通过 CLI 的 `mcp` 子命令接入。配置、权限与回执见[MCP 本机接入](MCP.md)。

带 Agent 的三店 NAS 构建在启动时准备 `diytools-agent.exe` 和 `agent-connection.json`。直接运行工作台并登录即可。CLI 与其 `mcp` 子命令复用当前成员的 NAS 店铺权限。

入口只允许本机当前 Windows 用户和系统访问，按用户与实例隔离。AI 需要能够执行本机命令；网页聊天本身不能直接调用本机程序。CLI 经工作台现有业务接口操作，不直接打开数据库，不接受任意 SQL 或脚本执行。

## 开始使用

1. 运行工作台，按需要登录自己的成员账号，完成数据接入并保存当前编辑。
2. 将工作台安装目录授权给本机 AI，要求先读 `agent-connection.json`，使用其中的 `cli` 和 `instance`。
3. 先执行 `doctor`，以实际返回的 capabilities 判断当前可用功能。工作台重启后重新读连接文件，不能写死进程 ID。
4. 三店 NAS 的「更多 → AI 接口权限」显示当前账号的本机设置与实际可用能力，可复制跟随勾选设置的 MCP 配置。工作台在每次操作时复核成员与店铺权限。

```powershell
$connection = Get-Content 'D:\你的工作台目录\agent-connection.json' -Raw | ConvertFrom-Json
& $connection.cli --json --instance $connection.instance doctor
& $connection.cli --json --instance $connection.instance shops list
& $connection.cli --json --instance $connection.instance configs find --shop-id intel --goods-id 401748
```

可直接给 AI 下达：

> 工作台目录是 D:\我的工作台。请读取 agent-connection.json 并检查连接。查询英特尔店铺实际配置中使用商品码 401748 的全部配置，完整处理分页，导出配置详情 HTML、配置图及 SKU 图 ZIP。本次不修改配置，不手动同步；等待任务终态成功后给出真实文件路径。

连接文件只指示当前实例，不能替代 doctor。入口随工作台退出关闭。多个实例必须使用各自目录中实际连接信息并核对实例路径。设置进程环境变量 `DIYTOOLS_AGENT_ENABLED=0` 可在下次启动时关闭入口；普通不含 agent-tools 特性的源码构建不会启用。

CLI 准备或入口初始化失败时，工作台仍可使用；按应用提示检查安装目录中的 Agent 诊断文件，不把文件存在视为已经连接成功。旧版手动启动脚本应同步更新，正式版本直接运行 EXE，不依赖这些脚本。

## 查询与分页

查询使用 NAS 正式保存的配置，未提交草稿仍留在各店本机。

- 店铺 ID 使用 `shops list` 返回的值。配置详情用 `--shop-id` 指定店铺以区分重名 ID。
- `--goods-id` 按实际 BOM 匹配；旧配置缺少实际 BOM 时按工作台规则回退展示配件，空 actualParts 数组表示空 BOM。
- `--sku`、`--spu` 保留字符串及前导零；缺失 SKU 不自行生成。
- 默认每页 20 条、最大 100 条；翻页传回 nextOffset 和同一 revision。期间发生保存时重新从第一页查询，避免版本混用。
- `nasVersion` 是单套服务端版本。`revision` 用于检查分页或导出是否仍对应同一目录快照。

配置列表可用 `--query` 模糊匹配链接名称、配置名称和简称，与其他筛选同时生效。输出源支持分类、核算价、库存状态、删除项和目录筛选。同一货号有多个来源别名时，用错误中列出的 `sourceId` 精确重查。库存检查按店铺的正式配置和实际 BOM 计算，可限定链接，翻页时沿用同一次检查的 `jobId`。

```powershell
& $connection.cli --json --instance $connection.instance sources find --shop-id intel --category 内存 --limit 20
& $connection.cli --json --instance $connection.instance sources get --shop-id intel --goods-id '000123'
& $connection.cli --json --instance $connection.instance inventory check --shop-id intel --threshold 5 --wait-ms 2500
& $connection.cli --json --instance $connection.instance inventory check --job-id '原回执的jobId' --offset 20 --limit 20
& $connection.cli --json --instance $connection.instance activity list --shop-id intel --from 2026-11-01 --to 2026-11-15
```

操作记录支持日期、操作人、对象类型与页码。旧服务缺少操作人或对象类型筛选时返回 `UNSUPPORTED_FILTER`。关闭库存与操作记录读取权限后，来源库存数返回 `null`，并标记 `stockRedacted: true`。

## 修改、导出和同步

### 新建 NAS 草稿链接

`draft preview --input` 接受新链接名称和 1–16 套配置。配件须来自当前店铺已保存的来源；预览同时核对展示与实际配件的主板、机箱板型。通过 `draft apply` 保存后，按回执中的链接及配置 ID 确认新草稿。草稿使用新链接 ID，正式 SPU 和 SKU 留空。

### 维护 NAS 输出源

`sources preview --input` 和 `sources apply` 支持单店维护、三店共用、新建 ERP 来源和无货号特殊配件。来源维护、三店共用和关联配置跟随分别在「AI 接口权限」授权。预览会提示来源工作表是否有未保存修改，保存时处理冲突，并逐步记录正式回执。命令和完整请求示例见 [CLI 说明](../packages/agent-cli/README.md)。

旧单店来源缺少 `shopId` 时，如果 NAS 能确认它属于本店，编辑或归档会一并补齐店铺。对已经归档且缺少该字段的记录，现有 NAS 恢复接口会拒绝恢复，工作台返回 `LEGACY_SOURCE_SHOP_MISSING`。

支持到手价、SKU、配件展示名称、升级描述、数量及输出源替换。先查询精确目标，再预览变更；计划有效且工作台没有未保存输入、冲突或占用操作时，才能通过专用 apply 命令保存。保存沿用工作台配件、实际 BOM、成本和草稿保护规则。

```json
{"shopId":"intel","targets":[{"configId":"查询返回的配置ID","partIndex":0,"expectedGoodsId":"原ERP商品码"}],"action":{"type":"upgrade","value":"新的升级描述"}}
```

换件时可将 `action` 设为 `{"type":"replace","sourceId":"新输出源ID","displayName":"直播专属型号"}`。自定义展示名最多 200 字，仅用于配置展示。省略该字段、留空或填写与新来源相同的名称时，展示名称继续跟随来源。

```powershell
& $connection.cli --json --instance $connection.instance changes preview --input 'D:\任务\change.json' --operation-id '预览操作的UUID'
& $connection.cli --json --instance $connection.instance changes apply --plan-id '成功预览返回的planId' --operation-id '保存操作的UUID'
```

导出可选择当前已保存版本，或引用某次成功保存的 operationId，固定对应快照。支持配置图、SKU 图、HTML、manifest 及 ZIP；使用真实 Canvas 和原生落盘，回执返回实际路径、字节数与 SHA256。ERP 价格为保存时的快照，不能代表实时查询结果。

```json
{"shopId":"intel","configIds":["配置ID"],"revision":42,"images":"both","report":true,"outputDir":"D:\\导出"}
```

```json
{"sourceOperationId":"成功保存操作的UUID","images":"both","report":true,"outputDir":"D:\\导出"}
```

输出目录必须是已存在的绝对路径，不接受符号链接或 junction；任务写入独立子目录。导出不重写配置。导出失败只需重试导出。

```powershell
& $connection.cli --json --instance $connection.instance export --input 'D:\任务\export.json' --operation-id '导出操作的UUID'
& $connection.cli --json --instance $connection.instance sync run --operation-id '同步操作的UUID'
& $connection.cli --json --instance $connection.instance jobs status --operation-id '原操作的UUID'
```

NAS 保存以 `nasSave: "saved"` 和正式回执为准。`sync run` 刷新当前店铺并保留本机草稿。按原保存回执导出时，程序会校验目标的服务端版本。

## 任务结果与重试

保存、导出及同步必须提供 UUID 格式 operationId；每项业务操作一个 ID，重试保留原 ID 与原参数。传输超时或状态未知时先查原任务，不能换新 ID 盲目重做。

queued / running 只是排队或执行中；继续查询 jobs status，直到 succeeded / failed / interrupted，并检查 result 或 error。没有界面连接、存在人工未保存输入或冲突时会明确拒绝，不伪造完成。

库存检查、预览、保存、导出和同步可指定 `--wait-ms 0..10000` 在受理后等候终态，默认立即返回。窗口到期时，用原任务标识继续查询。`request --method` 支持 status、shops.list、configs.find、configs.get、sources.find、sources.get、inventory.check、activity.list、jobs.status。修改操作使用专用命令。

更多参数与退出码见 [CLI 说明](../packages/agent-cli/README.md)。构建与启用策略见 [开发说明](./DEVELOPMENT.md)，正式程序通过软件内“更多 → 检查更新”升级。

## 与连续编辑界面协作

CLI 与界面使用相同的 NAS 保存权限和版本校验。界面正在编辑时先查询版本并预览改动，发生冲突按差异处理。配件行使用实际 slot 标识；删除新增行后其他编号保持不变，不应按当前数组位置推断配件名称。图片主题按链接管理，与界面浅深色切换无关。
