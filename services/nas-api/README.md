# NAS 工作台业务接口

本服务通过原工作台 `session.get` 核验身份，再逐请求读取 NAS 的成员启用状态与店铺角色。它不提供旧同步协议。默认 `NAS_DATASET=samples` 兼容旧样本只读接口；只有明确配置 `NAS_DATASET=intel_live` 才读取独立运行区，两种模式不会混读。

## 正式三店运行

使用已有正式站点及 `NAS_PROFILE=intel-production`、`PGDATABASE=diy_workbench`、`NAS_DATASET=intel_live`。英特尔继续使用原部署标识、初始批次与运行角色。两个新增店铺须一起启用，分别完整设置 `NAS_GIGABYTE_`、`NAS_JONSBO_` 前缀下的 `BOOTSTRAP_BATCH_ID`、`PASSWORD_FILE`、`IMAGE_ROOT`、`IMAGE_WRITE_ROOT`。角色、命名区与注册店铺固定；原图目录与上传目录逐店分开。新增命名区与运营组由管理员在同一正式库安装。数据库连接、批次或素材边界不匹配时不开始监听。

新客户端从 `GET /api/v1/me` 的 `shops` 和按店 `shop_capabilities` 获得可操作店铺，随后每条业务请求显式带 `shop_id`。无店铺参数的旧请求仍指英特尔，顶层能力字段也保持英特尔含义。调用前检查本店授权，写事务再次核对；回执限定员工和店铺。删除是业务归档，可以按本店权限恢复。三店成本和目录独立维护，移除组成员会撤销来自组的授权，既有英特尔直接角色继续生效。新两店的销售发布禁用。

准备脚本：`tools/build-production-three.py data` 生成一个固定批次的导入和只读回核；`access` 接收两个已核批次和审核过的云 UID 名单生成一条原子授权 SQL。生成的业务快照及含服务密码的权限 SQL 仅保存在私有目录。测试快照可以用 `tools/build-production-three-fixture.py` 生成；`tools/verify-production-three.mjs` 与 `test/production-three-api.integration.mjs` 使用隔离 PostgreSQL，不连接生产。

## 运行区与运营试验入口

`sql/003-intel-live.sql` 是单条事务 SQL。在 DBX 编辑器中选中全文件执行，初始化 `intel_live` 并逐条回组核对，不改接收区、旧样本、既有角色或正式库。首次初始化后再次执行不覆盖运营修改。全量验证命令：

```text
node --max-old-space-size=6144 tools/verify-live-import.mjs <完整接收区SQL路径>
```

运营列表、详情与加购仍沿用原路由。运行区详情增加完整 `document`、聚合 `version`、来源和成本版本 `dependencies`。来源、成本、模板、图库可按 ID 读取；已删除的资料不供新增引用。归档配置的列表或详情传 `archived=true`。

桌面主编辑器用 `GET /api/v1/operations/workspace-index` 读取配置定位摘要，`GET /api/v1/operations/workspace-catalog` 读取英特尔店铺设置、配件来源、成本及可用图库。只在打开、导航或导图时加载完整配置；索引不能参加保存。已创建的 `diy_api_operations` 账号需在试验库执行 `sql/005-main-editor-catalog-read.sql`，仅补读店铺设置权限。

| 保存用途 | 相对 `/api/v1/operations` 的接口 |
| --- | --- |
| 新建、整体保存 | `POST /configurations`、`PUT /configurations/{id}` |
| 单独保存图格式 | `PUT /configurations/{id}/design` |
| 归档、恢复 | `POST /configurations/{id}/archive`、`POST /configurations/{id}/restore` |
| 核查结果 | `GET /save-receipts/{operationId}` |

保存携带 UUID `operation_id`；更新、归档、恢复和图格式保存须提交原 `expected_version`，新建与整体保存提交完整文档和关联版本。服务在同一事务内检查运营授权、保存完整修改、更新聚合版本并写同员工回执和审计。相同人员同 ID 相同正文复用回执，正文变化拒绝。配置已有确认维护表价时，SPU/SKU 变更必须先重新核价，工作台价不会替代维护表价。新建配置没有确认维护表价，归档撤下发布，恢复不会重新发布。全量初始化不自动发布销售配置。

`GET /images/{sha256}.{png|jpg|jpeg}` 匿名访问，仅服务登记的摘要文件。首次读取和文件变化后核对格式、长度和 SHA-256；文件与业务资料分开挂载。

桌面端显式设置 `DIYTOOLS_NAS_MAIN=1` 和 `DIYTOOLS_NAS_API_URL=https://<可信内网入口>/` 后，启动英特尔 NAS 主工作区，沿用原表单、连续配件编辑、Canvas、长图/方图及原导出路径。此模式只复用现有账号认证配置，独立保留登录状态，不初始化本机工作区 SQLite、不接旧同步、不启动 Agent。未设置 `DIYTOOLS_NAS_MAIN=1` 的原工作区模式照常使用；仅设置 URL 时仍可使用以前的独立试验入口。

此模式下，表单、撤销、预览、导出及关闭只暂存草稿；点击“保存当前配置到 NAS”才提交配置。草稿按服务、工作区和账号隔离。版本冲突保留输入供比较，结果未知时只用原编号查回执，不自动重发。应用只将实际编辑字段投影到 NAS 原文；编辑器兼容默认项不在载入时写回。原图通过固定服务的摘要地址、无令牌读取并逐内容校验，持久化文档仍保存原有引用。旧云同步、ERP 写入及跨店修改在该模式下关闭。

## 四类目录管理

在试验库通过 DBX 编辑器整段执行 `sql/006-catalog-management.sql` 后，运行服务可用 `NAS_ENABLE_CATALOG_WRITES=true` 开通原输出源、加购、机箱图库和配置模板界面。目录写使用单独的操作号与版本，回执和审计同业务事务写入；未知结果按原编号查询。同一资源的普通运营权限仅覆盖本店自有内容，其他店的内容不能修改，共享内容按工作区、启用运营账号和资料类别单独授权；`shared=false` 不会把共同归属的资料改成本店自有。数据库运行角色不能授予该权限。

| 用途 | 相对 `/api/v1/operations/catalog` 的接口 |
| --- | --- |
| 读取目录或单条 | `GET /{sources\|addons\|gallery\|templates}` 或 `GET /{kind}/{id}` |
| 新建、编辑 | `POST /{kind}`、`PUT /{kind}/{id}`；共享加购与对应输出源共用版本 |
| 回收站、恢复 | `POST /{kind}/{id}/archive`、`POST /{kind}/{id}/restore` |
| 图库资料复制为本店自有 | `POST /gallery/{id}/copy` |
| 套用同一模板的所选配置 | `POST /templates/{id}/apply`，检查模板及目标配置版本，统一使用目标链接的 SPU，不复用原 SKU、维护表价或发布状态 |
| 上传及未知结果核对 | `POST /assets?operation_id={uuid}`、`GET /receipts/{operationId}` |

既有加购文档默认为保存时的快照，不会跟着输出源重算。原加购编辑器可显式启用“跟随来源”，显示值与保存快照分离；若报价来源或启用选项改变，旧依赖版本不能继续提交。停用的跟随选项不对销售提供；成本、内部说明和来源身份继续不对销售开放。

`NAS_IMAGE_WRITE_ROOT` 是新 PNG/JPEG 的可写目录，必须与原迁移素材目录分开；不配置时不开放上传。接口校验完整解码、尺寸、大小及摘要，匿名读取只认已登记内容。图库换图生成新摘要引用；已有配置和模板保留原图。引用中的资料不能回收，且没有物理删除素材的入口。

## 英特尔工作区运营

在试验库由管理员通过 DBX 编辑器整段执行 `sql/007-workspace-operations.sql`，再在服务候选启用 `NAS_ENABLE_WORKSPACE_WRITES=true`。此权限不授予直接编辑导入原报价、共享成本或原店铺设置，也不预先发布任何配置。

- 原配置和链接的增删恢复、复制、排序、批量维护、WPS 与标准商品 JSON 使用 `POST /api/v1/operations/workspace/configurations`。一批最多 100 项、1 MiB，同一批事务原子；较大计划明确分批、逐批显示结果。接收前检查配置版本和来源/成本版本，涉及整链接还核对成员清单。失去响应时保留原操作号，`GET /api/v1/operations/workspace/receipts/{id}` 只查结果，客户端不自动重发。
- 备份导入只提取有效的英特尔配置副本，不还原原业务库、凭据、历史队列或其他店。缺素材或来源显式列出；新副本不继承平台身份和销售报价。标准商品导入是已选链接的有意匹配流程，保留明确核对的 SKU。
- `POST /api/v1/operations/workspace/costs` 保存英特尔自己的成本/库存观察和含税价。专属记录中的未知值保持空，原有共享成本、人工覆盖和配置正文快照保留。桌面读取公司 ERP 使用原安装中的现存 SQL 只读凭据，不经 NAS 存放或写回。读取与“应用”是两步。
- `POST /api/v1/operations/workspace/settings` 保存英特尔自己的设置和利润预警。只读原店铺档案和其他店铺保持不变。
- `GET/POST /api/v1/operations/workspace/quotations` 查看单套正式报价、确认维护表报价与发布或撤回。原生只读 XLSB 综合表 INTEL 的 H 列，要求 SPU/SKU 文本精确匹配，保留行号与工作簿 SHA；未匹配、重复、空价不补零。确认价格不自动发布；工作台价和利润永远不是销售接口的对外价。已报价配置更正身份前仍需业务重核。
- `GET /api/v1/operations/workspace/activity` 查看此工作区最多 200 条英特尔操作的元数据，接口不提供旧本机历史记录或其他工作区审计。

原工作区价格与利润表的修改先存为本机草稿，点击表内保存才提交。库存核对和导出以可销库存及实际 BOM 为依据，不写 ERP；历史三店同步、跨店复制、旧 Agent 和本机备份覆盖不启用。

`sql/004-runtime-operations.template.sql` 仅在核对运行区后创建独立 `diy_api_operations` 账号。生成器在操作系统用户的私有目录中写含随机密码的 SQL 与密码文件：

```text
py -3 tools/prepare-operations-role.py --output <当前用户私有目录内的新文件夹>
```

模板不修改既有只读账号，没有接收区、成员修改、价格修改、销售发布或建表权限。实际连接和业务事务回滚可用 `tools/verify-runtime-write.mjs` 独立验证；需预先设置 `PGHOST`、`PGPORT`、`PGDATABASE=diy_workbench_trial`、`PGUSER=diy_api_operations` 和 `PGPASSWORD_FILE`。脚本不提交或保留测试配置。

`deploy/compose-intel-trial.yaml` 是同一长期服务接入试验库的更新候选，沿用 `diy-workbench-api` 和本机回环端口 `18080`。需要新程序目录、已核对的迁移素材目录、NAS 私有密码文件以及现有可信 HTTPS 入口。准备配置、在本机测试或在数据库中安装角色，均不表示 NAS 服务已更新或桌面已发布。

## 旧样本模式

- `GET /api/v1/me`：本人 UID、工作区、授权店铺及角色。
- `GET /api/v1/operations/configurations`：运营配置列表，支持 `shop_id`、`search`、`limit`（1—100）、`offset`。
- `GET /api/v1/operations/configurations/{id}`：配置与展示/实际 BOM、成本快照。
- `GET /api/v1/operations/configurations/{id}/addons`：加购定义、快照或独立覆盖后的文案和金额、关联配件。
- 对应 `/api/v1/sales/...`：仅返回已发布配置的销售字段，拒绝访问运营接口；过滤成本、利润、内部备注、原始快照和服务器路径。纯文案加购暂不向销售开放。
- `/healthz` 只检查进程；`/api/v1/me` 成功才同时覆盖真实身份验证和数据库授权读取。

所有业务入口均需 `Authorization: Bearer <原工作台访问令牌>`。没有用户组或店铺授权即拒绝。原身份最多缓存 30 秒，过期后上游故障不延长缓存；本地停用每个请求生效。旧样本不开放写入；运行区写入每次重新验证原账号。

金额字段 `final_price_cents`、`additional_price_cents` 是十进制整数字符串，单位分；使用字符串避免 PostgreSQL bigint 被 JavaScript Number 截断。缺失返回 null，不补零。版本也是十进制字符串。

## 数据合同

| 内容 | 读取来源 | 责任与边界 |
| --- | --- | --- |
| 配置身份 | configurations、products | SPU、SKU、商品码按文本；软删除和构造示例不返回 |
| 价格 | configuration_prices + nas_business.sales_publications | 当前只选维护表 workbook 的明确批次；不自动采用工作台原价，不自动推算优惠券 |
| 发布 | nas_business.sales_publications.published | 默认未发布；存在 SPU 不等于可向销售展示 |
| 展示与实际 BOM | configuration_parts.part_kind | 销售仅展示行；运营可读实际行及成本 |
| 加购文案/金额 | configuration_addons + addon_options | 显式覆盖优先，其次快照字段，再按跟随读取共享定义；缺失不代填 |
| 加购配件 | addon_items + components | 当前只读导入定义；写入阶段须补齐配件快照及共享修改版本约束 |
| 身份与角色 | 原账号 + nas_business.members/shop_roles | 可信 UID 授权，不接受客户端自报角色或姓名；管理员维护授权 |
| 共用配件 | 现有 component/source 标识 | 只读保持原引用，暂不合并、复制、分配跨店写权限；迁移和编辑前确认归属 |

旧样本详情不是完整编辑文档；完整保存只对独立运行区开放。两种模式均将报价记录的选择与销售发布分开：运营可以看到选定的价格，销售还需 published=true。

## 验证与部署

```text
npm ci --ignore-scripts
npm test
node tools/build.mjs <仓库外打包目录>
```

部署采用官方 `node:24-bookworm-slim` 预构建镜像，挂载打包后的 server.mjs，无需 NAS 构建或安装依赖。`deploy/compose.yaml` 是模板；先完成试验库 SQL、只读运行身份及密码文件，再填写原认证地址。部署文件不包含数据库密码。

部署时设置 `NAS_UID` 和 `NAS_GID`，使用实际挂载目录及密码文件的属主、属组；模板不再假定 `1000:1000`。此模板修改不会自动更新已运行的容器。

只通过同一个服务对局域网 IP 开放 HTTPS 时，可显式设置 `NAS_TLS_PORT`、`NAS_TLS_LAN_CIDR`、`NAS_TLS_CERT_FILE` 与 `NAS_TLS_KEY_FILE`；四项必须齐备。证书需有与访问 IP 相同的 IP SAN。只把 HTTPS 端口绑定到 NAS 的指定内网 IP，并让服务检查真实 TCP 来源；不接受客户端的 `X-Forwarded-For` 放宽范围。配置 TLS 后原回环 HTTP 只保留健康检查，业务和图片都走 HTTPS。证书私钥和连接密码由限权私有目录只读挂载。

若 Docker 发布端口会把连接源改写为桥接网关，应保留来源检查，并以同一服务的宿主网络绕开改写。此时必须设置 `LISTEN_HOST=127.0.0.1` 及独立 `NAS_TLS_LISTEN_HOST=<网段内的NAS地址>`，不写 `ports` 映射；数据库用已存在的可达试验库地址及原有限角色。

独立 Tauri 测试包可合并 `apps/desktop/src-tauri/tauri.nas-lan-test.conf.json` 构建，使用独立应用标识、便携数据目录及 WebView2 配置目录。在其 `data/nas-ca.pem` 放该期公共 CA 证书，原生 NAS 客户端只向此根信任，仍核对证书 IP 和有效期；原账号认证继续使用原信任通道。无窗口 `--verify-nas-lan-tls <新报告文件>` 仅验证公开健康检查，不启动窗口或读取登录凭据。

只读角色只授予接口需要的表 SELECT，不授予写入或建表权限。密码通过单独文件只读挂载，不放在源码、镜像、日志或公开附件中。回环端口 18080 供宿主机 HTTPS 反向代理；同 Docker 网络的代理也可访问 `diy-workbench-api:8080`。不配置公网转发。

本地测试和数据库只读验收不等于 NAS 容器、HTTPS入口或真实登录已通过；实际运行结果须另行记录。

## 全店迁移准备

`tools/export-intel.py` 在同一个 SQLite 只读事务中提取英特尔有效配置、完整本店输出源、相关成本、模板和引用图库，保持完整文档及空商品码。跨店引用保留原归属，共用成本和图库单列。内置特殊来源从现有客户端规则读取并记录规则摘要。软删除文档仅留本地归档，认证资料、旧同步队列与历史库不导出。素材按内容摘要保存，缺失依赖进入范围报告。

`tools/reconcile-workbook.py` 需要 Python 的 `pyxlsb`。它只读取已保存 XLSB 的“综合表”，校验列头，以平台 INTEL、文本 SPU 和文本 SKU 精确匹配 H 列到手价。重复、缺失或数值型长商品码不自动匹配；结果记录行号和文件 SHA256。这是已保存公式缓存值，工具不重算工作簿，不用工作台价填补缺失。

`tools/build-import.py` 校验导出包并生成单条 DO 事务 SQL，仅允许 `diy_workbench_trial`。新增 `nas_import` 接收区，保存完整配置、依赖、价格核对和素材索引；不覆盖 `intel_v2` 样本、不改变权限，也不自动成为运行数据源。同批次重复执行仅核对，异常整批回滚。SQL 含私人业务数据，输出必须放仓库外。只有数据库回读完成后才能记录为已导入。

```text
py -3 tools/export-intel.py --source <现用SQLite> --output <新的私人快照目录>
py -3 tools/reconcile-workbook.py --snapshot <快照目录> --workbook <维护表.xlsb> --output <快照目录>/workbook-prices.json
py -3 tools/build-import.py --snapshot <快照目录> --output <新的私人SQL目录>
node --max-old-space-size=6144 tools/verify-import.mjs <私人SQL目录> <新的隔离测试目录>
```

`apps/desktop/public/workbench/nas-api-client.js` 提供配置列表、详情、加购与回执接口。金额与版本保持字符串，禁止自动重试和重定向。真实 NAS HTTPS 容器、员工端与现用编辑器切换须另行验收。
# 英特尔正式库独立候选

正式数据从已核对的现用 SQLite 一致副本和主机维护表保存值生成。`tools/build-production-intel.py` 生成仅允许 `diy_workbench` 的单条 SQL，原文接收、运行表、逐项回组同一事务；`tools/verify-production-intel.mjs` 在隔离 PostgreSQL 内核验证。保留其他店、原试验库和已有结构，不把试验覆盖或测试项复制到正式。

数据迁移与用户授权分开。核对正式数据提交后，使用 `tools/build-production-access.py` 以私有文件中的已核对 UID 和随机密码生成最小正式权限。其默认只有一个已核对的英特尔运营成员；运营可新建本店图库，无共享图库委托，销售仍没有已发布配置。私有材料不进入源码、显示器日志或公开包。

正式运行采用 `NAS_PROFILE=intel-production`、`PGDATABASE=diy_workbench`、`PGUSER=diy_api_intel_production`、匹配的 `NAS_BOOTSTRAP_BATCH_ID`，以及形如 `intel-production-v1` 的 `NAS_DEPLOYMENT_ID`。`deploy/compose-intel-production.template.yaml` 是未部署的独立示例；使用新局域网监听端口（示例 19443）、运行身份、图片写目录和私有 CA。试验接口继续用原端口与库。正式 API 要求对应 `X-Workbench-Deployment`；原生客户端发送账号请求前先核对可信 HTTPS 健康路由的部署标识。匿名图仍通过摘要地址访问，桌面取图前同样核对环境和文件摘要。

Windows 独立包使用 `tauri.nas-intel-production.conf.json` 和 `--features formal-nas-client` 构建。在专用便携目录设 `DIYTOOLS_NAS_MAIN=1`、`DIYTOOLS_NAS_API_URL` 和 `DIYTOOLS_NAS_DEPLOYMENT_ID`，随包提供正式专用的 `data/nas-ca.pem` 公钥；无正式配置不会退回初始化本机库。草稿和登录凭据按正式 URL 与部署代号隔离。导入后未切换正式服务时，不以本地候选测试作为正式上线证据。
