# 版本策略

`@oh-my-pi/*` 永远跟最新发布版，不问、不讨论、不保留旧版兼容。

宿主会自更新，扩展在运行时永远对着用户机器上的那一版；`devDependencies` 落后只会让类型检查和
`tests/thinking-translator.test.ts` 里那条引用宿主 `formatThinkingForDisplay` 的契约测试
对着一个不再运行的版本作证。

发现版本落后时直接执行，不必确认：

```bash
# 取 dist-tags.latest，三个包对齐同一版本
pnpm install
pnpm check   # 契约测试跑在新宿主源码上，这是升级的验证点
```

契约测试因此失败说明宿主改了展示改写规则，那就修扩展去适配新行为，不要把依赖钉回旧版。

# `version` 由每日发布写入

`package.json` 的 `version` 在这里不是 npm 发布元数据（本包 `private`，不发布），而是**已安装副本的身份**：
`omp plugin list` 和 `~/.omp/plugins/omp-plugins.lock.json` 的 `version` 取自它
（`manager.ts:613,625`），`omp plugin upgrade` 的更新判定是
`Bun.semver.order(catalogVersion, installed.version) > 0`（`marketplace/manager.ts:665`）。

所以 `version` 必须跟着发布走：升级检查靠它判断有没有新版本，改动只有落到发布版本上才会被
`omp plugin upgrade` 装下来，"装上的到底是哪一版"也只能从它读出来。

合并到 `main` 不是发布，也不改 `version`。发布是 `.github/workflows/omomp-release.yml` 调用的共享
workflow：每天 GMT+9 02:00（cron `0 17 * * *`）或手动 `workflow_dispatch` 触发一次，把
`CHANGELOG.md` 的 `## [Unreleased]` 改写成新版本段，提交 `chore: release X.Y.Z`，再把 `main`、tag
`vX.Y.Z` 与 `release` 分支原子推送，并用这一段建 GitHub Release。新版本由条目分类决定：
`### Breaking Changes` 在 1.0 及以上升 major、1.0 前升 minor，`### Added` 升 minor，其余升 patch。
所以提交里不改 `version`，也不手动写版本段。

条目由 lgit 写：`git add` 后运行 `uvx --from lgit-cli lgit`，它生成提交说明并把每个暂存文件的用户可见
变化写进 `CHANGELOG.md` 的 `## [Unreleased]`。

客户机从 `#release` 安装：`omp plugin install https://github.com/oh-my-omp/omp-thinking-translator#release`，
之后 `omp plugin upgrade` 升到最新发布版，`omp plugin list` 显示的就是发布版本号。
