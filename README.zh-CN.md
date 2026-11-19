# omp-thinking-translator

[English](README.md) | 简体中文

一个 omp 插件：在每个可见的助手 thinking 块下方画出其中每一行的译文。译文只用于显示、只存在内存里，从不进入会话文件、下一次模型请求或压缩（compaction）输入。

## 看到的效果

- 每个 thinking 块一个翻译框，标题是 `思考翻译 · 块 N · done/total`（英文界面为 `Thinking translation · Block N · done/total`）。一行的译文整句完成后才出现；还在翻译的行只计入标题，不占行。所有翻译模型都失败的行显示一条 `翻译失败：` 行，每组失败模型第一次失败时还会弹出一条警告。
- 在 Tern（支持 Tern Surface Protocol 的终端）里，翻译框是原生的可折叠 section，形态与 omp 自己的 thinking 相同：有行在翻译时显示旋转图标；全部完成后，除非 omp 的 `expandThinkingBlocks` 设置开启，否则折叠。你自己折叠或展开过，就以你的操作为准。
- 块还在流式输出时就开始翻译，每行一完整就发出。去掉 Markdown 行内代码后，正文里拉丁字母多于中文字符的行才翻译：提到 `expandThinkingBlocks` 的中文推理不会被翻译，只有数字和符号的行会被跳过。
- 只有 omp 实际画出来的 thinking 才会被发出去。隐藏（`hideThinkingBlock`）或折叠的块从不翻译。
- 只有主交互会话翻译。subagent、`omp -p` 和 RPC 模式什么都不做。

## 要求

omp 19 或更高版本；插件跟随 omp 最新发布版开发（撰写时为 19.0.0）。只支持 omp：翻译框挂在 omp 的助手 thinking 渲染器上，pi 没有这个接口。

## 安装

```bash
omp plugin install https://github.com/oh-my-omp/omp-thinking-translator#release
```

安装跟踪 `release` 分支，由每天的发布运行更新；已安装的副本用 `omp plugin upgrade` 升到最新发布版。本地开发时，直接加载入口文件（`omp -e /absolute/path/to/omp-thinking-translator/index.ts`），或从本地检出安装（`omp plugin install /absolute/path/to/omp-thinking-translator`）。

## 选择翻译模型

插件用 omp 的模型角色 `@omp-thinking-translator` 翻译。这个角色没有绑定时什么都不翻译，每个会话会提示一次。

在 `/model` 里绑定：选 "+ New role…"，命名为 `omp-thinking-translator`，再给它分配一个快而便宜的模型。在同一视图里用 "+ New fallback…" 给这个角色加回退模型。写在 `~/.omp/agent/config.yml`（或项目的 `.omp/config.yml`）里是这样：

```yaml
modelRoles:
  omp-thinking-translator: deepseek/deepseek-v4-flash:low
retry:
  fallbackChains:
    omp-thinking-translator:
      - ollama/qwen2.5:7b:off
```

- **顺序。** 每一行都先试角色绑定的模型，再按顺序试回退模型，只有当前模型失败才换下一个。失败包括：不在模型注册表里、没有凭据、流错误、返回空文本，或回显了提示词里的输入标记。各行之间不记任何状态。整条链都失败时，分别在 0.5 秒、2 秒、6 秒后从头再试，之后这一行才显示失败行。
- **推理强度。** `:level` 后缀（`:off`、`:minimal` … `:max`）决定发给该模型的翻译请求用什么推理强度。不写后缀时用 pi-ai 对该模型 API 的默认值，有些 API 的默认值是“关闭推理”；要求必须推理的端点会因此拒绝每一次请求（`Reasoning is mandatory for this endpoint`），这类模型要写明强度。每次请求的输出上限是 1024–8192 token，按行长缩放；推理模型若把额度花在隐藏推理上就会返回空文本，所以翻译用低强度合适。
- **模型发现。** 代理发现型服务方的模型从 omp 的注册表里掉出去时，插件请 omp 重新发现这个服务方，再解析一次模型链。
- **改动立即生效。** 新的绑定或回退链在正在运行的会话里立刻生效，屏幕上的块按新的链重新翻译。旧绑定下的译文会保留，切回去时直接复用。

`/thinking-translator` 显示插件设置、角色绑定、回退链，以及模型链此刻解析到的模型和各自的推理强度。

翻译模型会收到你的 thinking 文本：前面的模型失败时，链上每个服务方都可能收到某一行。不希望 thinking 离开本机，就用本地模型。

## 设置

插件设置在 `/settings` → Plugins 里改，或者用 `omp plugin config set omp-thinking-translator <key> <value>`。项目可以在 `.omp/plugin-overrides.json` 里覆盖：

```json
{ "settings": { "omp-thinking-translator": { "targetLanguage": "Japanese" } } }
```

| 设置 | 类型 | 默认值 | 含义 |
| --- | --- | --- | --- |
| `enabled` | boolean | `true` | 翻译可见的 thinking 行。翻译还需要上文的角色绑定。 |
| `targetLanguage` | string | `"Simplified Chinese"` | 译文的目标语言。 |
| `lateNotify` | boolean | `false` | 翻译框已不再重绘后才完成的译文，以通知行显示（见下文）。 |

插件设置变化时 omp 不发事件，所以插件在会话开始时读一次，之后每次发送 prompt 前再读一次；改动从下一个 prompt 起生效。无效的值回落到默认值，并在 omp 日志里留一条警告。

**`lateNotify`。** 在 ANSI 终端里，omp 把消息退入 scrollback 之后就不再重绘它，而这可能发生在这条消息的行全部译完之前：慢的一行可能在下一个 prompt 开始后才译完。这样的行不会出现在翻译框里。开启 `lateNotify` 后，这些行经过 400 ms 防抖，合成一条暗色通知行，出现在当前对话末尾，标题为 `思考翻译 · 第 N 块`。Tern 的 section 一直保持实时，不会出现这种通知行。

## 界面语言

插件自己的文字（翻译框标题、提示、`/thinking-translator`）按 `OMOMP_LANG`（`en` 或 `zh`，忽略首尾空白和大小写）选择。没有设置时，取 `LC_ALL`、`LC_MESSAGES`、`LANG` 中第一个非空值，以 `zh` 开头就用中文，否则用英文。每次生成文字时重新读取这些变量。译文本身的语言由 `targetLanguage` 决定。

## 诊断

插件把名为 `thinking-translator: <事件>` 的 debug 记录写进 omp 日志 `~/.omp/logs/omp.<日期>.<pid>.log`，omp 默认的日志级别就会记录：`activate`（翻译开或关、绑定、语言）、`dispatch`、`discover`、`request`（模型和推理强度）、`modelFailed`、`translateError`、`done`、`painted` 和 `lateFlush`。记录里带有每条原文的前 40–60 个字符。服务方以 HTTP 400 拒绝的请求，omp 会把请求体存到 `~/.omp/logs/http-400-requests/`，翻译请求也不例外。

## 上下文边界

翻译框是展示输出，不是对话内容。omp 存储、下一轮发送、交给压缩的助手 thinking 始终是模型产出的原文。

- 译文存在会话内存里，只有翻译框和迟到通知行读取它，会话结束或切换时丢弃。
- 插件没有注册任何能改变模型所见内容的 hook（`context`、`before_provider_request`、`before_agent_start`、`session_before_compact`、`session_stop`）。它的处理器只有会话生命周期、agent 开始时读设置，以及 `message_start`、`message_update`、`message_end` 里的 thinking 记账。
- omp 交给渲染器的是新对象里的显示文本，不是存储的消息，插件无法借此修改消息。

自己验证的方法：

1. 写一个用完即弃的扩展，注册 `pi.on("before_provider_request", …)` 和 `pi.on("session_before_compact", …)`，把 payload 和 `event.preparation` 的 `JSON.stringify` 分别追加到两个文件，两个处理器都返回 `undefined`。
2. 绑定好角色，在临时目录里启动 `omp -e /path/to/omp-thinking-translator/index.ts -e /path/to/observer.ts`。
3. 发送一个会产生多行 thinking 的英文 prompt，等翻译框标题里的 `done/total` 两个数相等。复制两段既不在 prompt 里、也不在 thinking 里的有辨识度的译文片段。
4. 再发一轮，在最新的 `before_provider_request` payload 里搜索这两段片段和翻译框标题。应当一次都没有，助手 thinking 应与会话文件里存储的一致。
5. 继续对话直到 `/compact` 有可摘要的消息，执行它，用同样方法搜索记录下的 preparation 和存储的摘要。应当一次都没有。
6. 搜索会话文件的每个内容部分。应当一次都没有。

不在这个边界内的：

- **翻译请求本身。** 每一行都作为独立请求发给角色的模型，与对话分开。这些服务方能看到文本，并按它们自己的政策保留。
- **画出来的内容。** 终端 scrollback、迟到通知行、终端录屏和 omp 的 `/debug-transcript` 按设计都包含译文。
- **没有验证过的路径。** 会话导出与导入、分支切换都没有检查过。

## 限制

- omp 没有画出来的 thinking 不会翻译，也不补译：重新打开的会话里，历史消息没有译文。
- 在 ANSI 终端里，omp 把消息的一部分提交进 scrollback 之后，每多译完一行，omp 就要从它还能对上的最后一行起重写一次这条消息：每个迟到的行一次重写。
- 同一会话内，绑定和目标语言不变时，相同的行共用一条译文。

## 安全说明

omp 插件拥有完整的系统权限。安装前请审阅插件源码。

## 开发

```bash
bun install
bun run check   # Biome 与 TypeScript
bun test
```

测试在 Bun 下运行，因为 omp 的包以 TypeScript 源码作为入口。

## 包结构

- `index.ts` —— 入口：为每个主交互会话建一个翻译器，注册渲染器、`/thinking-translator` 命令和事件。
- `src/` —— 会话、设置、角色链、翻译请求、行与块的追踪、翻译框渲染、迟到通知和状态命令。
- `tests/thinking-translator.test.ts` —— 单元测试，包括针对 omp thinking 显示格式的契约测试。
- `omomp-shared/` —— 各 oh-my-omp 仓库共用文件的副本。
- `README.md` —— 英文说明；`README.zh-CN.md` 是本文件，即它的简体中文版。
