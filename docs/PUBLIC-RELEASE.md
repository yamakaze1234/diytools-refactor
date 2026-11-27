# Windows 新版签名发布

## 当前产品

正式 Windows 构建启用 `formal-nas-client,agent-tools`，通过[本地构建脚本](../packages/agent-cli/build-local.ps1)嵌入同一源码的 CLI。版本标签为 `workbench-vX.Y.Z`，通道为 `workbench-updates`，清单为 `diytools-workbench-windows-x86_64.json`。旧 refactor 通道冻结，不混发新版清单。

## 流程

1. 获得本次推送、合并、发布授权；核对源码、未提交内容、远端主线和触发器，不新增 Actions。
2. 五处版本一致，更新 README、使用和结构说明，公开审计与相称测试通过，建立并合并 PR。
3. 从确认的合并提交构建正式特性；核对实际 EXE 中的前端资源和内置组件，并在隔离 NAS 安装回读启动生成的 CLI 与连接描述。
4. 使用 `tools/prepare-workbench-update.mjs` 和原签名私钥准备 EXE、签名清单、说明及构建证据。
5. 首次使用 ZIP 只包含同摘要 EXE（沿用 `DIY配置工作台.exe`）、便携标记和公开使用说明。不含 data、旁置认证文件、公司 NAS 地址、证书、登录信息或私有组件。组织发行的认证入口由部署连接配置确定。
6. Gitea 与 GitHub 发布同字节四附件；GitHub 采用不包含旧私有历史的独立镜像提交，源码树一致。
7. 匿名回读附件及验签通过后推进两个新版通道，再用正式 EXE 原生下载探针核验。保留真实验证边界，不能把下载探针表述为员工完整安装验收。
8. 按项目授权发送一次群通知和内部首次使用说明，核对回执；内部接入信息只在公司内部发放。最后将无用过程文件放入回收站。

`tools/publish-gitea-release.ps1` 和 `publish-github-release.ps1` 为旧产品脚本，不能不加适配直接发布新版。新版本地准备入口不会自动上传。每次发布记录实际源码提交、附件摘要、通道回读、通知回执与清理结果，保存在仓库外。

## 签名与数据

沿用已安装客户端对应的 Ed25519 私钥，不重新生成。Gitea 为主源，GitHub 为备用，清单可列两源；新客户端不需要旧单地址兼容清单。失败或状态未知先回读，禁止盲目重复发布或发送通知。

升级只替换当前 EXE，保留连接设置和本机 data，不备份或恢复旧 SQLite。原生退出保护阻止在保存、导出或回执处理中切换。发布不自动授权替换现用安装。

[发行说明与 Gitea / GitHub 仓库配置模板](RELEASE-TEMPLATE.md)
