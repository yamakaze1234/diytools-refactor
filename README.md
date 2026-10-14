# DIY Tools Refactor

Windows 配置工作台，使用 Rust、Tauri 2、React/TypeScript 和浏览器绘图模块。支持配置编辑、配件与成本核算、历史恢复、批量操作和图片导出。现有工作台页面由 React 宿主承载，业务数据存入本机 SQLite。

下载与软件内更新共用本仓库的 [Releases](https://github.com/yamakaze1234/diytools-refactor/releases)。完整便携 ZIP 用于首次安装，签名 EXE 用于后续一键更新。当前仓库为私有；改为公开后，更新地址不变。

## 使用

参见 [使用说明](docs/PUBLIC-USAGE.md)。本仓库和发行包不包含业务库、真实服务配置、企业私有依赖或登录凭据。首次启动可直接使用本地模式，集成功能通过本机配置启用。

## 开发与验证

Windows 安装 PowerShell 7、Node.js 24 或更高版本、pnpm 11、Rust stable、Windows C++ 构建工具和 WebView2 Runtime。

```powershell
pnpm install --frozen-lockfile
pnpm build:web
pnpm build:desktop --no-bundle
$tests = @(rg --files apps/desktop/tests | Where-Object { $_ -match '\.test\.mjs$' })
node --test @tests
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --lib
```

Python 适配层为可选功能，其安装与协议见 [ERP worker](services/erp-worker/README.md)。桌面构建无需私有依赖。开发模式的数据目录是本机 `sandbox`，正式便携程序使用相邻的 `data`。

公开测试使用合成数据；包含用户截图经营明细的历史回归样本保留在发布者本机，未纳入仓库。

## 发布

参见 [签名发布流程](docs/PUBLIC-RELEASE.md)。发布私钥只保存在发布者本机；源码仅包含验证公钥。版本包和签名清单绑定，不从用户安装目录制作公开 ZIP。
