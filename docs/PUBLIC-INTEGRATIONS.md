# 本机可选接入

公开源码与默认发布包保留本地工作台、通用云成员登录/同步协议及 ERP 只读接口，不含实际服务地址、环境 ID、账号、密钥、业务库、私有 ERP 包或私有运行时。没有云配置时，程序直接打开本地工作台，保留本机历史与缓存管理，不登录、不发起后台同步。

## 配置位置

配置只从应用实际数据目录的 `data/integrations.json` 读取；开发时同样使用宿主选定的数据目录。此文件禁止提交或包含在 GitHub Release 资产中，也不允许通过构建变量写进 EXE。结构示例见 [integrations.example.json](./integrations.example.json)，示例保留域名不能用于实际连接。

文件根对象使用 `version: 1`。`cloud` 与 `erp` 都可省略或置为 `null`。只需要本地功能时不创建文件，或只写 `{"version":1}`。

| 本机字段 | 含义 |
| --- | --- |
| `cloud.envId` | 用户自己的环境标识，限英文字母、数字、下划线与短横线 |
| `cloud.endpoint` | 自己部署、支持现有 CloudBase Auth/工作台协议的 HTTPS 根地址 |
| `erp.domain` | 本机 ERP 适配器使用的 HTTPS 根地址 |

服务地址禁止附带用户名、密码、查询参数、片段或非根路径。页面请求不能替换地址。云 HTTP 禁止重定向，访问令牌只驻留原生内存；登录后继续核验主体与正式工作空间成员身份，不允许匿名身份直接同步。更改本机配置后需正常重启程序。

## 未配置的行为

云状态保留 `authenticated`、`member` 字段并增加 `configured`。未配置时 `configured=false`、`authenticated=false`、`member=null`、`code=CLOUD_NOT_CONFIGURED`，`resume` 也返回这个本地状态。登录、绑定与需要云身份的请求在联网前被拒绝，错误前缀为 `CLOUD_NOT_CONFIGURED:`。缺少配置不会把本地编辑变成登录前置条件。

已配置但格式错误返回 `CLOUD_CONFIG_INVALID:`，不会自动尝试任何预设服务。真实网络故障与未配置状态分开处理，已配置服务的失败不作为成功登录或同步证据。

ERP 网页未配置返回 `ERP_NOT_CONFIGURED`；缺少可选 worker 返回 `ERP_RUNTIME_UNAVAILABLE:`；缺少或不兼容的本机适配器返回 `PACKAGE_UNAVAILABLE`。这些只限制 ERP 功能，本地工作台继续使用。

## ERP 可选运行时

Windows 正式版仅从本机 `data/runtime/erp-worker.exe` 启动可选运行时，不内嵌私有公司包，不从页面指定路径，不自动下载安装。开发模式可回退到 `services/erp-worker/.venv` 的 Python，运行公开的通用 JSONL 服务。

通用 worker 的本机适配器放在 `data/runtime/erp-adapter.py`，提供 `create_client(credentials, *, domain)` 与 `api_factories()`。详细协议与通用构建命令见 [ERP worker 说明](../services/erp-worker/README.md)。私有适配器及其依赖只由使用者在本机安装；公共锁文件不引用私有 Git 仓库。

ERP 与 SQL 凭据分别走内存会话与本机 Windows DPAPI。账号、密码、Cookie、业务数据都不属于 `integrations.json`。保留既有 `data/sql-credentials.dpapi.json` 封套即可继续本机自动填入，不解密写入公开文件。

## 既有本机升级

升级前，在用户明确选择的便携目录中准备对应版本的可选 worker 与本机 `integrations.json`，确认复制摘要一致，再替换主程序。既有冻结 worker 可以作为本机外部运行时继续使用；它的私有代码和配置不进入公开发行资产。当前使用 EXE、SQL 封套、SQLite 与原图不得因源码公开被覆盖或移走。

公开发布资产只包含通用主程序和公共资源。准备现有公司接入的文件、脚本和报告应始终留在私有沙箱与用户本机数据目录，不复制到上传工作树。
