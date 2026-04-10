# inkos · Claude Code 工作守则

## Git 提交规范

### 原子化提交（强制）

**每个 commit 必须是一个原子的逻辑变更。**

- 一个 commit = 一件事。不要把"重构 provider + 修复拼写错误 + 更新依赖"塞进同一个 commit。
- 一个 commit 必须能独立通过 `pnpm build` 和相关测试（不留半成品状态）。
- 一个 commit 必须能独立被 revert 而不破坏后续 commit（除非后续 commit 显式依赖它）。
- 优先多个小 commit，拒绝一个大 commit。大重构时按模块、按接口、按迁移阶段切分。
- **永远不要** 用 `git commit --amend` 或 `git rebase -i` 合并已经写好的原子 commit，除非用户明确要求。
- **永远不要** 用 `git add -A` 或 `git add .` 盲目暂存，改为显式 `git add <path>` 避免误入 `.env`、`node_modules`、构建产物、临时文件。

### Commit message 风格

沿用仓库现有风格（可用 `git log --oneline -20` 参考）：

```
<type>(<scope>): <concise subject in lowercase>

<optional body explaining WHY, not WHAT>
```

常见 type：`feat` / `fix` / `refactor` / `docs` / `chore` / `test` / `perf`。

### 提交前必做

- 运行 `pnpm build` 或 `pnpm -w -r build` 确认无类型错误
- 运行相关的 `pnpm test -- <pattern>` 确认未破坏
- `git status` 确认没有误入的文件
- `git diff --staged` 自检改动范围

## 工作目录

- Monorepo：`packages/cli`、`packages/core`、`packages/studio`
- 所有改动都要保持跨包类型一致性
