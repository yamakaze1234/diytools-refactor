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

Windows 可选 worker 放在本机 `data/runtime/erp-worker.exe`。主程序仅执行这个固定路径，不下载、释放或内嵌私有程序。开发模式在未安装外部 worker 时可使用本目录 `.venv` 的 Python，执行 `main.py`。

```powershell
uv sync --directory services/erp-worker --locked
uv run --directory services/erp-worker --locked python -B -m unittest -v
pwsh -File tools/build-erp-worker.ps1
```

打包脚本使用每次独立的构建环境，默认输出到 `sandbox/erp-worker-build/<本次目录>/optional-runtime/erp-worker.exe`；不会修改已有私有 `.venv` 或主程序资源。可用 `-OutputPath` 指定本机可选运行时目标。公开构建不需要私有包；生成的通用 worker 中没有私有适配器，必须另行在本机安装。

通用 worker 从本机 `data/runtime/erp-adapter.py` 动态加载适配器，要求两个入口：`create_client(credentials, *, domain)` 与 `api_factories()`。前者返回包含 `user`、`client`、`_check_res` 的兼容会话对象，凭据仅留内存；必须在发送登录之前关闭 HTTP 重定向。后者返回网店商品、商品明细、单品信息的三个只读 API 工厂，提供 `base_url`、`url`、`params()`。适配器及其依赖由用户本机维护，禁止进入公开源码、依赖锁文件和发行包。

HTTP 只读请求核验配置域名和三个允许的路径，拒绝重定向、歧义、截断分页和超过 500 条结果。关闭会话只清理本机客户端，不调用远端登出。错误响应不透传原始异常、密码或 Cookie。环境检查仅报告适配器能力，不尝试登录或查询。

SQL 入口独立于网页 ERP，保留固定的只读查询及本机预览/确认应用协议。SQL 密码使用 Windows 当前用户 DPAPI，路径由宿主固定为 `data/sql-credentials.dpapi.json`，不会写入业务状态或公开配置；只有读取、规范化和输出大小检查均成功后才保存。公开配置中不要填写账号和密钥。

已有用户升级时，先在用户本机保留对应运行时和 `integrations.json`，之后只替换主程序。私有目录、SQLite、凭据封套、登录信息和本机适配器都不属于 GitHub 发布资产。
