# 发行说明与仓库配置模板

发布前按 [Windows 新版签名发布](PUBLIC-RELEASE.md) 核对授权、构建来源、附件及更新通道。Gitea 主源与 GitHub 备用发行使用相同的说明内容。以下占位值按实际发行填写。

## Release Markdown 模板

标题填写 `DIY 配置工作台 X.Y.Z`，标签填写 `workbench-vX.Y.Z`。

```markdown
## 本次重点

- [功能或流程]：[用户能完成什么，以及从哪里进入]。

## 修复与细节

- [影响范围]：[修复后的行为与适用条件]。

## 附件说明

| 附件 | 用途 |
| --- | --- |
| Windows 使用包（ZIP） | 首次使用，完整解压到独立可写目录 |
| diytools-workbench-X.Y.Z-windows-x86_64.exe | Windows x64 正式程序，也是更新器下载的附件 |
| diytools-workbench-windows-x86_64.json | Ed25519 签名清单，包含正式 EXE 的长度与 SHA-256 |
| release-notes.md | 与签名清单绑定的版本说明 |

已使用新版工作台的用户可从「更多 → 检查更新」升级，保留连接和本机 data。
```

使用包的附件名称以发行页为准。例如 0.2.57 在 Gitea 为 `DIY工作台-0.2.57.zip`，在 GitHub 为 `DIY-0.2.57.zip`。

## 双端仓库配置速查

| 字段 | 建议值 |
| --- | --- |
| Description | DIY 整机运营工作台，支持三店配置编辑、价格利润、输出源维护与高清海报导出。 |
| Topics | `diy-pc`、`tauri`、`react`、`rust`、`postgresql`、`windows`、`nas` |

- 在 **Gitea** 仓库的「设置 → 仓库」填写描述并保存，在首页的主题入口编辑 Topics。在仓库设置的「仓库头像」选择并上传 [repo-avatar.png](assets/repo-avatar.png)（512 × 512），回到仓库首页核对图标。
- 在 **GitHub** 仓库首页的 **About** 设置填写 Description 和 Topics。在 **Settings → General → Social preview → Edit → Upload an image** 上传 [social-preview.png](assets/social-preview.png)（1280 × 640）。[GitHub 配置说明](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/customizing-your-repositorys-social-media-preview)
