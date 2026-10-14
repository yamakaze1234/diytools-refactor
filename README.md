# DIY 配置工作台 · 重构版

面向 DIY 整机业务的 Windows 本地优先工作台，用于维护商品配置、核算成本与利润、读取 ERP 库存和制作配置图。当前源码版本为 **0.2.6**，采用 Rust、Tauri 2 与 React/TypeScript；现有工作台页面由 React 宿主承载，本机 SQLite 保存业务数据。

源码仓库：[Gitea](https://gitea.cq360.top/CoreStudio/diy-tools-refactor) · [GitHub](https://github.com/yamakaze1234/diytools-refactor)。版本以根目录 `package.json`、桌面 `package.json`、Tauri 配置与 Cargo 包版本为准。

## 本次更新

0.2.6 新增首次登录空目录的两种初始化方式：从云端下载全部资料，或选择旧版 data 目录自动迁移。迁移保留已保存未同步修改及可用同步基线，旧目录只读。修复成本源粘贴保存中的时间戳误冲突，并避免 SQL 回载期间开始新编辑。

详见 [0.2.6 更新说明](docs/RELEASE-0.2.6.md)。新组员使用管理员提供的内部使用包；公开程序不携带团队接入配置。旧物理历史与生成缓存留在原目录。

程序与便携 ZIP 见 [Gitea Releases](https://gitea.cq360.top/CoreStudio/diy-tools-refactor/releases)，源码 ZIP 不含可直接运行的程序。

## 快速入口

| 我想做什么 | 入口 |
| --- | --- |
| 下载程序与查看版本变化 | [Gitea Releases](https://gitea.cq360.top/CoreStudio/diy-tools-refactor/releases) |
| 使用备用下载源 | [GitHub Releases](https://github.com/yamakaze1234/diytools-refactor/releases) |
| 第一次使用或查操作流程 | [使用说明](docs/PUBLIC-USAGE.md) |
| 了解系统组成和数据位置 | [系统架构](docs/PUBLIC-ARCHITECTURE.md) · [交互架构图](docs/diagrams/architecture.html) |
| 配置自己的同步与 ERP 接口 | [本机可选接入](docs/PUBLIC-INTEGRATIONS.md) |
| 构建、签名与发布版本 | [签名发布流程](docs/PUBLIC-RELEASE.md) |

## 主要功能

| 模块 | 能力 |
| --- | --- |
| 商品与配置 | 按店铺、商品链接维护配置；选择配置后加载详情，编辑中的配置保持加载 |
| 配件与价格 | 实际配件、展示配件、数量、售价、成本、利润和升级说明 |
| 批量维护 | 批量替换配件、修改内容、统一排版和导出图片 |
| 图片制作 | 机箱素材、图片与文字图层、配置图与 SKU 图、单张和批量导出 |
| 历史与空间 | 本机历史、还原、恢复草稿、缓存预览与清理 |
| 团队同步 | 配置外部服务后登录，先保存本机，再手动或每 2 小时同步；冲突需处理 |
| ERP 与库存 | 安装本机适配器后只读查询，预览差异再应用至本机配置 |
| 软件更新 | Gitea 优先、GitHub 备用，验证签名后更新 Windows 程序 |

## 三分钟上手

1. 下载 Windows 便携 ZIP，完整解压至可写目录，运行 `DIYTools.exe`。
2. 无外部配置时直接使用本机模式；需要团队登录与 ERP 时由管理员准备本机接入文件。
3. 选择店铺、链接和配置，修改配件、价格及说明，保存到本机。
4. 调整图片布局，选择配置图或 SKU 图导出；批量文件夹使用链接名称区分。
5. 已连接团队服务时，在“数据与同步”查看进度或立即同步，可关闭窗口继续编辑。
6. 在“更多 → 检查更新”查看新版，并按提示执行一键更新。

升级已有工作台或遇到保存冲突时，按[使用说明](docs/PUBLIC-USAGE.md)保留完整数据与草稿。

## 系统架构

![DIY Tools 重构版系统架构](docs/diagrams/architecture.png)

[打开交互架构图](docs/diagrams/architecture.html) · [查看架构 JSON](docs/diagrams/architecture.json) · [阅读架构说明](docs/PUBLIC-ARCHITECTURE.md)

React 宿主在 iframe 中承载现有工作台，桥接层将受支持的页面请求转换为 Tauri IPC。Rust 负责本机存储、历史、后台同步和更新；ERP 通过可选的本机 Python 运行时接入。图中外部服务表示可选连接，发行包不提供现有团队的访问权限。

## 源码运行

Windows 需要 PowerShell 7、Node.js 24 或更高版本、pnpm 11、Rust stable、Windows C++ 构建工具和 Microsoft Edge WebView2 Runtime。

```powershell
git clone https://gitea.cq360.top/CoreStudio/diy-tools-refactor.git
Set-Location diy-tools-refactor
pnpm install --frozen-lockfile
pnpm dev
```

仅查看前端可运行 `pnpm dev:web`；涉及本机保存、ERP、同步和更新的功能需要 Tauri 宿主。Python 适配层为可选功能，见 [ERP worker](services/erp-worker/README.md)。开发数据与发行数据相互独立。

## 测试与打包

```powershell
$tests = @(rg --files apps/desktop/tests | Where-Object { $_ -match '\.test\.mjs$' })
node --test @tests
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --lib
pnpm build:web
pnpm build:desktop --no-bundle
```

以上检查不代表已完成真实团队服务或原生窗口验收。可分发 ZIP、签名和 Release 按[发布流程](docs/PUBLIC-RELEASE.md)制作。

## 目录

| 路径 | 内容 |
| --- | --- |
| `apps/desktop/src/` | React 宿主、登录界面与旧页面桥接 |
| `apps/desktop/public/workbench/` | 配置工作台页面、业务规则与绘图模块 |
| `apps/desktop/src-tauri/` | Rust 本机服务、SQLite、同步和签名更新 |
| `services/erp-worker/` | 可选 Python ERP 适配协议与通用服务 |
| `tools/` | 源码检查、构建、打包与发布工具 |
| `docs/` | 使用、接入、架构与发布文档 |

## 数据边界

仓库和发行包不包含业务库、原图、恢复草稿、真实服务地址、账号、密钥或企业私有 ERP 依赖。真实接入文件仅保存在本机；发布私钥留在发布者电脑，源码仅包含验证公钥。

便携程序使用 EXE 相邻的 `data`。升级、迁移或备份应保留完整目录；不要用空目录覆盖现有数据。旧版仓库与轻量网页版本独立维护，本仓库面向 Windows 重构工作台。

本仓库尚未指定开源许可证；第三方依赖与品牌素材保留各自权利。
