# Provider 架构重构设计

**初稿日期**：2026-04-09
**修订日期**：2026-04-10（方向切换，详见 §1.5）
**范围**：`packages/core/src/llm/`
**类型**：重构 + 引入 Vercel AI SDK 作为底座 + 行为硬化
**替换对象**：`packages/core/src/llm/provider.ts`（1002 行单文件）

## 1. 背景与动机

### 1.1 现状

`packages/core/src/llm/provider.ts` 当前是一个 1002 行的单文件，承担了以下职责：

1. `LLMClient` 工厂（`createLLMClient`）
2. `chatCompletion` 与 `chatWithTools` 两个公共入口
3. 流进度监控（`createStreamMonitor`）
4. 部分响应抢救（`PartialResponseError`）
5. 错误包装（`wrapLLMError` 字符串匹配 HTTP 码）
6. stream → sync 降级编排（通过 `isLikelyStreamError` 启发式判断）
7. 消息格式翻译（`AgentMessage` → OpenAI chat / OpenAI responses / Anthropic）
8. 9 个矩阵函数（2 provider × 2 OpenAI 格式 × 2 模式 × 2 调用类型，缺 3 个 tool-calling sync）

对外导出 7 个符号，被 7 个文件消费（`pipeline/runner.ts`、`pipeline/agent.ts`、`agents/base.ts`、`index.ts` 等）。

### 1.2 痛点（用户明确确认的四项）

1. **结构臃肿 / 难维护**：单文件 1002 行，职责混杂
2. **扩展新 provider 成本高**：加一个 provider 要改标签枚举、改两个入口的 `if/else` 分派、新增 4 个函数、新增一个消息适配器
3. **fallback / 错误处理不健壮**：字符串匹配脆弱；tool-calling 不享受 stream→sync fallback、不享受 partial salvage、不享受富错误包装
4. **类型安全 / 可测性差**：`_openai?: OpenAI` / `_anthropic?: Anthropic` 两个可选字段 + `!` 断言污染；核心函数用 `any` 逃逸类型系统

### 1.3 额外信号

- 用户报告"**相当多的 provider bug**"，主要集中在**代理 / OpenAI 兼容接口的怪毛病**（特殊 header、stream 只能开不能关、400/415 参数不兼容、错误体不标准）
- 用户有**未来自动路由**的需求：让不同模型做不同的事（writer / auditor / planner 各自用不同的模型），但不在本次实现范围内

### 1.4 外部参考的关键发现（初稿阶段）

**LobeHub `@lobechat/model-runtime`**（80+ provider，自写到底）：
- **双工厂**：`createOpenAICompatibleRuntime` + `createAnthropicCompatibleRuntime`
- 每个 provider 是一个 ~20 行的配置对象
- 可组合的流式 transformer pipeline
- 30+ 个 `AgentRuntimeErrorType` 枚举

**Cherry Studio**（放弃自写，改用 Vercel AI SDK）：
- **关键历史教训**：早年自写过 `CoreRequest` + 中间件链 + `ApiClient.getRequestTransformer()`，**后来全拆掉了**
- 警告：**"不要发明自己的 Request/Response 类型"**
- 放弃自写后改用 `ai` + `@ai-sdk/*` 系列包作为底座
- 上层只保留 Extension Registry + `{match, build}[]` 分派表 + 错误结构化 context

### 1.5 方向切换（2026-04-10）

初稿（§1.4 之前）设计了"自写双工厂 + 自写 stream transformer pipeline + 8 类错误 taxonomy"的方案 D+2。在写完 spec 后，对 **Vercel AI SDK** 做了进一步的事实核实，发现：

1. **`createOpenAI({headers, fetch, baseURL})` + `createOpenAICompatible({headers, queryParams, includeUsage, fetch})`** 原生支持代理场景需要的所有定制点——自定义 `fetch` 钩子允许在请求/响应层面拦截任意 HTTP 调用，这比我们自建的 `handleError`/`handlePayload` 钩子体系更通用
2. **`streamText({abortSignal, onAbort, onError})`** + `result.fullStream` 是 Node-native AsyncIterable，不是 Web Response。Node CLI 场景直接适用
3. **Tool-calling 原生一体化**：不存在 simple-chat × tool-calling 的矩阵分叉
4. **Cherry Studio 的 tear-down 证据**：他们已经走过"自写"这条路并放弃，现在稳定运行在 AI SDK 之上
5. **依赖体积可接受**：`ai` + `@ai-sdk/openai` + `@ai-sdk/anthropic` + `@ai-sdk/openai-compatible` 合计 ~230KB，远小于 `@lobechat/model-runtime` 的 ~1.5MB

**结论**：方向从"自写"（方案 D+2）切换到"依赖 Vercel AI SDK 做底座 + 自写薄 orchestration 层"（方案 B）。预估代码量从 ~1500 行降到 ~500 行。Cherry Studio 的设计模式（Registry + `{match, build}[]` 分派表 + 结构化 error context）全部保留。

**沉没成本评估**：
- `chore(gitignore): track design specs` — 不受影响，保留
- `docs: add CLAUDE.md with atomic commit convention` — 不受影响，保留
- `docs(llm): add provider refactor design spec` — **本次覆盖替换**，§5-§10 重写，§11-§17 大部分保留

## 2. 目标与非目标

### 2.1 目标

- **T1**：消灭 1002 行单文件，拆成 ~15 个 ≤200 行的单一职责模块
- **T2**：`_openai?` / `_anthropic?` 可选字段消失，类型系统不再需要 `!` 断言
- **T3**：加新 OpenAI 兼容 provider = 新增一个 ~15 行配置文件 + 在 registry 加一行（AI SDK 已经实现了 90% 的 SDK 包装）
- **T4**：tool-calling 与 simple chat 共享全部健壮性（fallback、partial salvage、错误包装）——这是 AI SDK `streamText` 原生行为
- **T5**：代理怪毛病通过 `createOpenAICompatible({fetch, headers, queryParams})` 的自定义 `fetch` 钩子隔离到对应 provider 文件
- **T6**：所有 7 个调用点**零修改**（通过兼容 shim 实现）
- **T7**：为未来路由层预留接缝——`LLMPool.chat({ task, ... })` 的 API 形状固定下来
- **T8**：完整测试覆盖 + 真实 API smoke 测试矩阵（见 §18）

### 2.2 非目标

- ❌ **不加新 provider**（不实现 DeepSeek、Moonshot、Gemini、Ollama 等——但架构支持 ~15 行配置即可扩展）
- ❌ **不加新能力**（不使用 AI SDK 的 `embed`、`generateObject`、`textToImage`，虽然它们都是免费的）
- ❌ **不实现完整的路由逻辑**（只打桩 `DirectRouter` 做显式映射）
- ❌ **不修改调用方代码**（7 个消费点一行不动）
- ❌ **不改变对外观察到的行为**（除 tool-calling 新增的对齐能力，那是硬化）

## 3. 架构总览

### 3.1 四层模型

```
┌───────────────────────────────────────────────────────────────┐
│  Layer 4: Pipeline / Agents（本次不动）                         │
│  writer / auditor / planner / settler / ...                   │
└───────────────────────┬───────────────────────────────────────┘
                        │ 通过兼容 shim：createLLMClient / chatCompletion / chatWithTools
                        ▼
┌───────────────────────────────────────────────────────────────┐
│  Layer 3: LLMPool + Router（本次打桩）                          │
│  • 多 runtime 按 alias 注册                                     │
│  • Router 接口 + DirectRouter 实现（显式映射）                    │
│  • 未来扩展：CapabilityRouter / CostRouter / FallbackRouter     │
└───────────────────────┬───────────────────────────────────────┘
                        │ runtime.chat(payload)
                        ▼
┌───────────────────────────────────────────────────────────────┐
│  Layer 2: Orchestrator（单个函数：chat payload → ChatResult） │
│  • 调 AI SDK streamText() 或 generateText()                    │
│  • 消费 result.fullStream 缓冲 text + 收集 tool calls          │
│  • stream → sync fallback（AI SDK 错误 → generateText 重试）   │
│  • partial response salvage（缓冲 > 500 字符时返回 error_partial）│
│  • 错误映射（AI SDK APICallError → 我们的 LLMError）           │
└───────────────────────┬───────────────────────────────────────┘
                        │ 调用 Vercel AI SDK 底座
                        ▼
┌───────────────────────────────────────────────────────────────┐
│  Layer 1: LLMRuntime（concrete class, thin wrapper）          │
│                                                                │
│  LLMRuntime = { id, LanguageModelV2, defaults, quirks? }     │
│  LanguageModelV2 由 AI SDK 工厂生成：                           │
│  ├── createOpenAI({fetch, headers, ...})                      │
│  │     .chat(model)       ← openai-chat provider              │
│  │     .responses(model)  ← openai-responses provider         │
│  ├── createAnthropic({fetch, headers, ...})                   │
│  │     (model)            ← anthropic provider                │
│  └── createOpenAICompatible({fetch, headers, queryParams})    │
│        (model)            ← openai-custom provider            │
│                                                                │
│  我们不写任何 SDK 包装代码。                                     │
└───────────────────────────────────────────────────────────────┘
```

### 3.2 模块布局

```
packages/core/src/llm/
├── index.ts                                # 公共 API（兼容现有导出符号）
│
├── types/
│   ├── payload.ts                          # ChatPayload + ChatResult + RuntimeDefaults
│   ├── message.ts                          # LLMMessage, AgentMessage, ToolDefinition, ToolCall
│   └── stream-event.ts                     # StreamEvent union（我们的事件类型）
│
├── runtime/
│   ├── runtime.ts                          # LLMRuntime class（~40 行）
│   ├── resolve-model.ts                    # LLMConfig → LanguageModelV2（AI SDK 工厂分发）
│   ├── message-adapter.ts                  # AgentMessage ↔ AI SDK ModelMessage
│   └── orchestrator.ts                     # streamText/generateText + fallback + salvage
│
├── providers/                              # 每个 provider 都是 ~15 行配置
│   ├── openai.ts                           # createOpenAI(...).chat(model)
│   ├── openai-responses.ts                 # createOpenAI(...).responses(model)
│   ├── openai-custom.ts                    # createOpenAICompatible(...)(model)
│   ├── anthropic.ts                        # createAnthropic(...)(model)
│   └── registry.ts                         # providerRegistry + variant 解析
│
├── dispatch/
│   └── config-builders.ts                  # {match, build}[] 表（从 LLMConfig 构造 runtime）
│
├── pool/
│   ├── pool.ts                             # LLMPool 类
│   ├── router.ts                           # Router 接口 + DirectRouter
│   └── types.ts                            # TaskIntent + 预定义常量
│
├── errors/
│   ├── types.ts                            # LLMError 基类 + 8 个 ErrorType
│   └── mapper.ts                           # AI SDK error → LLMError
│
├── quirks/
│   └── proxy-quirks.ts                     # buildProxyFetch(quirks) 工厂
│
├── compat/
│   └── legacy-api.ts                       # createLLMClient / chatCompletion / chatWithTools
│
└── __smoke__/
    └── run.ts                              # 真实 API smoke runner（§18）
```

**文件大小预估**：
- `runtime/orchestrator.ts`：~180 行（最大文件，包含 streamText 消费 + fallback + salvage 逻辑）
- `runtime/resolve-model.ts`：~80 行
- `runtime/message-adapter.ts`：~100 行
- `runtime/runtime.ts`：~40 行
- 其他文件：≤100 行
- **总代码量 ~600 行**（vs v1 估算的 1500 行），分散在 ~20 个文件

## 4. 核心类型契约

### 4.1 `ChatPayload`（公共入口的薄载荷）

```ts
// types/payload.ts
import type { AbortSignal } from "abort-controller";
import type { LLMMessage } from "./message.js";
import type { ToolDefinition } from "./message.js";

export interface ChatPayload {
  readonly model: string;                           // wire-level 模型 id
  readonly messages: ReadonlyArray<LLMMessage>;
  readonly stream?: boolean;                        // 默认继承 runtime.defaults.stream
  readonly temperature?: number;
  readonly maxTokens?: number;
  readonly tools?: ReadonlyArray<ToolDefinition>;   // 有 → tool-calling，无 → simple chat
  readonly toolChoice?: "auto" | "none" | "required" | { name: string };
  readonly webSearch?: boolean;                     // 映射为 provider-specific 工具
  readonly thinkingBudget?: number;                 // Anthropic extended thinking
  readonly onStreamProgress?: OnStreamProgress;
  readonly signal?: AbortSignal;
}

export type OnStreamProgress = (progress: StreamProgress) => void;

export interface StreamProgress {
  readonly elapsedMs: number;
  readonly totalChars: number;
  readonly chineseChars: number;
  readonly status: "streaming" | "done";
}

export interface RuntimeDefaults {
  readonly temperature: number;
  readonly maxTokens: number;
  readonly maxTokensCap: number | null;
  readonly thinkingBudget: number;
  readonly stream: boolean;
  readonly extra: Record<string, unknown>;
}
```

**设计决定**：
- `tools` 是基础 payload 的一部分 → tool-calling 和 simple chat 合并为同一个入口
- `signal: AbortSignal` 是一等公民 → 直接传给 AI SDK `streamText({abortSignal})`
- `onStreamProgress` 保留现有语义（30s 定时回调），但实现上改成在 `fullStream` 消费循环里驱动，不再需要独立的 `StreamMonitor` 类

### 4.2 `ChatResult`

```ts
// types/payload.ts
export interface ChatResult {
  readonly content: string;
  readonly toolCalls: ReadonlyArray<ToolCall>;      // 空数组代替 undefined
  readonly usage: Usage;
  readonly finishReason: FinishReason;
}

export type FinishReason =
  | "stop"                // 正常完成
  | "length"              // 达到 maxTokens
  | "tool_calls"          // 要求工具调用
  | "content_filter"      // 被审查
  | "error_partial";      // salvage 到的不完整内容

export interface Usage {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
}
```

### 4.3 `StreamEvent`（内部类型）

AI SDK 的 `fullStream` 吐出它自己的 event 类型（`text-delta`、`tool-call`、`tool-result`、`finish`、`error` 等）。我们**不再定义独立的 `StreamEvent` union**——直接在 `orchestrator.ts` 里消费 AI SDK 的事件即可。Layer 2 的抽象到 `ChatResult` 为止。

（v1 设计的 `StreamEvent` union 被 AI SDK 内置的 `FullStreamPart` 吃掉了，是正向简化。）

### 4.4 `LLMError`（错误 taxonomy）

```ts
// errors/types.ts
export const enum ErrorType {
  InvalidAPIKey = "INVALID_API_KEY",         // 401
  PermissionDenied = "PERMISSION_DENIED",     // 403
  QuotaExceeded = "QUOTA_EXCEEDED",           // 429
  ContextOverflow = "CONTEXT_OVERFLOW",       // 400 + context_length_exceeded
  ModelNotFound = "MODEL_NOT_FOUND",          // 400 + model_not_found
  ProviderBizError = "PROVIDER_BIZ_ERROR",    // 其他业务错误
  ConnectionError = "CONNECTION_ERROR",       // 网络/DNS/超时
  StreamInterrupted = "STREAM_INTERRUPTED",   // 流中断
}

export interface ErrorContext {
  readonly provider?: string;
  readonly model?: string;
  readonly endpoint?: string;
  readonly httpStatus?: number;
  readonly partialContent?: string;           // 仅 StreamInterrupted 填充
  readonly hint?: string;                     // 给人类看的中文建议
}

export class LLMError extends Error {
  constructor(
    readonly type: ErrorType,
    message: string,
    readonly context: ErrorContext = {},
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "LLMError";
  }
}
```

## 5. `LLMRuntime` 类（薄壳包装 AI SDK）

```ts
// runtime/runtime.ts
import type { LanguageModelV2 } from "@ai-sdk/provider";
import type { ChatPayload, ChatResult, RuntimeDefaults } from "../types/payload.js";
import { orchestrate } from "./orchestrator.js";

export interface LLMRuntime {
  readonly id: string;
  readonly model: LanguageModelV2;             // AI SDK 模型实例
  readonly defaults: RuntimeDefaults;
  readonly providerName: string;                // 用于错误上下文
  chat(payload: ChatPayload): Promise<ChatResult>;
}

export function createRuntime(config: {
  id: string;
  model: LanguageModelV2;
  defaults: RuntimeDefaults;
  providerName: string;
}): LLMRuntime {
  return {
    ...config,
    async chat(payload: ChatPayload): Promise<ChatResult> {
      return orchestrate(this, payload);
    },
  };
}
```

**对比 v1**：v1 设计的 `abstract class LLMRuntime` 带模板方法；v2 不需要抽象类和多态，因为**所有 provider 共享同一条 orchestration 路径**——AI SDK 已经吃掉了"各家 SDK 怎么调"的差异，我们只需要一个函数 `orchestrate(runtime, payload)`。

## 6. Model 解析：`LLMConfig → LanguageModelV2`

这是整个重构的**关键简化点**。v1 里我们要自写 `createOpenAICompatibleRuntime` 和 `createAnthropicCompatibleRuntime` 两个工厂；v2 里 AI SDK 已经提供了四个现成的工厂，我们只需要一个 dispatcher：

```ts
// runtime/resolve-model.ts
import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModelV2 } from "@ai-sdk/provider";
import type { LLMConfig } from "../../models/project.js";
import { buildProxyFetch } from "../quirks/proxy-quirks.js";

export interface ResolvedModel {
  readonly model: LanguageModelV2;
  readonly providerName: string;
}

export function resolveLanguageModel(config: LLMConfig): ResolvedModel {
  const sharedOptions = {
    apiKey: config.apiKey,
    baseURL: config.baseUrl,
    headers: config.headers ?? parseEnvHeaders(),  // 保留 INKOS_LLM_HEADERS
    fetch: buildProxyFetch(config),                // 代理 quirks 注入点
  };

  if (config.provider === "anthropic") {
    const anthropic = createAnthropic(sharedOptions);
    return { model: anthropic(config.model), providerName: "anthropic" };
  }

  if (config.provider === "openai") {
    const openai = createOpenAI(sharedOptions);
    const model = config.apiFormat === "responses"
      ? openai.responses(config.model)
      : openai.chat(config.model);
    return { model, providerName: `openai-${config.apiFormat ?? "chat"}` };
  }

  // config.provider === "custom" → OpenAI-compatible proxy
  const compatible = createOpenAICompatible({
    ...sharedOptions,
    name: "openai-custom",
    includeUsage: config.extra?.includeUsage !== false,  // 默认 true，代理可关闭
  });
  return { model: compatible(config.model), providerName: "openai-custom" };
}
```

这一个文件就**替换了 v1 的整个 §5 + §6 + §7**（LLMRuntime 抽象类 + OpenAI 兼容工厂 + Anthropic 兼容工厂，共计 ~500 行）。

## 7. Provider 配置文件（退化为小工厂函数）

v1 里 provider 是一个 extension 配置对象 + `createXxxCompatibleRuntime` 工厂。v2 里 provider 就是一个薄构造函数，把 `LLMConfig` 喂给 `resolveLanguageModel` + 包装成 `LLMRuntime`：

```ts
// providers/openai.ts
import { createRuntime } from "../runtime/runtime.js";
import { resolveLanguageModel } from "../runtime/resolve-model.js";
import type { LLMConfig } from "../../models/project.js";
import { buildDefaults } from "./defaults.js";

export function buildOpenAIRuntime(config: LLMConfig) {
  const { model, providerName } = resolveLanguageModel({ ...config, provider: "openai", apiFormat: "chat" });
  return createRuntime({
    id: "openai",
    model,
    defaults: buildDefaults(config),
    providerName,
  });
}
```

```ts
// providers/openai-responses.ts
export function buildOpenAIResponsesRuntime(config: LLMConfig) {
  const { model, providerName } = resolveLanguageModel({ ...config, provider: "openai", apiFormat: "responses" });
  return createRuntime({ id: "openai-responses", model, defaults: buildDefaults(config), providerName });
}
```

```ts
// providers/openai-custom.ts
export function buildOpenAICustomRuntime(config: LLMConfig) {
  const { model, providerName } = resolveLanguageModel({ ...config, provider: "custom" });
  return createRuntime({ id: "openai-custom", model, defaults: buildDefaults(config), providerName });
}
```

```ts
// providers/anthropic.ts
export function buildAnthropicRuntime(config: LLMConfig) {
  const { model, providerName } = resolveLanguageModel({ ...config, provider: "anthropic" });
  return createRuntime({ id: "anthropic", model, defaults: buildDefaults(config), providerName });
}
```

四个 provider 文件加起来 ~60 行。加新 provider（比如 DeepSeek）几乎是同样的模板，只需要在 `resolveLanguageModel` 里加一个分支调用 `createOpenAICompatible` + 指定 baseURL/defaultHeaders。

## 8. Orchestrator：消费 `fullStream` + fallback + salvage

这是 Layer 2 的核心，也是我们自写代码最集中的地方。但总量 ≤200 行。

```ts
// runtime/orchestrator.ts
import { streamText, generateText, type CoreMessage } from "ai";
import type { LLMRuntime } from "./runtime.js";
import type { ChatPayload, ChatResult, Usage, FinishReason } from "../types/payload.js";
import { adaptMessages, adaptTools, adaptToolCall } from "./message-adapter.js";
import { mapAISDKError } from "../errors/mapper.js";
import { LLMError, ErrorType } from "../errors/types.js";

const MIN_SALVAGEABLE_CHARS = 500;

export async function orchestrate(runtime: LLMRuntime, payload: ChatPayload): Promise<ChatResult> {
  const useStream = payload.stream ?? runtime.defaults.stream;
  const ctx = { provider: runtime.providerName, model: payload.model };

  try {
    return useStream
      ? await runStreaming(runtime, payload)
      : await runSync(runtime, payload);
  } catch (error) {
    // Partial salvage: 如果已经在 runStreaming 里缓冲了足够内容，它会直接返回 error_partial，不会走到这里
    if (useStream && isLikelyStreamBug(error)) {
      // Stream → sync fallback
      try {
        return await runSync(runtime, payload);
      } catch (syncError) {
        if (isStreamRequiredError(syncError)) {
          throw wrapStreamRequiredError(error, syncError, ctx);
        }
        throw mapAISDKError(syncError, ctx);
      }
    }
    throw mapAISDKError(error, ctx);
  }
}

async function runStreaming(runtime: LLMRuntime, payload: ChatPayload): Promise<ChatResult> {
  const resolved = resolveOptions(runtime, payload);
  let buffered = "";
  const toolCalls = [];
  let usage: Usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  let finishReason: FinishReason = "stop";
  let deferredError: unknown = null;

  const startTime = Date.now();
  const progressTimer = payload.onStreamProgress ? startProgressTimer(startTime, () => buffered, payload.onStreamProgress) : null;

  const result = streamText({
    model: runtime.model,
    messages: adaptMessages(payload.messages),
    tools: payload.tools ? adaptTools(payload.tools) : undefined,
    toolChoice: payload.toolChoice,
    abortSignal: payload.signal,
    temperature: resolved.temperature,
    maxOutputTokens: resolved.maxTokens,
    onError: ({ error }) => { deferredError = error; },
  });

  try {
    for await (const part of result.fullStream) {
      switch (part.type) {
        case "text-delta":
          buffered += part.text;
          break;
        case "tool-call":
          toolCalls.push(adaptToolCall(part));
          break;
        case "finish":
          usage = adaptUsage(part.usage);
          finishReason = mapFinishReason(part.finishReason);
          break;
        case "error":
          deferredError = part.error;
          break;
        // tool-input-delta, tool-result, reasoning 等事件本次不消费
      }
    }
  } catch (iterationError) {
    deferredError ??= iterationError;
  } finally {
    progressTimer?.stop();
  }

  if (deferredError) {
    // Partial salvage: 已缓冲 >500 字符则返回部分结果，否则抛错
    if (buffered.length >= MIN_SALVAGEABLE_CHARS) {
      return { content: buffered, toolCalls, usage, finishReason: "error_partial" };
    }
    throw deferredError;   // orchestrate() 外层会做 fallback 和 mapAISDKError
  }

  payload.onStreamProgress?.({
    elapsedMs: Date.now() - startTime,
    totalChars: buffered.length,
    chineseChars: countChinese(buffered),
    status: "done",
  });

  return { content: buffered, toolCalls, usage, finishReason };
}

async function runSync(runtime: LLMRuntime, payload: ChatPayload): Promise<ChatResult> {
  const resolved = resolveOptions(runtime, payload);
  const result = await generateText({
    model: runtime.model,
    messages: adaptMessages(payload.messages),
    tools: payload.tools ? adaptTools(payload.tools) : undefined,
    toolChoice: payload.toolChoice,
    abortSignal: payload.signal,
    temperature: resolved.temperature,
    maxOutputTokens: resolved.maxTokens,
  });
  return {
    content: result.text,
    toolCalls: result.toolCalls.map(adaptToolCall),
    usage: adaptUsage(result.usage),
    finishReason: mapFinishReason(result.finishReason),
  };
}
```

**关键收益**：
- **~120 行的 orchestrator** 覆盖了 v1 里 9 个矩阵函数的全部功能
- **tool-calling 和 simple chat 使用同一条路径**，`result.toolCalls` 是 AI SDK 原生输出
- **stream → sync fallback 只需要 try/catch**，因为 `streamText` 和 `generateText` 接收几乎相同的参数
- **partial salvage 逻辑清晰**：`for await` 循环 + 一个 `buffered` 累加器 + 一个错误哨兵

## 9. 代理 quirks：通过 `fetch` 钩子

v1 通过 `handleError` / `handlePayload` 钩子注入 provider 特异行为；v2 用 AI SDK 的 `fetch` option 更简洁：

```ts
// quirks/proxy-quirks.ts
import type { LLMConfig } from "../../models/project.js";

export type QuirkFetch = typeof fetch;

export function buildProxyFetch(config: LLMConfig): QuirkFetch | undefined {
  // 默认不注入（官方 provider 不需要）
  if (config.provider !== "custom" && !hasKnownQuirks(config)) {
    return undefined;
  }

  return async (input, init) => {
    // 1. 请求改写：去掉某些代理不接受的字段
    const modifiedInit = rewriteRequest(init, config);

    // 2. 调用上游
    const response = await fetch(input, modifiedInit);

    // 3. 响应改写：某些代理的错误体不符合 OpenAI 格式，这里可以改写
    if (!response.ok) {
      return await rewriteErrorResponse(response, config);
    }

    return response;
  };
}

function rewriteRequest(init: RequestInit | undefined, config: LLMConfig): RequestInit | undefined {
  if (!init?.body || typeof init.body !== "string") return init;

  try {
    const body = JSON.parse(init.body);
    // 代理特有：某些代理不接受 stream_options.include_usage
    if (config.extra?.excludeUsage && body.stream_options) {
      delete body.stream_options.include_usage;
      if (Object.keys(body.stream_options).length === 0) delete body.stream_options;
    }
    // 更多 quirks 按需追加
    return { ...init, body: JSON.stringify(body) };
  } catch {
    return init;
  }
}

async function rewriteErrorResponse(response: Response, config: LLMConfig): Promise<Response> {
  // 当代理返回非标 JSON 时，这里重写成 OpenAI 格式让 AI SDK 能正确解析
  const text = await response.text();
  if (text.includes("content_filter") || text.includes("sensitive")) {
    // 伪造一个 OpenAI 风格的错误体
    return new Response(
      JSON.stringify({ error: { type: "permission_denied", message: text, code: "content_filter" } }),
      { status: response.status, headers: { "Content-Type": "application/json" } },
    );
  }
  return new Response(text, { status: response.status, headers: response.headers });
}
```

**收益**：
- 代理 quirks 集中在一个文件（~80 行），每个 quirk 是一个 `if` 分支
- 可单元测试：mock `fetch`，验证 body 被正确改写
- 新增代理 bug → 加一个 `if`，不碰 runtime/orchestrator

## 10. Registry + Dispatch 表

```ts
// providers/registry.ts
import { buildOpenAIRuntime } from "./openai.js";
import { buildOpenAIResponsesRuntime } from "./openai-responses.js";
import { buildOpenAICustomRuntime } from "./openai-custom.js";
import { buildAnthropicRuntime } from "./anthropic.js";
import type { LLMConfig } from "../../models/project.js";
import type { LLMRuntime } from "../runtime/runtime.js";

export const providerBuilders = {
  "openai": buildOpenAIRuntime,
  "openai-responses": buildOpenAIResponsesRuntime,
  "openai-custom": buildOpenAICustomRuntime,
  "anthropic": buildAnthropicRuntime,
} as const satisfies Record<string, (c: LLMConfig) => LLMRuntime>;

export type ProviderId = keyof typeof providerBuilders;
```

```ts
// dispatch/config-builders.ts
import type { LLMConfig } from "../../models/project.js";
import type { ProviderId } from "../providers/registry.js";

interface Builder {
  readonly match: (c: LLMConfig) => boolean;
  readonly providerId: ProviderId;
}

export const configBuilders: ReadonlyArray<Builder> = [
  { match: (c) => c.provider === "anthropic", providerId: "anthropic" },
  { match: (c) => c.provider === "openai" && c.apiFormat === "responses", providerId: "openai-responses" },
  { match: (c) => c.provider === "openai", providerId: "openai" },
  { match: (c) => c.provider === "custom", providerId: "openai-custom" },
];

export function resolveProviderId(config: LLMConfig): ProviderId {
  const builder = configBuilders.find((b) => b.match(config));
  if (!builder) throw new Error(`Unsupported provider config: ${JSON.stringify(config)}`);
  return builder.providerId;
}
```

Cherry Studio 的 `{match, build}[]` 模式被完整保留。加新 provider = 数组末尾加一条。

## 11. Pool + DirectRouter（Layer 3 打桩，v1 不变）

```ts
// pool/types.ts
export type TaskIntent = string;
export const TaskIntents = {
  WriteChapter: "write-chapter",
  Audit: "audit",
  Plan: "plan",
  Revise: "revise",
  Summarize: "summarize",
  ToolAgent: "tool-agent",
} as const;
```

```ts
// pool/router.ts
export interface Router {
  route(intent: TaskIntent | undefined, explicit?: string): string;
}

export class DirectRouter implements Router {
  constructor(
    private readonly taskMap: ReadonlyMap<TaskIntent, string>,
    private readonly defaultAlias: string,
  ) {}

  route(intent: TaskIntent | undefined, explicit?: string): string {
    if (explicit) return explicit;
    if (intent && this.taskMap.has(intent)) return this.taskMap.get(intent)!;
    return this.defaultAlias;
  }
}
```

```ts
// pool/pool.ts
import type { LLMRuntime } from "../runtime/runtime.js";
import type { ChatPayload, ChatResult } from "../types/payload.js";
import type { TaskIntent } from "./types.js";
import type { Router } from "./router.js";

export class LLMPool {
  private readonly runtimes = new Map<string, LLMRuntime>();

  constructor(private readonly router: Router) {}

  register(alias: string, runtime: LLMRuntime): void {
    this.runtimes.set(alias, runtime);
  }

  async chat(req: ChatPayload & { task?: TaskIntent; alias?: string }): Promise<ChatResult> {
    const alias = this.router.route(req.task, req.alias);
    const runtime = this.runtimes.get(alias);
    if (!runtime) throw new Error(`No runtime registered for alias "${alias}"`);
    return runtime.chat(req);
  }
}
```

**未来扩展路径**：`CapabilityRouter`（按模型能力表打分）、`CostRouter`（按成本优先）、`FallbackRouter`（失败降级）。本次均不实现。

## 12. 向后兼容 Shim

```ts
// compat/legacy-api.ts
import { LLMPool } from "../pool/pool.js";
import { DirectRouter } from "../pool/router.js";
import { providerBuilders } from "../providers/registry.js";
import { resolveProviderId } from "../dispatch/config-builders.js";
import type { LLMConfig } from "../../models/project.js";

/** 老接口：保持符号、保持签名。内部转成 Pool + DirectRouter。 */
export function createLLMClient(config: LLMConfig): LLMClient {
  const providerId = resolveProviderId(config);
  const build = providerBuilders[providerId];
  const runtime = build(config);
  const pool = new LLMPool(new DirectRouter(new Map(), "default"));
  pool.register("default", runtime);
  // 不再包含 _openai / _anthropic 字段（自审确认无生产消费）
  return {
    _pool: pool,
    provider: config.provider,
    defaults: runtime.defaults,
    apiFormat: config.apiFormat ?? "chat",
    stream: config.stream ?? true,
  };
}

export async function chatCompletion(
  client: LLMClient,
  model: string,
  messages: ReadonlyArray<LLMMessage>,
  options?: { temperature?: number; maxTokens?: number; webSearch?: boolean; onStreamProgress?: OnStreamProgress },
): Promise<LLMResponse> {
  const result = await client._pool.chat({ model, messages, ...options });
  return { content: result.content, usage: result.usage };
}

export async function chatWithTools(
  client: LLMClient,
  model: string,
  messages: ReadonlyArray<AgentMessage>,
  tools: ReadonlyArray<ToolDefinition>,
  options?: { temperature?: number; maxTokens?: number },
): Promise<ChatWithToolsResult> {
  const result = await client._pool.chat({
    model,
    messages: adaptAgentMessages(messages),
    tools,
    ...options,
  });
  return { content: result.content, toolCalls: result.toolCalls };
}
```

**导出符号对齐**：`index.ts` 重新导出 `createLLMClient`、`chatCompletion`、`chatWithTools`、`createStreamMonitor`、`PartialResponseError`（降级为 `@deprecated` 空壳类）、所有 type alias。**7 个调用点一行不动**。

## 13. 测试策略

### 13.1 单元测试层级

- **`runtime/message-adapter.test.ts`**：`AgentMessage` ↔ AI SDK `ModelMessage` 双向转换，包括 tool call 和 tool result 的合并逻辑
- **`runtime/orchestrator.test.ts`**：mock AI SDK 的 `streamText` / `generateText`（通过 `@ai-sdk/provider` 的 `MockLanguageModelV2`），验证 fallback、salvage、error mapping
- **`quirks/proxy-quirks.test.ts`**：mock 全局 `fetch`，验证请求/响应改写
- **`errors/mapper.test.ts`**：AI SDK `APICallError` / `NoObjectGeneratedError` → 我们的 `LLMError` 分类
- **`providers/*.test.ts`**：每个 provider builder 能正确调用 `resolveLanguageModel` 并构造 runtime
- **`pool/pool.test.ts`** / **`pool/router.test.ts`**：DirectRouter 分派 + Pool register/lookup
- **`compat/legacy-api.test.ts`**：老 API 签名行为不变

### 13.2 关键回归测试（从现有 `provider.test.ts` 迁移）

1. `streamed chat returns no chunks → fallback to sync`
2. `generic 400 不盲目建议 stream: false`
3. `sync fallback 被拒绝（stream must be true）→ 报告正确的 hint`

新增：

4. `tool-calling stream 失败 → 自动 fallback 到 tool-calling sync`
5. `tool-calling stream 中断（>500 字符）→ salvage 到 finishReason: "error_partial"`
6. `openai-custom 默认 fetch 钩子剥离 stream_options.include_usage`
7. `openai-custom fetch 钩子把 content_filter 错误体改写成 OpenAI 格式`

### 13.3 集成测试

保留现有 `packages/core/src/__tests__/provider.test.ts` 的行为断言，切到新 API 后行为应当**等价或更强**。

### 13.4 真实 API Smoke 测试

见 §17。独立的 `pnpm smoke:llm` 入口，不进 CI，开发者本地按需执行。

## 14. 迁移计划（原子 commit 序列）

严格遵守 `CLAUDE.md` 的原子化提交规范。每个 commit 都能独立通过 `pnpm build` 和相关测试。

| # | Commit | 内容 | 验证 |
|---|---|---|---|
| 1 | `chore(deps): add vercel ai sdk and provider packages` | 在 `packages/core/package.json` 加 `ai`、`@ai-sdk/openai`、`@ai-sdk/anthropic`、`@ai-sdk/openai-compatible` 依赖；`pnpm install` | `pnpm build` |
| 2 | `refactor(llm): add types/ module (payload, message)` | `types/payload.ts` + `types/message.ts`（不导出到 index，内部使用）| `pnpm build` |
| 3 | `refactor(llm): add errors/ module with LLMError taxonomy` | 8 个 ErrorType + LLMError 基类 + 默认 mapper（接收 unknown，分类 AI SDK APICallError）| `pnpm build` + 新单测 |
| 4 | `refactor(llm): add quirks/proxy-quirks with fetch wrapper` | `buildProxyFetch(config)` + request/response rewrite | `pnpm build` + quirks 单测 |
| 5 | `refactor(llm): add runtime/resolve-model + message-adapter` | `resolveLanguageModel(config)` 分派四种 AI SDK 工厂 + `adaptMessages/adaptTools/adaptToolCall` | `pnpm build` + adapter 单测 |
| 6 | `refactor(llm): add runtime/orchestrator with streamText + fallback + salvage` | `orchestrate()` + `runStreaming()` + `runSync()` + progress timer | `pnpm build` + orchestrator 单测（mock LanguageModelV2）|
| 7 | `refactor(llm): add runtime/runtime.ts LLMRuntime class + createRuntime` | 薄壳 class + 工厂函数 | `pnpm build` |
| 8 | `refactor(llm): add provider configs and registry` | 4 个 provider builder + `providers/registry.ts` + `providers/defaults.ts` | `pnpm build` + provider 单测 |
| 9 | `refactor(llm): add dispatch/config-builders` | `{match, build}[]` 表 + `resolveProviderId` | `pnpm build` + 单测 |
| 10 | `refactor(llm): add pool/ layer (LLMPool, Router, DirectRouter)` | Layer 3 打桩 | `pnpm build` + 单测 |
| 11 | `refactor(llm): add compat shim (legacy-api)` | 实现 `createLLMClient` / `chatCompletion` / `chatWithTools` / `PartialResponseError` 空壳，但**还不切换** `index.ts` 的导出 | `pnpm build` |
| 12 | `refactor(llm): switch index.ts to export from compat shim, delete provider.ts` | 删除旧 `llm/provider.ts`、`index.ts` 指向 `compat/legacy-api.ts`。**关键原子点**：所有调用点切到新实现。迁移旧测试到新路径 | `pnpm build` + `pnpm test` 全绿 |
| 13 | `test(llm): add proxy quirks regression suite` | 代理怪毛病回归测试（mock fetch 注入的怪响应）| `pnpm test` |
| 14 | `test(llm): add tool-calling hardening tests` | tool-calling fallback + salvage 测试 | `pnpm test` |
| 15 | `test(llm): add real-api smoke runner` | 见 §17，`__smoke__/run.ts` + root `package.json` script | `pnpm build`（smoke 本身不进 CI）|

**分两个 PR 更稳**：
- PR1：commits 1-12（骨架建立 + 切换实现），必须保持行为等价
- PR2：commits 13-15（测试补充 + 硬化回归 + smoke runner）

**commit #12 的爆炸半径控制**：
1. Commit #11 落地后本地手动跑 `pnpm -w build && pnpm -w test && pnpm -C packages/cli dev` 烟雾流程，对比主要 agent 行为
2. Commit #12 落地后立刻再跑同一序列
3. 任一步骤失败 → `git revert 12` 回滚单 commit
4. 成功后再跑一次 smoke（如果凭证已配）对照真实 API 基线

## 15. 风险与未决问题

### 15.1 风险

- **R1：`PartialResponseError` 符号保留**。`packages/core/src/index.ts` 在 re-export 列表里导出了 `PartialResponseError`。自审确认**无生产代码 `instanceof` 它**。**决定**：`errors/types.ts` 提供一个 `class PartialResponseError extends Error`（标注 `@deprecated`），保留在 `index.ts` 的导出列表里；shim 内部不再抛它，直接返回 `ChatResult.finishReason = "error_partial"` 对应的 `LLMResponse.content`。外部观察到的行为：stream 中断抢救继续返回 content，不抛错。

- **R2：AI SDK 版本稳定性**。Vercel AI SDK 从 v3 → v4 → v5 有过破坏性更新。当前主流版本是 v5（Responses API 成为 OpenAI 默认）。**决定**：package.json 锁定到 `^5.0.0`（minor 范围），在 `package.json` 里写注释说明本次重构基于 AI SDK v5。未来 v6 升级作为独立任务处理。

- **R3：`INKOS_LLM_HEADERS` 环境变量行为**。当前 `parseEnvHeaders()` 在 `createLLMClient` 里解析。**决定**：`resolve-model.ts` 的 `sharedOptions.headers` 计算时继续调用 `parseEnvHeaders()`；现有测试断言保持不变。

- **R4：`INKOS_LLM_EXTRA_<key>` 透传**。当前 `config-loader.ts:82` 支持 `INKOS_LLM_EXTRA_<key>=<value>` 把任意参数塞进 `defaults.extra`。AI SDK 的 `streamText`/`generateText` 不接受 `extra` 字段，但支持 `providerOptions` 注入 provider-specific 参数。**决定**：`orchestrator.ts` 里把 `runtime.defaults.extra` 透传为 `providerOptions[providerName]` 字段。测试要覆盖 `INKOS_LLM_EXTRA_thinking_budget=2000` 之类的真实使用路径。

- **R5：关键原子 commit 的爆炸半径**。Commit #12（删 `provider.ts` 并把 `index.ts` 切到 shim + 迁移测试）一次性影响 7 个消费点。**缓解**：commit #11 是"写 shim 但不切换"，让我们能在 commit #11 之后本地手动验证 shim 行为；commit #12 是纯粹的切换 + 测试迁移，失败可以单 revert。

- **R6：`chatWithTools` 签名兼容**。自审确认 `packages/core/src/pipeline/agent.ts:312` 以**位置参数**调用 `chatWithTools(config.client, config.model, messages, TOOLS)`。shim 的 `chatWithTools` 签名必须**逐字节对齐**老签名。

- **R7（新）：真实 API smoke 回归门**。在 commit #12 切换前跑一次 smoke（对照旧代码），把输出 JSON 报告记录下来作为 baseline；commit #12 切换后再跑一次，对照两次报告的每一个路径。行为应当**等价或更强**（tool-calling 的真实代理兼容性从 fail 变为 pass 是允许的）。任何"从 pass 变成 fail"的路径都是回归，必须阻断 merge。

- **R8（新）：AI SDK 对某些 provider 特殊参数的处理**。比如 Anthropic 的 `thinking.budget_tokens`、OpenAI 的 `reasoning_effort`，AI SDK 通过 `providerOptions: { anthropic: { thinking: {...} } }` 传入。现有 `INKOS_LLM_THINKING_BUDGET` 环境变量需要正确映射。**决定**：`resolve-model.ts` 在构造 Anthropic runtime 时把 `config.thinkingBudget` 映射为 `providerOptions.anthropic.thinking.budget_tokens`。OpenAI 的 `reasoning_effort` 通过 `providerOptions.openai.reasoningEffort` 映射（如果 extra 里有）。

### 15.2 已解决的自审问题（初稿阶段 grep 验证完成）

这些问题在 v1 spec 自审阶段已通过 grep 验证，答案不受方向切换影响，直接保留：

- **Q1（已解决）：`_openai` / `_anthropic` 字段的生产访问**。grep 结果：**仅**出现在 `packages/core/src/llm/provider.ts`（要被替换的文件）和 `packages/core/src/__tests__/provider.test.ts`（需要迁移的测试 mock）。**没有任何其他生产代码访问这两个字段**。→ 新 `LLMClient` 类型**可以完全去掉 `_openai?` / `_anthropic?` 字段**。
- **Q2（已解决）：`ChatWithToolsResult.toolCalls` 的可空性**。grep 结果：`packages/core/src/pipeline/agent.ts:318,327,330` 三处都假设必定是数组，从不 null-check。→ 新 `ChatResult.toolCalls` 保持 `ReadonlyArray<ToolCall>`。
- **Q3（已解决）：`OnStreamProgress` 的使用**。grep 结果：`packages/cli/src/utils.ts:69-90`、`packages/studio/src/api/server.ts:99`、`packages/core/src/agents/base.ts`、`packages/core/src/pipeline/runner.ts`——**4 个包、4 处生产使用**。`OnStreamProgress` 类型、`StreamProgress` 类型、`createStreamMonitor` 函数都必须在 `index.ts` 保留导出。
- **Q4（已解决）：`apiFormat === "responses"` 是否有生产使用**。grep 结果：`packages/core/src/models/project.ts:13` 明确定义 `apiFormat: z.enum(["chat", "responses"]).default("chat")`——schema 层面支持。→ `providers/openai-responses.ts` 必须实现。
- **Q5（已解决）：`chatWithTools` 的调用点和签名**。grep 结果：**整个仓库只有一个调用点**——`packages/core/src/pipeline/agent.ts:312`。位置参数调用。→ shim 的 `chatWithTools` 签名必须严格对齐。
- **Q6（已解决）：`PartialResponseError` 的外部 instanceof/import**。grep 结果：**除了 `provider.ts` 自身和 `index.ts` 的 re-export 之外，无任何 import 或 instanceof 检查**。→ 降级为空壳 `@deprecated` 类（R1 已捕获）。

## 16. 成功标准

1. `pnpm build` 全绿
2. `pnpm test` 全绿（老测试迁移后断言不变 + 新测试覆盖 R1-R8 风险）
3. 老 7 个消费点**一行未修改**
4. `packages/core/src/llm/provider.ts` 不存在（被拆分）
5. **新增 inkos 自有代码总行数 ≤800 行**（AI SDK 提供了 SDK 包装，我们只写 orchestrator + 配置 + 路由层）
6. 手工跑一次完整小说生成 pipeline，对比重构前后的 token 使用、耗时、输出一致性
7. 主观：加一个新的 OpenAI 兼容 provider（比如 DeepSeek）只需修改 ≤2 个文件，新增 ≤30 行
8. `pnpm smoke:llm` 对每个配置了 API key 的 runtime 变体全绿（见 §17）

## 17. Smoke 测试矩阵（真实 API 集成）

### 17.1 动机

Mock 单元测试能覆盖我们**能想到的**代理怪毛病；但用户明确说"遇到了相当多的 provider bug"的根源是代理兼容接口的真实行为。因此本次重构附带一个 **smoke 测试 runner**，用真实 API key 对每个 runtime 变体跑一遍核心路径，把真实世界的 quirk 变成**可复现的回归档案**。

smoke 测试**不进 CI**（需要 API key、耗费实际费用），只在开发者本地按需执行：`pnpm smoke:llm`。

### 17.2 环境变量清单

与主配置 `INKOS_LLM_*` 完全隔离，使用 `INKOS_SMOKE_*` 前缀。缺失的变体自动跳过，不报错。

| 变体 | 必需变量 | 示例值 |
|---|---|---|
| **OpenAI 官方 Chat Completions** | `INKOS_SMOKE_OPENAI_API_KEY`<br>`INKOS_SMOKE_OPENAI_BASE_URL`<br>`INKOS_SMOKE_OPENAI_MODEL` | `sk-...`<br>`https://api.openai.com/v1`<br>`gpt-4o-mini` |
| **OpenAI 官方 Responses API** | `INKOS_SMOKE_OPENAI_RESPONSES_API_KEY`<br>`INKOS_SMOKE_OPENAI_RESPONSES_BASE_URL`<br>`INKOS_SMOKE_OPENAI_RESPONSES_MODEL` | 通常和 OPENAI 同 key<br>`https://api.openai.com/v1`<br>`gpt-4o-mini` |
| **Anthropic 官方** | `INKOS_SMOKE_ANTHROPIC_API_KEY`<br>`INKOS_SMOKE_ANTHROPIC_BASE_URL`<br>`INKOS_SMOKE_ANTHROPIC_MODEL` | `sk-ant-...`<br>`https://api.anthropic.com`<br>`claude-3-5-haiku-latest` |
| **OpenAI 兼容代理**（主要 bug 源）| `INKOS_SMOKE_OPENAI_CUSTOM_API_KEY`<br>`INKOS_SMOKE_OPENAI_CUSTOM_BASE_URL`<br>`INKOS_SMOKE_OPENAI_CUSTOM_MODEL`<br>`INKOS_SMOKE_OPENAI_CUSTOM_LABEL`（报告用） | 见下 §18.3 推荐列表 |

`.env.example` 里已添加一整段 commented-out 的 smoke 配置块供开发者参考和填写。

### 17.3 推荐的 OpenAI 兼容代理（用户二选一或多选）

| 服务 | Base URL | 特点 / 为什么值得测 | 大致成本 |
|---|---|---|---|
| **OpenRouter** | `https://openrouter.ai/api/v1` | 单 key 路由到多家模型，**quirks 最多样**，最值得测 | 按所选模型计费 |
| **DeepSeek** | `https://api.deepseek.com/v1` | 极便宜；`deepseek-reasoner` 多轮有 `reasoning_content` quirk | $0.14/1M in |
| **Moonshot (Kimi)** | `https://api.moonshot.cn/v1` | 国内便利，128k 上下文 | 约 ¥12/1M tokens |
| **SiliconFlow** | `https://api.siliconflow.cn/v1` | 国内云，开源模型丰富 | 免费/便宜 |
| **Ollama 本地** | `http://localhost:11434/v1` | **零成本**，验证 localhost 路径，适合 CI 自测 | 免费 |

**强烈建议至少接入 OpenRouter**（或 OpenRouter + 一个国内代理组合），因为 OpenRouter 是用户日常最可能用的代理且它的 quirks 覆盖面最广。

**注**：Vercel AI SDK 官方也维护了一个 `@openrouter/ai-sdk-provider` 包（见 context7 查询结果）。如果后续决定把 OpenRouter 作为一等公民，可以直接替换 `createOpenAICompatible` 为 `createOpenRouter`。本次 smoke 测试使用 `createOpenAICompatible` 即可，目的是验证我们的通用 compat 路径。

### 17.4 每个变体要跑的 6 个核心路径

smoke runner 对每个配置了凭证的 runtime 按顺序执行以下 6 个测试，任一失败都标红但继续跑完其他：

1. **Simple chat 流式**：`runtime.chat({messages, stream: true})`，断言 `content.length > 0`
2. **Simple chat 同步**：同上但 `stream: false`，断言 `usage.totalTokens > 0`
3. **Tool-calling**：注入一个 `echo(text: string) → string` 简单工具，断言 `toolCalls.length > 0` 且 `toolCalls[0].name === "echo"`
4. **Long context**：~4KB 输入（模拟 prompt 前半截），断言 `content.length > 100` 且流式过程中至少触发一次 `onStreamProgress`
5. **AbortSignal 取消**：`setTimeout(() => controller.abort(), 200)`，断言抛出 AbortError 或返回的 content 大小 < 完整响应（允许 salvage）
6. **故意打错模型名**：model 设成 `does-not-exist`，断言捕获到 `LLMError` 且 `error.type === ErrorType.ModelNotFound`

### 17.5 Runner 技术细节

- 实现位置：`packages/core/src/llm/__smoke__/run.ts`（不在 `__tests__` 下避免被 vitest 自动拉起）
- 入口：根 `package.json` 新增 script `"smoke:llm": "tsx packages/core/src/llm/__smoke__/run.ts"`
- 报告：控制台输出表格 + 写 JSON 报告到 `.superpowers/smoke-reports/llm-YYYY-MM-DD-HHMMSS.json`（`.superpowers/smoke-reports/` 不纳入 git，由 `.gitignore` 的 `.superpowers/*` 默认排除覆盖）
- 退出码：全部通过 = 0；任一路径失败 = 1
- 不耗费 > $1：内置 `maxTokens: 200` 硬上限；所有测试文本总量 < 10KB
- 失败输出必须包含：变体 label、路径编号、错误 type、原始错误 message 前 500 字符

### 17.6 Smoke 作为真正的 bug 档案

每次用户报告一个代理 quirk，我们可以：
1. 在 `__smoke__/run.ts` 里加一个复现该 quirk 的路径
2. 在 `quirks/proxy-quirks.ts` 里加一个 `fetch` 钩子修复
3. 跑 `pnpm smoke:llm` 验证修复
4. commit 成一个原子 "quirk fix + regression test" 提交

这把"代理怪毛病 bug"从"难以追踪的运行时现象"升级为"可测试、可回归、可归档"的工程资产。
