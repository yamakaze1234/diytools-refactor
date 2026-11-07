# 本地提交与发布流程（不启用 Actions）

## 源码与分支

在当前桌面源码仓库内开发，先运行 `node tools/local-workflow.mjs status` 核对提交、版本、分支与未提交文件。外层资料目录和历史工作树不作为最新发行基线。当前按用户约定，MCP 开发与兼容性修复统一在 `codex/workbench-development` 开发，维护该分支面向 `main` 的未合并 PR；每项改动单独提交并更新实际验证结果。其他新功能不默认纳入此分支；需要时按任务范围另行确定分支，不自动把其他工作树的修改合入。

本地提交不会推送。源码推送、PR 创建与合并、正式发布、更新通道操作按本次用户授权执行。未授权发布时可以保留本地提交、检查结果和候选包。无需安装 Runner，也不新增 Actions 工作流。

## 审查与本地提交

1. `git status --short`、`git diff --stat`、`git diff` 核对本次范围。旧任务的修改单独保留。
2. 运行与本次改动相称的业务测试。UI 改动检查实际页面；原生或数据改动运行对应 Rust/隔离数据验证。脚本基础检查不能替代业务验收。
3. 用 `git add -- 文件1 文件2` 明确暂存本次文件。避免在外层资料目录或混有其他任务修改时使用 `git add .`。
4. 运行 `node tools/local-workflow.mjs check`，再看 `git diff --cached --stat` 与 `git diff --cached`。该检查包含五处版本一致性、已暂存/未暂存差异格式和现有公开文件审计；审计只覆盖索引文件，新文件需先暂存。输出的业务测试与 Windows 构建状态仍为 `not_run`。
5. 确认索引仅有本次内容后，使用 `git commit -m "说明本次变化"`。若索引已有其他任务内容，先停止核对归属，不自动清空或一并提交。

检查失败后修复并重跑受影响检查；不要为了得到干净状态而提交全部业务改动。PR 可在获准推送后创建，描述问题、实际改动、验证证据和未验收部分，不伪造 CI 状态。

## 本地发行准备

确定本次版本时统一根包、桌面包、Tauri、Cargo.toml 和 Cargo.lock 中 desktop 的版本。准备完整更新说明，提交后保持干净。版本标签以 `refactor-vX.Y.Z` 表示不可覆盖的发行。

```powershell
# 只生成计划，不连接远端；文件必须尚不存在。
node tools/local-workflow.mjs plan-release --notes C:/release/release-notes.md --output C:/release/release-plan.json

# 只在需要候选包时运行：执行完整构建、签名与附件验证，随后停止。
pwsh -NoProfile -File tools/publish-gitea-release.ps1 -PrepareOnly -PrivateKeyPath C:/private/update-ed25519.pem -NotesPath C:/release/release-notes.md
```

`-PrepareOnly` 不读取发布账户凭据、不推送源码、不上传附件、不更新通道；首次安装依赖可能下载包，因此并非断网构建。准备计划不会运行完整测试或构建，不代表候选包已完成。计划绑定提交与源码树；说明或代码变化后重新准备，保留真实验证证据。

## 获准后的正式发布

正式发布仍遵循 [PUBLIC-RELEASE.md](PUBLIC-RELEASE.md)。先核对远端主线、版本标签和已有草稿，确认当前源码包含待保留的已发布功能；本地 `remoteVerified: false` 表示尚未核对远端，不代表可以直接覆盖远端。

已有本地候选包时，使用 `publish-gitea-release.ps1 -ArtifactsDirectory <候选目录> -PrivateKeyPath <私钥> -NotesPath <说明> -PublicRepository` 复用构建结果。**去掉 `-PrepareOnly` 会执行真实发布**，必须具备本次明确授权。

Gitea 脚本只处理 Gitea，GitHub 仍须按现有双源约定单独处理：复用候选目录中的同一个 EXE、ZIP、更新说明，以及 `github-compat/` 下的兼容签名清单。现有 `publish-github-release.ps1` 会重新构建，不是“同一产物镜像”入口，不能直接把它串在 Gitea 后宣称完成双源复用；应在核对 GitHub 对应源码树后上传相同附件。历史两源提交 ID 可不同，但源码树和程序字节必须一致。

每个阶段回读后在本地计划中记录实际回执：两源附件、两源通道、原生更新探针、钉钉通知回读、清理。某阶段失败先核对远端现状，保留草稿和已上传附件，禁止盲目重跑整个发行或覆盖已有正式标签。计划文件是进度记录，不是自动续传执行器。

两源检查和更新探针通过后才按项目规则通知一次；记录消息回执并回读。最后把本次无用临时文件移到回收站，保留源码、正式包、发行记录与现有最新回滚资料。源码提交成功、Gitea 发布成功、双源发行完成分别记录。
