# Windows 签名发布

主仓库为 [CoreStudio/diy-tools-refactor](https://gitea.cq360.top/CoreStudio/diy-tools-refactor)，GitHub 为备用发行源。版本标签使用 `refactor-vX.Y.Z`；软件从固定标签 `refactor-updates` 读取 `diytools-refactor-windows-x86_64.json`，清单指向对应版本的程序附件。

## 发布前准备

在干净的发行源码工作树中统一根目录与桌面 `package.json`、Tauri 配置、Cargo 包及锁文件版本，提交本次代码和正式说明。只放置通用源码、示例和正式产品文档；私人开发记录、业务数据、连接配置及私有依赖不能进入发行工作树。

发布私钥存放在仓库之外，必须与源码中的验证公钥匹配。不要为每次发布重新生成密钥，否则已安装程序无法验证更新。

发布者在 Gitea 账户的“设置 → 应用”生成令牌，授予 repository 读写、organization 读写和 user 读取权限，然后在本机运行：

```powershell
pwsh -NoProfile -File tools/authorize-gitea.ps1
```

按隐藏提示粘贴令牌。脚本验证身份后保存至 Windows 凭据管理器；令牌不要写入仓库、脚本参数或发行包。普通用户匿名下载 Gitea 更新，不需要这些发布权限。

## 发布命令

在已提交、无未提交修改的发行源码目录中执行：

```powershell
pwsh -NoProfile -File tools/publish-gitea-release.ps1 `
  -PrivateKeyPath C:\private\update-ed25519.pem `
  -NotesPath C:\release\release-notes.md `
  -PublicRepository
```

源码目录不同时可用 `-SourcePath` 指定。此仓库为公开仓库，每次发布都必须保留 `-PublicRepository`；首次创建时再额外指定 `-CreateRepository`。脚本会核对既有仓库可见性，不会自动修改可见性。

已有完成构建与签名的产物，可使用 `-ArtifactsDirectory` 指定目录。该目录必须包含 `build-provenance.json`，其中 `sourceCommit` 为当前发行源码的完整提交 ID，`version` 为当前版本，`artifactSha256` 为待发布 EXE 的 SHA-256。发布脚本核对这三项与当前源码、版本和实际程序一致，并继续检查签名与 ZIP 内容边界；缺少证据或不一致时停止发布。普通构建流程会生成此证据文件，预构建流程应保留构建时的真实记录。

发布脚本负责检查、构建与打包、推送到固定 Gitea 仓库、创建版本 Release、上传附件并回读核验，最后更新软件读取的固定通道。新版本标签不能覆盖。每次向使用者推送更新都通过此流程完成；单独执行 `git push` 不会自动生成程序包或 Release。

## 每个版本的附件

| 附件 | 用途 |
| --- | --- |
| `DIYTools-X.Y.Z-Windows-x64.zip` | 首次安装用便携包 |
| `diytools-refactor-X.Y.Z-windows-x86_64.exe` | 软件内更新下载的程序 |
| `release-notes.md` | 此版本的更新说明 |
| `diytools-refactor-windows-x86_64.json` | Ed25519 签名清单，绑定版本、下载地址、长度和 SHA-256 |

便携 ZIP 只包含 `DIYTools.exe`、`diytools-portable.json` 与 `使用说明.md`。不能直接压缩现有用户安装目录作为公开包。

版本附件上传并核验成功后，才更新 `refactor-updates`。源码推送成功不等于程序已经发布；发布完成还需要确认版本 Release、附件和更新通道均可读取。

## GitHub 备用与旧版本兼容

0.2.2 的 Gitea 清单可同时列出 Gitea 与 GitHub 下载地址。0.2.0 / 0.2.1 客户端只接受单个 GitHub 地址，因此 GitHub 版本 Release 和固定通道必须使用单地址兼容清单，指向相同程序字节。

Gitea 发布脚本不自动镜像 GitHub。需要备用源和旧客户端升级时，另行完成 GitHub 发布并上传兼容清单、同一 EXE、ZIP 和更新说明，回读核验后再更新 GitHub 通道。不得用双地址清单覆盖旧客户端的 GitHub 通道。

客户端只在源不可用时尝试备用源；签名、格式或摘要校验失败应报错，不能作为跳过校验的理由。GitHub 仓库为私有时，备用下载需要相应读取权限；Gitea 匿名下载与 GitHub 授权相互独立。

## 首次使用入口与文档

README 顶部提供当前 Windows ZIP 的 Gitea 与 GitHub 直达链接，发布后更新下载版本并回读验证。0.2.15 另提供 `DIYTools-0.2.15-Windows-x64-FirstUse.zip`，使用相同程序和便携标记，附带整理后的使用说明。已有签名更新附件保持原样。后续常规便携 ZIP 同样可供首次使用。

版本更新内容维护在 Releases；源码 docs 仅保留当前有效的产品和维护说明，不增加逐版本开发记录。

## 发布检查

运行 `tools/audit-public-tree.py` 检查发行源码，确认 ZIP 只有规定的三项内容，并从 Release 回读附件校验摘要。使用实际程序的无窗口更新探针检查签名下载链路；该探针不代表已验证真实用户窗口的保存、退出和安装流程。

数据库、原图、日志、草稿、真实集成文件、发布私钥和私有运行时始终留在 Git 与 Release 之外。每次更新正常保存后只替换程序，保留 `data` 和本机集成配置。


