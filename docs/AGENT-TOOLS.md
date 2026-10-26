# 本机 AI 与 CLI 操作入口

正式 Windows 版本随主 EXE 内置配套 CLI。首次启动及升级重启时，在程序目录准备 `diytools-agent.exe`，并更新 `agent-connection.json`。直接运行工作台即可，不需要源码、Python、Node.js、PowerShell 启动脚本或手动设置启用变量。

入口只允许本机当前 Windows 用户和系统访问，按用户与实例隔离。AI 需要能够执行本机命令；网页聊天本身不能直接调用本机程序。CLI 经工作台现有业务接口操作，不直接打开数据库，不接受任意 SQL 或脚本执行。

## 开始使用

1. 运行工作台，按需要登录自己的成员账号，完成数据接入并保存当前编辑。
2. 将工作台安装目录授权给本机 AI，要求先读 `agent-connection.json`，使用其中的 `cli` 和 `instance`。
3. 先执行 `doctor`，以实际返回的 capabilities 判断当前可用功能。工作台重启后重新读连接文件，不能写死进程 ID。

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

查询来自最后成功保存的本机快照，不包含尚未保存的输入。

- 店铺 ID 使用 `shops list` 的稳定值。
- `--goods-id` 按实际 BOM 匹配；旧配置缺少实际 BOM 时按工作台规则回退展示配件，空 actualParts 数组表示空 BOM。
- `--sku`、`--spu` 保留字符串及前导零；缺失 SKU 不自行生成。
- 默认每页 20 条、最大 100 条；翻页传回 nextOffset 和同一 revision。期间发生保存时重新从第一页查询，避免版本混用。
- status 中 unknown 表示未检查，不代表保存或云同步成功。

## 修改、导出和同步

支持配件展示名称、升级描述、数量及输出源替换。先查询精确目标，再预览变更；计划有效且工作台没有未保存输入、冲突或占用操作时，才能通过专用 apply 命令保存。保存沿用工作台配件、实际 BOM、成本和草稿保护规则。

```json
{"shopId":"intel","targets":[{"configId":"查询返回的配置ID","partIndex":0,"expectedGoodsId":"原ERP商品码"}],"action":{"type":"upgrade","value":"新的升级描述"}}
```

```powershell
& $connection.cli --json --instance $connection.instance changes preview --input 'D:\任务\change.json' --operation-id '预览操作的UUID'
& $connection.cli --json --instance $connection.instance changes apply --plan-id '成功预览返回的planId' --operation-id '保存操作的UUID'
```

导出可选择当前已保存版本，或引用某次成功保存的 operationId，固定对应快照。支持配置图、SKU 图、HTML、manifest 及 ZIP；使用真实 Canvas 和原生落盘，回执返回实际路径、字节数与 SHA256。ERP 价格为保存时的快照，不能代表实时查询结果。

```json
{"configIds":["配置ID"],"revision":42,"images":"both","report":true,"outputDir":"D:\\导出"}
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

本机保存、文件导出、云同步分别确认。AI 应只在任务授权范围内发起 sync；工作台既有自动同步仍按用户设置运行。云同步使用当前成员会话，失败或存在冲突时保留本机资料，并在工作台处理后重试。

## 任务结果与重试

保存、导出及同步必须提供 UUID 格式 operationId；每项业务操作一个 ID，重试保留原 ID 与原参数。传输超时或状态未知时先查原任务，不能换新 ID 盲目重做。

queued / running 只是排队或执行中；继续查询 jobs status，直到 succeeded / failed / interrupted，并检查 result 或 error。没有界面连接、存在人工未保存输入或冲突时会明确拒绝，不伪造完成。

`request --method` 仅开放 status、shops.list、configs.find、configs.get、jobs.status 五种只读方法。其他修改使用专用命令，无原始写入逃生接口。

更多参数与退出码见 [CLI 说明](../packages/agent-cli/README.md)。构建与启用策略见 [开发说明](./DEVELOPMENT.md)，正式程序通过软件内“更多 → 检查更新”升级。

## 与连续编辑界面协作

CLI 与界面共用本机保存和版本校验。界面正在编辑时先查询版本并预览改动，发生冲突按差异处理。配件行使用实际 slot 标识；删除新增行后其他编号保持不变，不应按当前数组位置推断配件名称。图片主题按链接管理，与界面浅深色切换无关。
