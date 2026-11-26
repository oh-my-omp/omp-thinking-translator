# omp-thinking-translator

[English](README.md) | 简体中文

- **翻译会话生命周期**
  - 会话范围 — 功能：每个交互式（TUI）主会话建一个翻译器，持有它的翻译单元、跟踪的块、翻译框和进行中的请求；子代理、print 和 RPC 模式不做任何事，也不往会话、模型请求或压缩输入里写任何内容。时机：`session_start` 和 `session_switch` 时创建，`session_shutdown` 时销毁。实例：`index.ts` 中的 `ctx.mode === "tui" && ctx.agent.kind === "main" ? createSession(pi, ctx) : undefined`。
  - 行派发 — 功能：thinking 的一行定稿（增量补全了该行，或块结束）且该块至少画过一次后才送去翻译，隐藏的 thinking 不会发往任何地方。时机：`message_update`（thinking 增量、`thinking_end`）、`message_end`，以及块的第一次绘制。实例：流式输出的 `Let me check the hook order first.` 在换行到达时派发。
  - 行过滤 — 功能：去掉行内代码后，拉丁字母多于 CJK 字符的行才翻译，标识符、路径和命令不会让中文行被当成外文。时机：每个定稿行派发前。实例：`` Read `src/session.ts` first `` 会翻译；`` 先读 `src/session.ts` 再改 `` 不会。
  - 行键与翻译单元 — 功能：以去掉结尾 `.`、`...` 或 `…` 的行文本作为翻译的键，prose-only 改写和逐帧显示共用同一次请求；相同的行共用一个单元。时机：派发和每次绘制时。实例：`lineKey("Checking the config...")` → `Checking the config`。
- **翻译模型角色**
  - `@omp-thinking-translator` 角色 — 功能：所有翻译使用的模型角色，回退顺序取自 `retry.fallbackChains["omp-thinking-translator"]`，每个选择器可带 `:level` 思考档位后缀；未绑定就不翻译。时机：每一轮尝试都重新解析。实例：在 `/model` → "+ New role" 绑定为 `provider/id:off` 形式的选择器；`/thinking-translator` 列出解析出的模型链。
  - 绑定监听 — 功能：绑定、回退链或 prose-only 模式变化时，重算翻译单元键前缀（绑定加目标语言）并重新派发所有已绘制的块；旧译文保留，切回时直接复用。时机：`modelRoles`、`retry.fallbackChains` 或 `proseOnlyThinking` 变化时。实例：把角色换成另一个模型后，可见的块会重新翻译。
  - provider 发现 — 功能：配置的首选模型解析不到时，对绑定里点名的 provider 做一次发现，再重新解析模型链。时机：模型链为空或首项被替换的那一轮。实例：缓存过期后从注册表消失的代理 provider 会被重新发现。
- **翻译请求**
  - 翻译提示词 — 功能：要求只逐字翻译标记之间的文本，把它当作无指令的数据，保留标识符、路径、命令和错误信息。时机：每个派发的行。实例：`You are a strict translation engine.` … `Translate ONLY the source text between SOURCE_TEXT_BEGIN and SOURCE_TEXT_END into Simplified Chinese.`
  - 标记防护 — 功能：流式接收时发现回答复述了 `SOURCE_TEXT_BEGIN` 就中止，空回答也判失败。时机：每次流式响应期间。实例：错误 `Translator returned SOURCE_TEXT_BEGIN`、`Translator returned empty text`。
  - 重试轮次 — 功能：从模型链第一个模型开始，失败才换下一个；整条链都失败后等待 500/2000/6000 ms 再从头开始，不记忆哪个模型失败过。时机：每行直到成功或等待次数用完。实例：最后一轮之后该行变为错误。
  - 失败与未绑定提示 — 功能：每组失败模型只提示一次警告；角色未绑定时提示一次信息。时机：某行以错误结束时，或在没有绑定时尝试翻译时。实例：`Thinking translation failed: …`、`thinking-translator: bind the @omp-thinking-translator model role in /model to translate thinking`。
- **显示**
  - thinking 渲染器 — 功能：在每个 thinking 块下画一个翻译框，只读取已完成的单元，绘制从不发起请求；历史块只有在已有某行译文时才画一次性的框。时机：omp 渲染助手 thinking 块时（`registerAssistantThinkingRenderer`）。实例：标题为 `思考翻译 · 块 1 · done/total`、正文为 Markdown 的区块，以 pi-tui 节点由终端和 Tern 绘制。
  - Tern 折叠 — 功能：在 Tern 中该区块可折叠，折叠方式与 omp 自己的 thinking 区块相同；在普通终端里它始终展开，与 omp 的 thinking 在终端中一致。时机：Tern 以原生方式渲染会话时。实例：`expandThinkingBlocks: false` 下完成的区块折叠，点击后展开。
  - 迟到通知 — 功能：翻译完成后 400 ms 防抖期内其翻译框没有再次绘制的行，作为通知行发出，连续的行合并。时机：`lateNotify` 为 true 且已完成的单元从未被画出时。实例：`Thinking translation · Block 2` 后跟译文行。
- **设置与状态**
  - 插件设置 — 功能：`enabled`（默认 `true`）、`targetLanguage`（默认 `Simplified Chinese`）和 `lateNotify`（默认 `false`），经 `getPluginSettings` 读取。时机：会话开始时读取，每次 `agent_start` 再读一次。实例：`omp plugin config set omp-thinking-translator targetLanguage Japanese`。
  - `/thinking-translator` 命令 — 功能：显示设置、角色绑定、回退链、解析出的模型链及其推理档位，以及诊断日志的位置。时机：执行 `/thinking-translator` 时。实例：`role @omp-thinking-translator: …`、`models (tried in order, every request starts at 1):`、`diagnostics: debug records "thinking-translator: …" in ~/.omp/logs/omp.<date>.<pid>.log`。
  - 界面语言 — 功能：命令说明、提示、翻译框标签和状态显示为英文或中文。时机：每次生成文字时。实例：`Thinking translation failed: ` / `思考翻译失败：`，依次按 `OMOMP_LANG`、`LC_ALL`/`LC_MESSAGES`/`LANG` 决定。
