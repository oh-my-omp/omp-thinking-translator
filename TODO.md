# TODO

## 1. 展示再次加强

- [ ] 设计更简洁的默认展示格式，避免重复英文原文、技术 marker、过多标题层级。
- [ ] 支持配置展示模式：仅译文 / 中英对照 / 折叠详情。
- [x] 译文不持久化：只存在会话内存里，会话结束或切换即丢弃，卸载插件后历史里没有译文。
- [ ] 清理小模型常见包裹输出，例如 `<text>...</text>`、多余解释、代码块包裹。
- [x] 明确异常展示策略：翻译失败时只提示一次，不污染主消息。每组失败模型提示一次，失败行只出现在翻译框里。

验收标准：
- 默认模式只追加必要译文。
- 不显示内部 marker。
- 长 thinking 不显著刷屏。

## 2. 确认不进入对话流

- [x] 验证译文是否会进入后续 LLM 上下文：不会。omp 19.0.0 上用只读观察扩展挂 `before_provider_request`（发送前最后一道钩子），两个会话各两轮、共 10 个请求的完整 payload 里，译文片段与译文框标题出现 0 次；会话文件里存的仍是英文原文 thinking。
- [x] 现架构下译文从不写入 canonical message，因此不需要 `context` / `session_before_compact` 过滤；扩展也不注册这五个能改模型可见数据的钩子（`context`、`before_provider_request`、`before_agent_start`、`session_before_compact`、`session_stop`）。旧的过滤实现属于译文作为消息追加的时代（14a4343），迁移到渲染器后已随之删除。
- [x] 验证 compaction 不会把译文当作原始 thinking 参与摘要：在译文框已画完的同一进程里执行 `/compact`，`session_before_compact` 的 `messagesToSummarize` 含第一轮 assistant 消息，其中 thinking 是原文；preparation、落盘的摘要和会话文件中译文与框标题均为 0 次。
- [x] README 新增 [Context Boundary](README.md#context-boundary)：机制、最小复现步骤，以及不覆盖的范围（翻译请求本身、终端/`debug-transcript` 等展示衍生产物、导出导入与分支切换未测）。

验收标准：
- 翻译展示不改变原始 thinking/reasoning block。
- 翻译展示不会影响后续模型思考内容。
- 可通过最小复现步骤确认上下文无污染。

以上三条已在 omp 19.0.0 上用 1.0 的事件驱动实现、在真实 TUI 会话中验证，复现步骤见 README 的 Context Boundary 一节。

## 3. 添加 API 翻译支持

- [ ] 在保留 model-based translation 的基础上，抽象 translator provider 接口。
- [ ] 支持 Google Cloud Translation API。
- [ ] 支持 MyMemory 免费接口，并处理单次长度限制。
- [ ] 支持 LibreTranslate / 自部署 API。
- [ ] 所有 API key 和 endpoint 只从插件设置读取，不使用环境变量。
- [ ] README 里明确各 API 的免费额度、限制和隐私风险。

验收标准：
- 插件设置可切换 `model` / `google` / `mymemory` / `libretranslate`。
- API 翻译失败时自动给出清晰错误，不影响主对话。
- 不提交任何用户本地 key 或私有配置。
