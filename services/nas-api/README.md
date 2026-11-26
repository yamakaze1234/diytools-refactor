# NAS 工作台业务接口

本服务逐请求核验身份，再读取 NAS 的成员启用状态与店铺角色。正式三店可启用 NAS 签发的本地会话。它不提供旧同步协议。默认 `NAS_DATASET=samples` 兼容旧样本只读接口；只有明确配置 `NAS_DATASET=intel_live` 才读取独立运行区，两种模式不会混读。

## 正式三店账号认证迁移

1. 由正式库管理员执行 [认证表安装](sql/019-nas-local-auth.sql)。安装新增认证对象。用 [只读预检](sql/019-nas-local-auth-preflight.sql) 记录启用成员和三店生效授权数量。
2. 将 NAS API 切为 `NAS_AUTH_MODE=migration`，保留原 `AUTH_ORIGIN` 和正式部署标识。在此期间新旧客户端均可使用。已安装新客户端的成员用原账号密码登录一次，旧认证成功且 NAS 有同 UID 的启用成员时即登记。登记后的新客户端登录、续期和保存均直接使用 NAS。
3. 用预检确认启用成员大于零、缺失登记为零、三店生效授权与切换前一致，再换成 `NAS_AUTH_MODE=local` 并移除 `AUTH_ORIGIN`。此前登记的 NAS 会话延续可用，旧客户端需升级。健康接口报告 `auth_mode: local`。用已登记账号校验重启后免登、三店权限与保存回执。
4. 若需回退，优先恢复迁移模式及原 `AUTH_ORIGIN`，让已有 NAS 会话及旧客户端继续使用。需回退二进制时恢复上一部署及对应客户端。保留认证表，后续可继续登记。

NAS 保存随机盐和 scrypt 密码校验值，以及访问令牌和续期令牌的摘要。续期令牌会轮换，退出撤销设备会话。正式管理员可核对成员身份后运行 `node tools/set-local-password.mjs <workspace> <uid> <username> <display-name>` 设置或重置本地密码。连接使用既有管理员 PostgreSQL 配置，密码通过标准输入提供。该操作保留权限并撤销该账号的原设备会话。

## 正式三店运行

使用已有正式站点及 `NAS_PROFILE=intel-production`、`PGDATABASE=diy_workbench`、`NAS_DATASET=intel_live`。英特尔继续使用原部署标识、初始批次与运行角色。两个新增店铺须一起启用，分别完整设置 `NAS_GIGABYTE_`、`NAS_JONSBO_` 前缀下的 `BOOTSTRAP_BATCH_ID`、`PASSWORD_FILE`、`IMAGE_ROOT`、`IMAGE_WRITE_ROOT`。角色、命名区与注册店铺固定；原图目录与上传目录逐店分开。新增命名区与运营组由管理员在同一正式库安装。数据库连接、批次或素材边界不匹配时不开始监听。

新客户端从 `GET /api/v1/me` 的 `shops` 和按店 `shop_capabilities` 获得可操作店铺，随后每条业务请求显式带 `shop_id`。无店铺参数的旧请求仍指英特尔，顶层能力字段也保持英特尔含义。调用前检查本店授权，写事务再次核对；回执限定员工和店铺。删除是业务归档，可以按本店权限恢复。三店成本和目录独立维护，移除组成员会撤销来自组的授权，既有英特尔直接角色继续生效。新两店的销售发布禁用。

准备脚本：`tools/build-production-three.py data` 生成一个固定批次的导入和只读回核；`access` 接收两个已核批次和审核过的云 UID 名单生成一条原子授权 SQL。生成的业务快照及含服务密码的权限 SQL 仅保存在私有目录。测试快照可以用 `tools/build-production-three-fixture.py` 生成；`tools/verify-production-three.mjs` 与 `test/production-three-api.integration.mjs` 使用隔离 PostgreSQL，不连接生产。

### 工作台三店共用机箱图库

管理员在三店正式库 `diy_workbench` 整条执行 [016-shared-case-gallery.sql](sql/016-shared-case-gallery.sql)，再给现有 NAS 服务启用 `NAS_ENABLE_SHARED_CASE_GALLERY=true`。三个店铺的工作台都能从同一份有效图库选图。任意店铺保存图库后，数据库在同一事务内为各店登记原图摘要，原图文件存放在上传所在的素材目录，其他店可直接保存到配置或模板。只上传文件但尚未保存图库资料时，原图仍留在上传店。

图库创建、换图和归档等维护仍由原归属店和现有授权处理。回收站按归属店显示，归档前核对三店引用。更新图库原图时，已保存的配置和模板继续引用当时的原图。回退服务时保留数据库中的摘要登记，以便共享图片已被其他店铺引用的配置继续显示。

### 内网机箱图库

正式三店服务设置 `NAS_ENABLE_LAN_CASE_GALLERY=true` 后，内网客户端可以在同一个 HTTPS 地址调用 `GET /case-gallery/v1/images`。调用无需账号和请求头，忽略店铺归属，返回三店当前有效的机箱图库。服务按连接来源检查内网范围，接入方沿用该 HTTPS 地址的 NAS CA。

- `brand`、`model`、`color`、`edition` 分别精确筛选四级分类，忽略大小写。参数 `q` 在名称和分类中按空格拆分关键词。未填分类在 `categoryPath` 里显示为“待分类”或“通用”，可直接用于筛选。
- `limit` 为每页 1–100 张，默认 100。请求后续页时保留筛选条件，并传回 `nextCursor`。列表内容在 `items`，同分类同原图跨店合并。
- `view=categories` 返回四类选项 `enums` 和四级分类树 `categories`。可带分类筛选和关键词。
- `items[].downloadUrl` 为相对于接口地址的同源路径。对该路径发起 `GET` 下载原图，或用 `HEAD` 检查链接。归档会从列表移除条目，且无其他可用条目引用的原图会停止通过此入口下载。

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

保存携带 UUID `operation_id`；更新、归档、恢复和图格式保存须提交原 `expected_version`，新建与整体保存提交完整文档和关联版本。服务在同一事务内检查运营授权、保存完整修改、更新聚合版本并写同员工回执和审计。相同人员同 ID 相同正文复用回执，正文变化拒绝。安装迁移 027 后，修改 SPU/SKU 会在保存时撤下原销售发布并失效旧编码报价；保存后按新编码核价。旧库沿用原报价保护。新建配置没有确认维护表价，归档撤下发布，恢复不会重新发布。全量初始化不自动发布销售配置。

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

所有业务入口均需 `Authorization: Bearer <访问令牌>`。没有用户组或店铺授权即拒绝，本地停用每个请求生效。旧样本为只读。旧认证模式读请求最多缓存身份 30 秒，写入仍请求原身份服务。

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
| 身份与角色 | NAS 会话 + 原 UID 对应的成员与三店授权 | 可信 UID 授权，不接受客户端自报角色或姓名；管理员维护授权 |
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

## 配置回收站与已删除输出源

`sql/032-recycle-retention.sql` 为回收站接口和定时清理提供数据库函数，可重复安装。API 和桌面客户端不会自动安装迁移。迁移解除两张历史表对配置的外键依赖，保留历史行和原图；配置彻底删除后，仍可按原配置 ID 查审计和回执。已删除输出源仅在配置（含归档）与模板引用都为零时可清理。对应共享别名随之移除，最后一个别名移除时清理共用条目。

可写的 live 服务默认在就绪 60 秒后巡检第一次，此后每小时逐店清理归档满 7 天的配置和停用满 30 天且无引用的本店输出源。只读服务不会启动巡检。`NAS_ENABLE_RETENTION=false` 关闭定时清理，`NAS_RETENTION_INITIAL_DELAY_MS` 和 `NAS_RETENTION_INTERVAL_MS` 分别调整启动延迟与周期间隔（毫秒）。迁移未安装时，依赖它的接口返回 `NAS_RETENTION_NOT_INSTALLED`。

隔离验收使用 `node test/recycle-retention.integration.mjs <合成三店SQL目录>` 与 `npm test`。

## 三店共用核算价

`sql/020-workbench-global-tax.sql` 是待管理员安装的事务候选，依赖已经安装的共用输出源和三店价格历史结构。客户端和 API 不自动执行 SQL。先安装 SQL、再切换 API；未安装时 `global_tax` 返回 `NAS_GLOBAL_TAX_NOT_INSTALLED`。安装脚本可重复运行，不重置已有价格与恢复基线。回退 API 后保留该结构和现有记录即可，旧入口仍按原单店权限工作。

全局改价沿用 `workspace/costs`、操作编号和回执，仅接受一条 `global_tax`：`expected_version` 为当前店版本，`expected_versions` 必须含 `intel/gigabyte/jonsbo` 三店成本版本（缺行用 `null`）；`fields` 为 `{tax:金额}` 或 `{restore:true}`。服务端在同一事务中重新检查三店运营权限和全部版本，统一成本与输出源价格，记录各店的首次原价、服务端时间和成员，并写入每店价格历史、审计和回执。恢复前有任何店失去有效标记则整笔拒绝；结果未知时只能先查原编号回执。

`tax_edit`、`tax_file`、ERP 快照和其他来源核算价变更会使旧恢复标记失效。匹配新全局价的配置独立覆盖可取消，配置版本随之递增，原草稿仍需按既有冲突流程核对。

隔离验证：`node test/global-tax.integration.mjs <合成三店SQL目录>`。该测试使用 PGlite 和真实生产角色，不连接正式数据库；普通单元测试仍为 `npm test`。

### 三店成本表与 ERP 同步

迁移 `027-quotation-identity-invalidation.sql`、`028-cross-shop-cost-sync.sql`、`029-manual-tax-protection.sql` 与 `030-incoming-stock.sql` 要在三店 NAS 库由管理员依次安装，随后部署支持相应接口的 API，再更新客户端。重复执行只更新函数及授权。旧库的配置换码仍沿用原报价保护，缺少三店同步函数时新 API 返回 `NAS_COST_SYNC_NOT_INSTALLED`。

ERP 商品类别上线顺序：

1. 管理员确认连接的数据库为 `diy_workbench`，并已按顺序安装至 030，再用 `psql -v ON_ERROR_STOP=1 -d diy_workbench -f services/nas-api/sql/031-erp-category.sql` 执行类别迁移。连接参数沿用正式库管理方式。迁移可重放，锚点不匹配会回滚。
2. 在 DPanel 更新 `diy-workbench-api`，保留三店现有账号和配置。检查健康状态，并用运营身份回读三店成本快照。
3. 发布与上述接口配套的桌面客户端和签名 ERP worker 组件。升级后在工作台预览并确认 ERP 同步，回读三店分类。旧 worker 省略类别时保留已有值。

030 依赖已安装的 026 ERP 建源函数，扩展三店 ERP 成本同步快照、写入及 ERP 建源以支持待入可销。该迁移只更新函数，历史数据缺少该字段时显示未知。

工作台先通过 `GET /api/v1/operations/workspace/costs/sync-preview` 获取三店成本版本，再读取 Excel 或 ERP。发起店的在用运营账号即可确认。成本表动作 `tax_sync` 同步已有共用来源及三店核算价，手动核算价保留并固定为该店的覆盖。安装 `029-manual-tax-protection.sql` 后，在「输出源维护」中修改数字核算价以及在总表中执行「应用到全局核算价」均等效于在「维护 → 当前店铺核算价」手动改价，自动标记 `nasManualTax:true`，避免被后续成本表同步覆盖；单店点「重新同步核算价」、恢复跟随非手动共用价或执行「全局恢复」时按原状态解除保护。ERP 动作 `erp_sync` 统一三店的库存及 ERP 成本字段。每批最多 100 个货号，批内三店同时提交审计、价格历史及回执。版本冲突回滚当批并返回冲突货号，已确认的其他批次可从原回执核对。

隔离验收运行 `node test/cost-sync-quotation.integration.mjs <合成三店SQL目录>` 验证成本同步、待入可销及旧报价保护；运行 `node test/manual-tax-protection.integration.mjs <合成三店SQL目录>` 验证手动核算价在同步时保留、恢复后重新跟随成本表。

## 本链接与三店全局加购

总表中的“本链接”和“全局”读取对应输出源的完整加购规则，包含商品、数量、原配数量、金额、多方案和文案。“本链接”对本链接内匹配配件生成加购快照，先进入本机草稿，点击顶部保存后提交；不改变其他链接。预览冻结来源版本，应用时重新核对，明确确认本轮使用的来源依赖，不自动跳过后续冲突。配置的实际 BOM、整机售价及其他配件加购保持原值。

“全局”使用 `addon_sync:true` 的共享目录保存文档：`edits.shared.values` 仅含完整 `addon`，三店编辑均仅恢复 `addon` 共用值。服务端验证此形状，按 GoodID 更新共用加购并清除三店对应加购覆盖，保留店铺名称、核算价和硬件字段。该事务回执中的 `document.source_versions` 冻结本次各店来源版本；后续配置批次接续这些确认版本，不取更新后的任意版本覆盖旧依赖。此入口沿用已经安装的021版本回执能力，不增加 SQL 结构。

相关配置使用 `followPolicy:'follow'`、`followAll:true` 保存完整加购组；后续来源修改商品、数量、价格或新增/停用方案时，运营检查与销售接口解析同一有效规则。新配置选用该输出源时也保存实际加购记录。显式改为快照或移除加购会解除该来源整组跟随，防止刷新后重新出现已移除项；来源暂时没有启用方案时保留跟随标记，重新启用后可继续带出。销售接口仍过滤内部成本、备注和来源身份。

新全局任务使用格式2，在本机持久保存原操作号、正文和每批进度；未知结果只查原批次，显式重试仍以原号重放，后续未发送批次须再次继续。隔离验证：`node test/structured-upgrade.integration.mjs <合成三店SQL目录>`，覆盖三店来源、现有/新配置、销售读取及退出跟随。

### 旧版纯文案任务兼容

`sql/021-workbench-alias-addons.sql` 为待安装候选，复用共享输出源原有权限、版本和目录回执。在共享目录保存文档中可附 `alias_edits:{店铺:{sourceId:{addon:完整原规则加新文案}}}`，服务端仅允许这条扩展统一文本，拒绝借此改变商品、数量和其它规则。三店各历史别名保留自己的规则，原来继承共用商品的来源继续继承。普通单店加购维护仍可明确覆盖该店文案。

旧格式1的历史任务使用 `sourceFollow.upgrade.textOnly:true` 跟随顶层文案，保留原加购商品快照。恢复界面明确标记它是旧版纯文案计划，未知结果查询或原号重放均保持原正文，不将已发送请求改成格式2。新的按钮操作不再生成纯文案任务。

客户端在本机持久保存原操作号、正文和每批进度；结果未知只查询原批次，显式重试仍以原号重放，后续未发送批次须再次继续。未安装候选时扩展返回 `NAS_GLOBAL_UPGRADE_NOT_INSTALLED`，不会退回到覆盖同店第一条来源规则。隔离验证：`node test/global-upgrade.integration.mjs <合成三店SQL目录>`。

## 本机真实样本测试包

`nas-acceptance` 桌面只连接随包启动的回环 HTTPS 服务，使用独立的 `acceptance-data` 保存测试结果。在测试脚手架的 `fixture` 中显式提供格式1的 `real-samples.json`，可用三店少量配置、所引用的输出源/成本及原图替代合成样本。导入器要求实际连接对象为 PGlite，不能用于正式 PostgreSQL；样本内容不进入源码提交。包不包含正式服务地址、员工登录信息或 ERP 凭据，快照日期由随包说明标明。只在首次初始化本机样本库时导入，并在该隔离库启用020/021供测试三店全局操作；再次启动保留本机编辑。验收服务启动时幂等应用022，仅修正保存函数，不重导入样本或重置用户修改。

配置总表的“修改输出源”定位到该行的来源 ID，弹窗仅显示本店展示名称与结构化加购，保存沿用来源维护的权限、版本及目录回执。`sql/022-shared-source-field-preservation.sql` 修正单店部分字段更新的 JSON 运算括号，确保只改名称不会清掉原加购、数量、金额或硬件资料；正式服务不自动安装此 SQL，部署时仍需管理员执行。删除配置的工作区事务同时给本链接剩余普通配置连续编号，回执附带 `reordered` 的旧名称、新名称与前后版本；客户端据此接续未保存草稿和尚未发送的后续批次，未知请求正文保持原样。

维护界面明确修改“三店共用核算单价”时，同时恢复三店对应来源的核算价字段，避免旧店铺覆盖遮住新价；名称、加购和硬件覆盖仍保留。保存后仅对干净配置接续本次实际重读的来源及成本版本，已有草稿和未知请求继续沿用原冲突检查。

新建配件也可先切换三店共用及各店范围，身份字段共用，各范围输入分别保留；保存时必须有共用名称。创建文档可同时携带 `edits.shared` 与合法店铺差异，沿用022保存函数在同一目录事务中写入；仍要求三店运营权限，并保留原操作编号和回执校验。未保存前的范围切换不提交请求。隔离验证：`node test/source-scope-create.integration.mjs <合成三店SQL目录>`，覆盖同事务创建、原号重放和缺少权限时整笔拒绝。

“加购选配和福利”页编辑图片底部独立的加购与选配、专属福利文字，沿用配置保存和出图流程；历史商品、数量、价格和实际 BOM 字段原位保留。配件绑定的加购继续在总表和输出源维护。隔离验证：`node test/source-tax-extras.integration.mjs <合成三店SQL目录>`，核对旧核算价覆盖、三店有效价及独立文字保存。
