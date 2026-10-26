# 系统架构

重构版使用 Tauri 2 与 Rust 处理本机能力，React 负责宿主、登录、连续配置表、外围面板和桥接。配置领域逻辑、保存与绘图复用工作台控制器，在同源 iframe 内运行。Windows 使用 WebView2 显示界面，当前不是纯原生控件界面。

![系统架构](diagrams/architecture.png)

[交互架构图](diagrams/architecture.html) · [图源 JSON](diagrams/architecture.json)

## 组件职责

| 组件 | 责任 | 代码入口 |
| --- | --- | --- |
| React 宿主 | 启动登录、iframe 生命周期、原生关闭保护 | `apps/desktop/src/LegacyWorkbench.tsx` |
| 连续配置表 | 展示/实际配件编辑、行复制、增删与可见配置挂载 | `apps/desktop/src/legacy/continuous-workbench.tsx` |
| 领域回调 | 配件投影、原子复制删除、选择与保存分发 | `apps/desktop/public/workbench/continuous-workbench.js` |
| 页面桥接 | 将受支持的页面请求转成 Tauri IPC；转换渲染素材地址 | `apps/desktop/src/legacy/local-bridge.ts` |
| 工作台页面 | 配置、成本、批量维护、版式与图片绘制 | `apps/desktop/public/workbench/` |
| Rust 本机服务 | SQLite 存储、历史、恢复、缓存与本机接口 | `apps/desktop/src-tauri/src/` |
| 团队同步 | 通过本机配置访问可选外部服务，提交与读取变更 | Rust 同步模块与页面同步调度 |
| ERP 运行时 | 可选 Python 适配器，提供只读查询 | `services/erp-worker/` |
| 签名更新 | 读取 Release、验签和摘要校验、替换程序 | `apps/desktop/src-tauri/src/updater.rs` |

## 编辑与保存

工作台先获取配置索引，选择配置时加载完整详情，当前编辑对象保持加载。页面通过桥接调用本机接口，Rust 将修改写入本机存储。保存、恢复草稿和历史是本机数据流程；云端回执是另一项状态，不能用本机保存成功推断同步成功。

同一链接超过6套配置时只挂载可见配置及相邻区域；当前输入所在配置保持挂载，选行状态跨卸载保留。共享候选与库存索引减少每次输入的重复计算，未变配置的投影缓存复用。自由编辑缩放将尺寸读取与样式写入分开，合并同帧布局刷新。

浅深界面通过共享主题变量同步宿主与 iframe；换色期间暂停全页颜色过渡，避免大量控件同时动画。此主题不写入图片配色字段。

图片按需要绘制和导出。导出文件按链接及图片类型分组；应用缓存由缓存维护逻辑管理，与用户导出的图片目录分开。

## 同步与 ERP

外部接入均为可选。本机 `data/integrations.json` 提供连接参数；未配置时不会自动连接某个团队。页面调度通过原生接口执行同步，网络与业务存储由 Rust 处理。登录后的自动同步间隔为 2 小时，用户也可手动发起；普通编辑可以在后台同步时继续。

ERP 通过本机安装的运行时及适配器查询，查询结果预览后才应用至本机配置。发行包保留通用协议，不附带私有运行时、账号或生产连接。配置说明见[本机可选接入](PUBLIC-INTEGRATIONS.md)。

## 更新与发行

Gitea 为首选更新源，GitHub 为备用源。更新模块读取固定通道 `refactor-updates` 的签名清单，清单指向具体版本的程序附件。Ed25519 验签通过后，继续核对版本、长度和 SHA-256；保存成功后才替换程序。

程序包含验证公钥。发布私钥只用于发布者本机签名，Gitea 发布凭据只用于上传，两者都不进入 EXE 或业务同步。Gitea 客户端下载使用匿名请求，与发布者的上传权限分离。

## 数据位置

| 内容 | 位置与边界 |
| --- | --- |
| 便携程序数据 | EXE 相邻的 `data`，更新时保留 |
| 配置与历史 | 本机 SQLite 及相关文件 |
| 原图、恢复草稿、缓存 | 本机数据目录中的对应子目录 |
| 连接参数 | 本机 `data/integrations.json` |
| 可选 ERP 运行时 | 本机 `data/runtime/` |
| 发布私钥与上传凭据 | 发布者本机，源码和发行包之外 |

仓库不包含开发过程记录、私人测试数据和生产环境配置。本图描述 Windows 重构版，不包含独立维护的旧版桌面程序或轻量网页部署。
