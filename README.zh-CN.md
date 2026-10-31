# omp-thinking-translator

[English](README.md) | 简体中文

一个 omp 扩展：把可见的助手 thinking 块翻译成另一种语言，只用于显示。

它在每个可见的助手 thinking 块正下方渲染一个翻译框。在支持 Tern Surface Protocol 的终端（Tern）里，这个框是原生的可折叠 `omp.thinking` section，形态与宿主自己的 thinking 相同：译文陆续到达时展开；全部完成后跟随宿主的 `expandThinkingBlocks` 设置——该设置关闭（默认）时折叠，开启时保持展开。在其他终端里，它是 ANSI 框。如果某条译文完成时 ANSI 框已经无法重绘，扩展会在当前对话记录末尾输出一条经过防抖的流内记录行。译文只保存在扩展内存里：从不写入会话文件，从不进入下一次模型请求，也从不进入压缩（compaction）输入。机制、运行时证据和明确不覆盖的范围见[上下文边界](#上下文边界)。扩展唯一会写的文件是会话文件旁边的诊断 trace（见下文 `trace` 选项），它记录扩展自己的步骤，从不记录会话内容。

## 特性

- 翻译宿主实际显示的行。渲染器收到每个可见 thinking 块的显示文本，这段文本是“翻译什么”和“译文画在哪里”的唯一依据——因此宿主改写过的行（只含说明文字的代码围栏省略、空的推理摘要注释、流式逐字显示）不会再落得没有位置。这条契约由一个测试固定：它对带围栏和注释的 thinking 运行宿主自己的 `formatThinkingForDisplay`，并要求每条仍在显示的行都能对应回它的原始行。
- 按行判断，而不是按块：排除 Markdown 行内代码（标识符、路径和命令，而不是正文）之后，一行含有拉丁字母、且拉丁字母多于中文字符时才翻译。这样，夹着 `expandThinkingBlocks` 这类长标识符的中文推理不会被重复翻译成中文。工具调用前只有一句话的 thinking 块与其他块一样翻译。
- 块还在流式输出时就开始翻译。宿主在显示文本每次变化时都会重建渲染器，所以每一行一完整出现就立即分发——单行块实测在 `thinking_end` 之后 3 ms 发出。只有当一行是某个已观察到的块里的完整行时才分发：块未结束时，它的最后一行还在逐字显示，否则每个已显示的前缀都会变成一次单独请求。
- 只分发本进程实际观察到流式输出的 thinking 块里的行，按内容与所有已跟踪的块匹配（`resolveTrackedLine`），并以**匹配到的原始行**而不是显示文本作为每个译文格的键。宿主逐字显示一行，而匹配器容忍缺失的句末句号（宿主的代码围栏折叠会吃掉一个），所以差一个句号的那一帧已被当作完整行接受；如果按显示文本作键，这一行会被翻译两次——框里显示第二次的结果，而从未画出的第一次会变成一条多余的迟到行。块的身份刻意*不*使用宿主的 `contentIndex`：每条助手消息的 thinking 块都从 0 编号，工具结果是一条独立消息，而上一条消息的 thinking 组件之后还会继续重绘——所以按序号查找会把*下一个*块的原文交给那个组件，整个块就悄无声息地没有译文。回放的历史不匹配任何已跟踪的块，只渲染、不重新翻译。
- 在一个有序的翻译模型列表上依次回退。每次请求都从 `translatorModels` 的第一个模型开始，只有当前模型失败时才换下一个——失败包括：尝试发现后仍不在注册表里、凭据错误、流错误、空响应，或响应回显了内部输入标记 `SOURCE_TEXT_BEGIN`。检测到该标记时只中止这个模型正在进行的请求，并抛入现有的回退路径；它已输出的部分文本在下一个模型开始前丢弃。不记住哪个模型失败或成功过：下一行、下一轮重试都重新从第一个模型开始。整条链都失败时，会以退避（500 ms、2 s、6 s）重试整条链，每轮都从第一个模型开始，之后这一行才放弃。因此离线、限流、正在重启或回显原文封装的翻译模型会把请求让给下一个模型，而不是留下一条永久的错误行或协议标记行；在出现真正的译文之前，这一行保持空白。
- 每个框带有 `思考翻译 · 块 N · done/total` 标题（N 是同一条消息内 thinking 块的序号），只显示已经有译文的行。等待中的行完全不占行——进度体现在标题的计数里——所以一个五行的块不会先撑出五行占位，scrollback 里也不会留下冻结的占位。重试用尽的行显示一条失败行。译文更新通过发起请求的组件自己的 `requestRender` 重绘；生效配置只会被替换，从不清空——否则查找用的键材料会消失，宿主一开始下一条消息（工具结果也是一条消息），屏幕上的每个框就都空白了。
- 在 Tern 里原生渲染。渲染器返回的组件同时实现了 `describe(cx)`（Tern Surface Protocol），所以 Tern pane 会得到一个 `section`：还有行在翻译时 role 为 `omp.thinking.live`，全部完成后为 `omp.thinking`，带一个 `思考翻译 · 块 N · done/total` 头部和一个 `md` 正文。除非你自己切换过，翻译完成时这个 section 只在宿主设置 `expandThinkingBlocks`（Settings → Model → Thinking → Expand Thinking Blocks，或 `omp config set expandThinkingBlocks true`）关闭时折叠；开启时它与宿主自己的 thinking 一样保持展开。每次 describe 都从宿主读取这个设置，修改后下一帧就生效。不支持该协议的终端从不调用 `describe`，ANSI 框保持不变；没有列出 `section` 和 `md` 的 Tern 回退到 ANSI 行。原生界面没有只追加的 scrollback，所以 Tern 一旦 describe 过该组件，就不再输出迟到通知行。
- 通过 `ctx.ui.notify` 把迟到的译文输出为一条经过防抖、暗色的流内记录行。这是扩展能用的唯一一个追加真实记录行、又不进入 LLM 上下文或会话文件的界面。这一行刻意放在当前记录末尾——在已经到达的工具输出之后——而不是假装它能留在已冻结的 thinking 块下面；只有在没有宿主聊天事件可能打断 `notify` 的同身份合并时，连续的刷新才会重新包含上一次的内容。
- 支持全局配置和按项目覆盖。

## 要求

- omp（`@oh-my-pi/pi-coding-agent`），已在 18.8.7 上验证。宿主必须提供 `registerAssistantThinkingRenderer` 和 `modelRegistry.refreshDiscoverableProviders`；在 Tern 里原生渲染，还需要宿主把 `Component.describe` 路由到 Tern Surface Protocol 后端。

本扩展只支持 omp，不是 pi 扩展。它建立在 omp 的扩展 API 上：翻译框通过 `pi.registerAssistantThinkingRenderer` 挂载，上游 pi 没有这个接口；所有导入都解析到 omp 的 `@oh-my-pi/*` 包，而不是 pi 自己的包。在 pi 上运行意味着换一个显示界面，而不是改一下配置。

## 安装

本扩展从 git 安装，没有发布到任何包仓库。

```bash
omp plugin install git:github.com/oh-my-omp/omp-thinking-translator
```

本地开发时，可以直接加载扩展文件：

```bash
omp -e /absolute/path/to/omp-thinking-translator/extensions/thinking-translator.ts
```

或者从本地检出安装：

```bash
omp plugin install /absolute/path/to/omp-thinking-translator
```

manifest 键是 `omp.extensions`。`@oh-my-pi/*` 包只作为开发依赖，并跟随最新发布版：宿主已经提供了它们，所以安装本扩展不会在插件目录下增加任何 `@oh-my-pi` 包。

## 快速开始

1. 安装扩展：

   ```bash
   omp plugin install git:github.com/oh-my-omp/omp-thinking-translator
   ```

2. 每台新机器都需要在 omp 里创建本插件自己的全局配置模板：

   ```text
   /thinking-translator init --global
   ```

3. 编辑生成的文件：

   ```text
   ~/.omp/agent/thinking-translator.json
   ```

4. 按尝试顺序指定一个或多个翻译模型，并启用扩展：

   ```json
   {
     "enabled": true,
     "translatorModels": [
       { "provider": "deepseek", "id": "deepseek-v4-flash" },
       { "provider": "ollama", "id": "qwen2.5:7b" }
     ]
   }
   ```

5. 查看生效配置：

   ```text
   /thinking-translator status
   ```

`provider` 和 `id` 必须对应 omp 可见的模型，例如宿主模型注册表里的模型，并在 omp 中配置好相应凭据。每台新机器都需要手动完成这些设置：安装插件不会附带模型链，也不会创建配置文件。没有覆盖配置时，内置的 `translatorModels: []` 会触发警告并跳过翻译，不会选择私有或隐式的模型链。使用 `omp --profile <name>` 时，omp 把 agent 目录指向 `~/.omp/profiles/<name>/agent`，该 profile 的全局配置也就在那里。如果只想配置当前项目，改用 `/thinking-translator init --project`，然后编辑 `<cwd>/.omp/thinking-translator.json`。

## 命令

```text
/thinking-translator
/thinking-translator status
/thinking-translator init
/thinking-translator init --global
/thinking-translator init --project
```

- `/thinking-translator` 和 `/thinking-translator status` 显示生效配置、配置文件路径和翻译模型的可用性。
- `/thinking-translator init` 创建全局配置，等同于 `/thinking-translator init --global`。
- `/thinking-translator init --global` 在 `<agentDir>/thinking-translator.json`（默认 `~/.omp/agent/thinking-translator.json`）不存在时创建它。
- `/thinking-translator init --project` 在当前项目的 `<cwd>/.omp/thinking-translator.json` 不存在时创建它。

init 命令写入的是一个禁用状态的模板，不会替你选模型。你必须明确设置 `translatorModels`，并把 `enabled` 设为 `true`。

## 界面语言

扩展每次需要渲染或报告文字时都会解析界面语言。设置 `OMOMP_LANG` 为 `en` 或 `zh` 即可显式选择；会忽略首尾空白和大小写，其他值则继续向下解析。否则，从 omp 的 agent 目录中唯一存在的 `omomp.yml`、`omomp.yaml`、`omomp.json` 或 `omomp.toml` 读取 `omomp-lang: { language: en|zh }`，不读取项目的 `.omp/` 目录。没有文件、存在多个文件、内容无效、语言值不是精确的 `en` 或 `zh`，或该段包含额外字段时，跳过这一步。如果仍没有语言值，就按 `LC_ALL`、`LC_MESSAGES`、`LANG` 去掉首尾空白后的第一个非空值选择：以 `zh` 开头（不区分大小写）时使用中文，否则使用英文，最终默认英文。环境变量在每次解析时重新读取；只有 omomp 设置按进程缓存，修改后在下一次启动时生效。它只改变界面文字，不会改写 thinking 内容或翻译提示词。


## 配置

`thinking-translator.json` 由本插件自己拥有。启动时不会创建文件；使用 `init` 命令或手动编写 JSON。覆盖之前使用内置默认值：`enabled: true`、`targetLanguage: "Simplified Chinese"`、`translatorModels: []`、`trace: true`。空模型链会触发警告并跳过翻译，所以新安装后需要先按上文手动配置才能翻译。配置文件只写需要覆盖的部分，按以下顺序合并到默认值上：

1. 内置默认值
2. 全局配置：`<agentDir>/thinking-translator.json`，其中 `<agentDir>` 是 omp 的 `getAgentDir()` 返回的当前 agent 目录（通常是 `~/.omp/agent`；profile 或显式 agent 目录会改变它）
3. 项目配置：`<cwd>/.omp/thinking-translator.json`

项目文件在全局文件之后读取，所以它设置的每个字段都优先。`translatorModels` 是有序链，整体替换：项目里的列表就是该项目的完整链，`null` 清空它，不写则沿用全局链。

完整配置示例：

```json
{
  "enabled": true,
  "targetLanguage": "Simplified Chinese",
  "translatorModels": [
    { "provider": "deepseek", "id": "deepseek-v4-flash", "effort": "low" },
    { "provider": "ollama", "id": "qwen2.5:7b" }
  ]
}
```

### 选项

| 选项 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `enabled` | boolean | `true` | 启用翻译处理。`translatorModels` 为空时跳过翻译并给出警告。 |
| `targetLanguage` | string | `"Simplified Chinese"` | 传给翻译模型的目标语言，必须是非空字符串。 |
| `translatorModels` | array | `[]` | 有序的翻译模型链；每一项为 `{ "provider": "...", "id": "...", "effort": "..." }`。每一项的 `provider` 和 `id` 都是必填的非空字符串；`effort` 可选（见下文）。每次请求都按这个顺序尝试（见[特性](#特性)）。某一项不是对象或缺少 `provider`/`id` 时，整个配置文件判为无效，而不是丢弃这一项，因为悄悄少一项会改变回退顺序。 |
| `trace` | string \| boolean | `true` | 诊断记录。`true` 时每一步追加一条 JSONL 记录（`session_start`、`message_start`、`thinking_end`、`factory`、`dispatch`、`request`、每个失败后换下一个模型前的 `modelFailed`、`done`/`translateError`、每次格状态变化的 `render`、`painted`、`settled`、`lateFlush`、`reset`、`missingModel`），写到会话文件旁的 `<去掉 .jsonl 的会话文件名>.thinking-translator-trace.jsonl`；`--no-session` 进程不写任何内容。字符串表示显式路径；`false` 关闭。 |

旧配置格式遗留的 `contentTypes`、`minLatinChars` 和单模型的 `translatorModel` 键会被静默忽略：只翻译 thinking 块，是否翻译按行判断而不是按块长度阈值，翻译模型只来自 `translatorModels`。

每一项的 `effort` 设置发给该模型的请求的推理强度：`off`，或宿主的级别之一 `minimal`、`low`、`medium`、`high`、`xhigh`、`max`。不设置时不发送推理字段，使用模型或服务方的默认值。请求经过 pi-ai 的 `streamSimple`，由它把级别映射到服务方自己的字段——例如在 OpenAI Responses 端点上是 `"reasoning": { "effort": "low" }`——并把 `off` 变成 pi-ai 的关闭推理请求，在通用 effort 端点上就是模型支持的最低级别。每次请求的输出上限为 1024–8192 token（按行长缩放），所以默认强度会把预算花在隐藏推理上的推理模型会返回空文本；设一个低级别可以避免。其他取值会让该配置文件无效，与解析错误完全一样，错误信息会指出是哪一项（`translatorModels[1].effort …`）。模型不支持的级别会在发出前被 pi-ai 拒绝，并算作该模型失败，于是尝试链里的下一个模型；`/thinking-translator status` 在每一项旁打印其生效 effort 和该模型声明支持的级别。

任何配置文件解析失败时，扩展会显示一次点名该路径的警告，并强制 `enabled` 为 `false`，配置损坏时不翻译任何内容。启用了翻译但 `translatorModels` 为空时，扩展警告一次并跳过翻译，不影响主助手消息。每次请求都在发出时到宿主模型注册表里查找它的模型；找不到时（`discovery: proxy` 类服务方很常见：宿主只为主模型重新发现模型，并在缓存失效或静态重载时把它们从注册表里移除），扩展请宿主重新发现该服务方（`refreshDiscoverableProviders`），再查找一次。没有冷却期，也不记住这次未命中——下一次请求会再执行同样的查找和发现；并发请求只会加入同一服务方正在进行的发现。发现之后仍找不到的模型每个会话警告一次，并算作该模型失败，于是尝试链里的下一个模型。`/thinking-translator status` 按链的顺序列出每一项及其可用性，对不在注册表里的项执行同样的发现。如果某一行的整条链在所有重试轮次中都失败，原始 thinking 保持不变，并在这一行里显示每个模型的错误。

## 工作原理

1. 扩展在看到 thinking 块流式输出时跟踪它们：`message_start` 重新加载生效配置并递增消息计数，`message_update` 以 `message:contentIndex` 为键记录每个块的原始文本（在 `thinking_end` 时标记为已结束），`message_end` 把服务方没有结束的块标记为已结束，使它的最后一行仍能被翻译。这些记录跨消息保留——上一条消息的 thinking 组件仍在重绘——且最多保留最近 32 个块。注意工具结果是一条独立消息，所以 `message_start` 会在一轮中途触发，这也是配置在那里被替换而不是清空的原因。
2. 宿主解析每个可见 thinking 块的显示文本，用它调用已注册的渲染器工厂，文本每次变化都会再调用一次。
3. 每次渲染时，扩展按换行拆分显示文本并去掉每行首尾空白。
4. 每一行都要通过按行判断，并与所有已跟踪的块比对：把 Markdown 行内代码排除在语言判断之外后，它的正文必须含有拉丁字母且拉丁字母多于中文字符，并且必须是某个已观察到的块里的完整行。“完整”指后面跟着换行，或位于一个已结束块的末尾。因此还在逐字显示的半行会等待，而不是被翻译成一串用完即弃的片段；回放的历史不匹配任何已跟踪的块，从不分发。
5. 每段行文本在同一条翻译模型链（模型、顺序及各自的 effort）和目标语言下最多翻译一次：第一次分发创建它的槽位，并通过模型链发出一个独立的流式请求，之后的渲染都复用这个槽位。慢的行不会阻塞同块的其他行，每一行都按原顺序落回原位。
6. `render()`（ANSI 终端）和 `describe()`（Tern）都经过同一个 `collect()`：分发、在表里查找每个显示的行、把已完成的格标记为已绘制，并返回已有译文的行和 `done/total` 计数。`render()` 在该块下方画框；`describe()` 返回上文描述的原生 section，内容没变时返回同一个节点对象。失败的模型把请求交给链里的下一个模型，丢弃它已输出的部分文本。如果累积的流中出现了提示词内部的 `SOURCE_TEXT_BEGIN` 标记，扩展立即中止这次模型尝试并按同类失败处理，所以标记和回显的原文不会成为一条完成的译文。整条链失败时以退避（500 ms、2 s、6 s）从第一个模型重试，之后才变成失败行。每次译文到达或失败都会调用宿主提供的 `requestRender`，所以宿主仍在渲染的框或 section 会持续填充。
7. 一条译文完成时，扩展检查框是否画过这个格。如果没有，且 Tern 没有 describe 过该组件，它把译文和 thinking 块的数字下标放进队列做短暂防抖，然后输出一条 `ctx.ui.notify` 内容。`Thinking translation · Block N` / `思考翻译 · 第 N 块` 标题在刷新时按当前界面语言生成，包括这次合并的旧行；队列不保存已翻译的块标签。刷新前发生的重绘会把该格标记为已绘制，并从这次内容里移除。如果中间没有宿主聊天事件，下一次 notify 会重新包含上一次的内容，因为宿主可能会替换同一个状态行；`message_start` 和 `toolcall_start` 在新聊天内容挂载后开始一份新的内容。
8. 译文只存在于内存表中，在会话开始、切换会话和会话关闭时连同待发的通知队列和上一次的内容一起丢弃。不向会话记录追加任何内容，也从不把译文作为模型输入回送；见[上下文边界](#上下文边界)。

## 上下文边界

翻译框是展示输出，不是对话内容。规范的助手 thinking——omp 持久化的、下一轮发送的、喂给压缩的——始终是模型产出的原文。

机制：

- 译文存放在一个模块级 `Map` 里，键是原始 thinking 行加上翻译模型链和目标语言（`extensions/thinking-translator.ts:121`，`cellKey` 在 `:577`），只有 `pi.registerAssistantThinkingRenderer` 返回的组件和流内 notify 回退会读取它（`extensions/thinking-translator.ts:153-259`、`:274-301`）。这些行流入 TUI 容器树，终止于终端写入；在宿主 18.1.19 上，没有任何消费者到达会话写入器、服务方请求构造器或压缩（`assistant-message.ts:841-860` → `pi-tui/src/tui.ts:486-513` → `tui.ts:2735-2781`），18.2.0 的 `#appendThinkingExtensions`（`assistant-message.ts:841-860`）仍然交给渲染器一个新的上下文对象，只挂载返回的组件。
- 交给渲染器的 `context.text` 是放在新分配对象里的已解析显示字符串（`assistant-message.ts:841-852`），不是指向已存储 `AgentMessage` 的引用，所以渲染器无法通过它修改消息。
- 持久化把有类型的 `SessionEntry.message` 值写入会话 JSONL（`session-manager.ts:2288-2305`、`:817-818`）；下一次请求由这些条目重建（`session-context.ts:216-272`、`agent-loop.ts:1627-1673`）；压缩对同一分支的条目做划分（`compaction.ts:1328-1382`）。这三者都不读取渲染出来的行。
- 在这个宿主里能改变模型可见数据的 hook 是 `context`、`before_provider_request`、`before_agent_start`、`session_before_compact` 和 `session_stop`。扩展一个都没有注册；它的处理器只有会话重置、按消息的状态跟踪、聊天内容 generation，以及 `message_start`/`message_update`/`message_end` 里的 thinking 块记账（`extensions/thinking-translator.ts:338-442`）。

下面最初的上下文边界检查在 omp 18.1.19 上运行：驱动真实 TUI，附加一个用完即弃的只读观察扩展，挂在 `before_provider_request`（发送前的最终 payload hook）和 `session_before_compact` 上，用渲染出的中文里的高熵片段加上框标签 `思考翻译` / `等待翻译` / `翻译失败` 作为金丝雀。针对 notify 的检查在 omp 18.1.21 上重做，见下文：

- **下一轮，任何压缩之前。** 紧跟在一个已完成翻译框之后的那一轮，其服务方 payload 带着原样的助手 `thinking` 部分（5209 字符，SHA-256 `068c357d54f0d1b0b84453a10c2a3c5c2acc445d2d116b1f39d1dd34f1923b55`）及其正文；对序列化 payload 里每个字符串的递归扫描中，每个金丝雀都出现 0 次。这次请求是在任何压缩运行之前观察到的，所以不可能有临时内容被压缩剥掉；第二次运行对它自己的压缩前一轮得到同样结果（助手 `thinking` 4491 字符，SHA-256 `e9cb8a43…`，0 个金丝雀）。
- **压缩输入。** 一次 `/compact`，其摘要集合包含被翻译的块——`messagesToSummarize` = 13，`messagesToSummarize[0]` 是同一条助手消息，thinking 哈希相同——在整个 `CompactionPreparation`、omp 随后持久化的 3958 字符摘要以及之后的服务方 payload 中，金丝雀都出现 0 次。
- **会话存储。** 对目标会话 JSONL 的每条记录、消息和内容部分做结构化扫描：金丝雀出现 0 次，持久化的 thinking 哈希与发给服务方的相同。`agent.db` 存的是设置/认证/用量表，不是对话消息，它的原始文件以及 WAL/SHM 也都是 0 次。
- **notify 运行时。** 一次真实的 omp 18.1.21 TUI 运行，用 `-e` 加载本检出，产生了一个 4650 字符的 thinking 块，随后是一次 `read package.json` 工具调用。TUI 显示了本检出的流内 `思考翻译 · 第 1 块` 行；对生成的会话 JSONL 做结构化扫描，该标题、`全面分析如何安全地检查该TypeScript项目` 以及任何 notify 内容都出现 0 次。

最小复现：

1. 写一个用完即弃的扩展，注册 `pi.on("before_provider_request", ...)` 和 `pi.on("session_before_compact", ...)`，把 payload 和 `event.preparation` 的 `JSON.stringify` 分别追加到两个文件，两个处理器都返回 `undefined`。
2. 在一个临时目录里启动 `omp -e /path/to/extensions/thinking-translator.ts -e /path/to/observer.ts`。
3. 发送一个会产生多行 thinking 块的英文提示，等到框显示 `思考翻译 · 块 N · M/M`。复制两段有辨识度的渲染中文片段——它们不能出现在提示或 thinking 本身里。
4. 再发一轮，然后在最新的 `before_provider_request` payload 中递归搜索这些片段和三个框标签。应为零次，并且助手 `thinking` 字符串的哈希应与会话 JSONL 存储的一致。
5. 添加填充轮次，直到 `/compact` 报告非空的 `messagesToSummarize`，执行它，并用同样方法搜索记录下的 `preparation` 和持久化的压缩摘要。应为零次，同时被摘要的助手消息仍带着原 thinking 哈希。
6. 解析会话 JSONL 并搜索每个内容部分。应为零次。

本边界不覆盖：

- **翻译请求本身。** 每条符合条件的 thinking 行都作为一个独立请求发给配置的翻译模型（`extensions/thinking-translator.ts:358-566`），与 agent 对话分开；某个模型失败时，同一行会发给链里的下一个模型，所以 `translatorModels` 里的每个服务方都可能收到它。“不在 agent 上下文里”不等于“不发给任何模型”：这些服务方能看到你的 thinking 文本，并按它们自己的政策保留。
- **由显示派生的产物。** 终端 scrollback、流内 notify 行、终端录屏，以及 omp 自己的 `/debug-transcript`（把渲染出的行转储到临时文件，`command-controller.ts:225-236`）按设计都包含译文行。这是可观测性界面，不是对话上下文。
- **未测试的路径。** 压缩检查是在一个恢复的已持久化会话上运行的，所以恢复只在“检查过其规范消息、服务方 payload 和压缩输入”的意义上被覆盖——没有验证历史译文会重新渲染，也没有走遍所有恢复 UI 路径。会话导出/导入序列化器和分支切换完全没有测试。
- **版本范围。** 证据针对本扩展的这个版本在 omp 18.1.19 上（notify 检查在 18.1.21 上重做）。这一保证依赖宿主的渲染器契约和上文引用的请求/压缩路径，而不是有文档的 API 承诺，所以宿主升级后要重新验证；开发依赖跟随最新发布版，这些历史金丝雀检查没有在每次发布上重做。

## 限制

- 如果一个 thinking 块不可见（例如被宿主折叠，从未渲染），宿主就不会调用翻译渲染器，也不会为它出现翻译框。
- 诊断：每个会保存会话的进程都会在会话 JSONL 旁追加 `<去掉 .jsonl 的会话文件名>.thinking-translator-trace.jsonl`（见 `trace` 选项）。其中包含事件名、行数、每条原文和译文的前 40–60 个字符、模型 id 和文件路径——足以看出一个会话的翻译停在了哪里。不能接受时设置 `trace: false`。
- 在 ANSI 终端里 scrollback 不可变。助手消息一到达工具调用，宿主就提交该 thinking 块的行，之后框就冻结在当时的内容——实测：998 ms 的译文进了框，1567 ms 的没有。流内 notify 行正是这种情况的回退，所以译文仍可在当前记录末尾、已到达的工具输出之后读到，而不是紧贴在它的 thinking 块下方。Tern 原生界面没有只追加的 scrollback：section 保持实时，不使用回退行。
- 译文只存在于内存：退出 omp 或切换会话会丢弃它们，重新打开会话时不会为之前显示过的消息补译。
- 同一会话内，只要翻译模型链和目标语言不变，两条相同的行共用一条译文。

## 安全说明

omp 扩展拥有完整的系统权限。安装第三方包前请审阅扩展源码。

翻译后端会收到符合条件的 thinking 行；如果这些内容不应离开你的机器，请使用本地模型。

## 开发

```bash
pnpm install
pnpm check
```

`pnpm check` 运行 TypeScript 检查和测试文件。测试在 Bun 下运行，因为宿主包以 TypeScript 源码作为入口。

## 包结构

- `extensions/thinking-translator.ts` —— 扩展本体：渲染器注册、事件处理、翻译分发和配置命令。
- `tests/thinking-translator.test.ts` —— 配置处理和翻译辅助函数的单元测试。
- `package.json` —— 声明 `omp.extensions` 入口和仅用于开发的宿主依赖的 manifest。
- `README.md` —— 英文说明；`README.zh-CN.md` 是本文件，即它的简体中文版。
