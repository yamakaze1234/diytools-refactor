# 源码开发

## 环境与运行

Windows 开发需要 PowerShell 7、Node.js 24+、pnpm 11、Rust stable、Windows C++ 构建工具与 WebView2 Runtime。

```powershell
git clone https://gitea.cq360.top/CoreStudio/diy-tools-refactor.git
Set-Location diy-tools-refactor
pnpm install --frozen-lockfile
pnpm dev
```

`pnpm dev:web` 仅运行前端。保存、同步、ERP 和软件更新需要 Tauri 宿主。开发数据与发行版数据独立；可选 ERP 环境见 [ERP worker](../services/erp-worker/README.md)。

## 测试与构建

```powershell
node --test apps/desktop/tests/*.test.mjs apps/desktop/tests/legacy/*.test.mjs packages/*/tests/*.test.mjs tools/*.test.mjs
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --lib
pnpm build:web
pnpm build:desktop --no-bundle
```

按改动范围运行必要测试。集成服务、原生窗口与实际数据流程需要各自验收，不能由构建成功代替。可分发程序按[发布流程](PUBLIC-RELEASE.md)打包。

## 目录

| 路径 | 内容 |
| --- | --- |
| `apps/desktop/src/` | React 宿主与桌面桥接 |
| `apps/desktop/public/workbench/` | 工作台页面、业务规则、绘图 |
| `apps/desktop/src-tauri/` | Rust 存储、同步、历史、更新 |
| `services/erp-worker/` | 可选 Python ERP 协议与服务 |
| `packages/` | 共享模块 |
| `tools/` | 检查、构建、打包与发布工具 |
| `docs/` | 当前有效的使用与维护文档 |

## 文档约定

README 面向首次使用者，保留下载入口与产品简介。docs 只维护当前有效的使用、接入、架构、开发和发布说明；版本变化放在 Releases。阶段计划、会话记录、验收日志、截图和临时报告保存在仓库外，不加入源码提交或发行附件。

业务库、素材、账号、集成配置、私有适配器与签名私钥只保留本机。提交前运行 `py -3 -X utf8 tools/audit-public-tree.py --root .`。
