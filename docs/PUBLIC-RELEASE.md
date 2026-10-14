# Windows 签名发布

仓库：`yamakaze1234/diytools-refactor`。版本标签：`refactor-vX.Y.Z`。软件从固定标签 `refactor-updates` 读取 `diytools-refactor-windows-x86_64.json`，签名清单指向对应不可变版本的 EXE。

先统一根目录与桌面 `package.json`、Tauri 配置、Cargo 包版本，运行测试和正式构建。完整便携包仅有 EXE、便携标记与使用说明；无需复制任何安装数据。发布者通过本机 `gh auth login` 登录，签名私钥放在仓库外。

```powershell
pwsh -File tools/publish-github-release.ps1 -PrivateKeyPath C:\private\update-ed25519.pem -NotesPath release-notes.md
```

脚本会校验仓库、工作树与版本，制作签名 EXE、清单和纯程序 ZIP，先上传版本发布，再更新软件读取的清单。新版本标签不允许覆盖。仅在已上传文件核验通过后更新通道；签名公钥不能随意重建，否则已安装版本无法验证更新。

私有时期使用者需有仓库读取权限，本机 GitHub CLI 授权或 Windows 凭据管理器中的受限令牌用于读取 Release API。令牌仅发送给固定仓库的 GitHub API，重定向至下载服务器时移除授权头。公开后地址和签名流程不变，可匿名下载。

`data`、`sandbox`、发布私钥、连接配置、数据库、恢复草稿、运行时及日志必须保持在 Git 之外。发布前运行 `tools/audit-public-tree.py`，并检查生成的 ZIP 只有上述三种文件。禁止将私人测试便携包上传为 Release。
