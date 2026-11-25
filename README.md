# DIY 配置工作台

面向 DIY 整机业务的 Windows 工作台。配置、价格、成本和历史由 NAS 服务端集中保存；桌面端负责编辑、图片预览与导出，并保留本机草稿。

**Windows x64 · 0.2.54 · 服务端数据库版本**

旧版本停止更新。后续功能与修复统一在服务端数据库版本提供；旧 `refactor-updates` 通道冻结，不会自动将旧本地数据迁到新版。

## 下载与首次使用

| 下载入口 | 用途 |
| --- | --- |
| [Windows 使用包 · Gitea](https://gitea.cq360.top/CoreStudio/diy-tools-refactor/releases/download/workbench-v0.2.54/DIY%E5%B7%A5%E4%BD%9C%E5%8F%B0-0.2.54.zip) | 首次使用，完整解压 |
| [备用下载 · GitHub](https://github.com/yamakaze1234/diytools-refactor/releases/download/workbench-v0.2.54/DIY-0.2.54.zip) | 同一程序和使用包 |
| [本次更新说明](https://gitea.cq360.top/CoreStudio/diy-tools-refactor/releases/tag/workbench-v0.2.54) | 更新内容与附件 |

1. 完整解压到独立可写目录，运行 `DIY配置工作台.exe`，无需 CMD。
2. 首次连接所需的 NAS 服务地址与 CA 由管理员提供。账号由 NAS 认证，员工账号、密码和会话不随包分发。
3. 在首次连接页填写名称、服务端地址，按需选择自定义 CA，测试成功后保存并重启。
4. 使用工作台成员账号登录。密码支持显示/隐藏，可选择保留登录信息。

以后从“更多 → 连接设置”修改连接，从“更多 → 检查更新”升级。更新只替换 EXE，保留连接文件和 `data`。首次切换不要覆盖旧工作台的数据目录；旧目录在确认所需数据完整后再清理。

需要 Windows x64 和 Microsoft Edge WebView2 Runtime。正式客户端连接启用 NAS 认证的三店服务。部署需同时配置数据库、局域网 HTTPS 和 NAS API。部署契约见 [NAS 服务](services/nas-api/README.md) 和 [客户端接入](docs/NAS-CLIENT.md)。

## 主要功能

- 按店铺和商品链接管理配置，维护配件、到手价、加购和版式。
- 任一店运营可同步三店 ERP 成本和库存，查看最终可销、待入可销及在途提醒。同步成本表时保留手动核算价，价格页可汇总管理单独改价。
- 价格与利润页可直接修改简称、运营费率和到手价，按目标利润反推售价，整链勾选或控价。搜索自动展开命中的链接，店铺设置支持批量修改本店运营费率。
- 在价格页勾选配置后可预览 ERP 配置差异，确认后在后台更新原套餐配置。三店均内置默认固定附加，匹配窗口可一键安装组件。
- 配置总表支持粘贴型号和数量两列，选件或撤销后可在原格继续输入。删除或恢复配置时，简称和海报编号同步更新。
- 新增输出源可按 ERP ID 查询尚未同步的配件。查看当前店铺核算价时读取已配置主机成本表的保存值。
- 三店共用字段会标明仍有单店覆盖的店铺，可按字段恢复共用。总表多件配件的 ERP 和含税金额垂直居中。
- 本机草稿与服务端保存分离。关联来源或成本变化时自动接续保存；同配置并发修改仍保留草稿，并按配件和字段展示三方冲突明细。
- 长图、SKU 图及配置导出。维护表的配件展开公式可按店铺和表格布局设置。
- 清理缓存可移除旧安装包、浏览器缓存和已完成的匹配回执，保留草稿和登录信息。
- 黑白黄界面，浅色/深色主题统一，界面配色不改变导出图片主题。

服务端自动历史清理本次未上线。桌面端不直接连接 PostgreSQL，不分发数据库账号。

## 项目结构

| 目录 | 责任 |
| --- | --- |
| `apps/desktop/src` | React 宿主、首次连接、登录、连续配置表与桌面桥接 |
| `apps/desktop/public/workbench` | 配置领域逻辑、草稿、NAS 接口、价格利润与图片绘制 |
| `apps/desktop/src-tauri` | Rust HTTPS、账号会话、连接落盘、ERP 和签名更新 |
| `services/nas-api` | NAS API、权限边界、PostgreSQL 操作及部署模板 |
| `services/erp-worker`、`services/cost-reader` | 本机 ERP 查询与 Excel 只读组件 |
| `packages` | 共享模块与正式包内置的 Agent CLI |
| `tools` | 本地检查、构建、验签及发布 |
| `docs` | 当前使用、开发、架构与发布说明 |

[项目结构与架构图](docs/PUBLIC-ARCHITECTURE.md) · [源码开发](docs/DEVELOPMENT.md) · [使用说明](docs/PUBLIC-USAGE.md) · [发布流程](docs/PUBLIC-RELEASE.md)

[Gitea 主仓库](https://gitea.cq360.top/CoreStudio/diy-tools-refactor) · [GitHub 备用发行源](https://github.com/yamakaze1234/diytools-refactor)

本项目尚未指定开源许可证；第三方依赖和素材遵循各自许可。
