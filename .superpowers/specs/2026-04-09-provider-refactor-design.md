# Provider 架构重构设计

**日期**：2026-04-09
**范围**：`packages/core/src/llm/`
**类型**：纯重构 + 行为硬化（不加新 provider、不加新能力）
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
- 用户明确要求**借鉴 LobeHub 和 Cherry Studio 的设计模式**，但**不依赖它们的包**

### 1.4 外部参考的关键发现

**LobeHub `@lobechat/model-runtime`**（80+ provider，自写到底）：
- **双工厂**：`createOpenAICompatibleRuntime` + `createAnthropicCompatibleRuntime`，两类 provider 对称
- 每个 provider 是一个 ~20 行的配置对象
- 可组合的流式 transformer pipeline：`pipeThrough(A).pipeThrough(B).pipeThrough(C)`
- 30+ 个 `AgentRuntimeErrorType` 枚举（对我们过头）

**Cherry Studio**（放弃自写，改用 Vercel AI SDK）：
- **关键历史教训**：早年自写过 `CoreRequest` + 中间件链 + `ApiClient.getRequestTransformer()`，**后来全拆掉了**
- 警告：**"不要发明自己的 Request/Response 类型"**
- `{match, build}[]` 分派表 + `find`，替代所有 `if/else`
- `ProviderExtension.create(config as const satisfies ...)` 的类型推导技巧
- 错误带结构化 `context` + `code` + `cause`

本次重构**借鉴 LobeHub 的双工厂骨架 + Cherry Studio 的分派表和教训**，但**不依赖任何一方的包**。

## 2. 目标与非目标

### 2.1 目标

- **T1**：消灭 1002 行单文件，拆成多个 ≤250 行的单一职责模块
- **T2**：`_openai?` / `_anthropic?` 可选字段消失，类型系统不再需要 `!` 断言
- **T3**：加新 OpenAI 兼容 provider = 新增一个 ~20 行配置文件 + 在 registry 加一行
- **T4**：tool-calling 与 simple chat 共享全部健壮性（fallback、partial salvage、错误包装）
- **T5**：代理怪毛病隔离到对应 provider 文件里的 `handleError` / `handlePayload` 钩子，不污染共享代码
- **T6**：所有 7 个调用点**零修改**（通过兼容 shim 实现）
- **T7**：为未来路由层预留接缝——`LLMPool.chat({ task, ... })` 的 API 形状固定下来
- **T8**：完整测试覆盖，包括代理怪毛病回归档案

### 2.2 非目标

- ❌ **不加新 provider**（不实现 DeepSeek、Moonshot、Gemini、Ollama 等）
- ❌ **不加新能力**（不加 embeddings、TTS、T2I、vision 专属处理）
- ❌ **不依赖 Vercel AI SDK、`@lobechat/model-runtime` 或其他第三方 runtime 库**
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
│  Layer 2: Orchestrator（嵌入 LLMRuntime 抽象类的 chat() 模板方法）│
│  • stream → sync fallback                                      │
│  • partial response salvage                                    │
│  • 默认错误映射（provider 可通过 handleError 覆盖）                │
│  • stream transformer pipeline（progress / salvage / callbacks）│
│  • tool-calling 与 simple chat 共享所有健壮性                    │
└───────────────────────┬───────────────────────────────────────┘
                        │ 调用具体 SDK
                        ▼
┌───────────────────────────────────────────────────────────────┐
│  Layer 1: LLMRuntime（polymorphic subclasses via factories）  │
│                                                                │
│  OpenAI-Compatible Factory                                     │
│  ├── openai.ts          (官方 OpenAI Chat Completions)         │
│  ├── openai-responses.ts(官方 OpenAI Responses API, variant)    │
│  ├── openai-custom.ts   (通用代理默认)                          │
│  └── 未来：deepseek / moonshot / gemini-oai / ollama / ...      │
│                                                                │
│  Anthropic-Compatible Factory                                  │
│  ├── anthropic.ts       (官方 Anthropic Messages)              │
│  └── 未来：bedrock-claude / vertex-claude / ...                 │
└───────────────────────────────────────────────────────────────┘
```

### 3.2 模块布局

```
packages/core/src/llm/
├── index.ts                                # 公共 API（兼容现有导出符号）
│
├── types/
│   ├── payload.ts                          # ChatPayload (薄壳) + RuntimeDefaults
│   ├── result.ts                           # ChatResult + Usage + FinishReason
│   ├── stream-event.ts                     # StreamEvent union + StreamContext
│   └── message.ts                          # LLMMessage, AgentMessage, ToolDefinition, ToolCall
│
├── runtime/
│   ├── interface.ts                        # abstract class LLMRuntime
│   ├── openai-compatible/
│   │   ├── index.ts                        # createOpenAICompatibleRuntime
│   │   ├── default-handle-payload.ts       # ChatPayload → OpenAI.ChatCompletionCreateParams
│   │   ├── default-handle-error.ts         # OpenAI 错误 → LLMError
│   │   ├── default-stream-transform.ts     # OpenAI SSE chunk → StreamEvent
│   │   ├── responses-api.ts                # Responses API variant (chatCompletion.useResponse)
│   │   └── message-adapter.ts              # AgentMessage ↔ OpenAI message
│   ├── anthropic-compatible/
│   │   ├── index.ts                        # createAnthropicCompatibleRuntime
│   │   ├── default-handle-payload.ts       # ChatPayload → Anthropic.MessageCreateParams
│   │   ├── default-handle-error.ts         # Anthropic 错误 → LLMError
│   │   ├── default-stream-transform.ts     # Anthropic SSE event → StreamEvent
│   │   └── message-adapter.ts              # AgentMessage ↔ Anthropic message
│   └── pipeline/
│       ├── progress-monitor.ts             # TransformStream：30s 一次进度回调
│       ├── salvage.ts                      # TransformStream：缓存 chunks，流中断时抢救
│       ├── callbacks.ts                    # TransformStream：触发 onText/onToolCall
│       └── collect.ts                      # 把 StreamEvent[] 折叠成 ChatResult
│
├── providers/
│   ├── openai.ts                           # 10-20 行配置（官方 OpenAI）
│   ├── openai-responses.ts                 # 10-20 行配置（Responses API variant）
│   ├── openai-custom.ts                    # 10-20 行配置（通用代理默认）
│   ├── anthropic.ts                        # 10-20 行配置
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
│   ├── types.ts                            # LLMError 基类 + 8 个子类 + ErrorType 枚举
│   └── default-mapper.ts                   # HTTP 码 → ErrorType 的共享默认映射
│
├── orchestrator/
│   ├── fallback.ts                         # stream → sync 降级策略
│   └── context.ts                          # ErrorContext 构造器
│
└── compat/
    └── legacy-api.ts                       # createLLMClient / chatCompletion / chatWithTools
```

**文件大小预估**：
- `runtime/openai-compatible/index.ts`：~200 行
- `runtime/anthropic-compatible/index.ts`：~180 行
- 所有其他文件：≤150 行
- 总代码量预估 ~1500 行（分散在 ~25 个文件）

## 4. 核心类型契约

### 4.1 `ChatPayload`（公共入口的薄载荷）

```ts
// types/payload.ts
export interface ChatPayload {
  readonly model: string;                           // wire-level 模型 id
  readonly messages: ReadonlyArray<LLMMessage>;
  readonly stream?: boolean;                        // 默认继承 runtime.defaults.stream
  readonly temperature?: number;
  readonly maxTokens?: number;
  readonly tools?: ReadonlyArray<ToolDefinition>;   // 有 → tool-calling，无 → simple chat
  readonly toolChoice?: "auto" | "none" | "required" | { name: string };
  readonly webSearch?: boolean;
  readonly thinkingBudget?: number;                 // Anthropic 专用；OpenAI 忽略
  readonly onStreamProgress?: OnStreamProgress;
  readonly signal?: AbortSignal;                    // 第一类公民，贯穿所有 pipeline
}
```

**设计决定**：
- `tools` 是基础 payload 的一部分 → **tool-calling 和 simple chat 合并为同一个入口**。Runtime 根据 `tools` 是否存在决定是否注入 tools 参数。从源头终结"tool-calling 不享受 fallback"的问题。
- `signal: AbortSignal` 是一等公民 → 未来 pipeline 能直接传 signal 取消长流
- 公共入口的字段**保持极简**，provider 特有字段（`reasoning_effort`、`enabledSearch`、`enabledContextCaching`...）都在 `provider.defaults.extra` 里，由 provider 自己的 `handlePayload` 消费

### 4.2 `ChatResult`

```ts
// types/result.ts
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

### 4.3 `StreamEvent` 和 `StreamContext`

```ts
// types/stream-event.ts
export type StreamEvent =
  | { readonly type: "text"; readonly delta: string }
  | { readonly type: "tool_call_start"; readonly index: number; readonly id: string; readonly name: string }
  | { readonly type: "tool_call_delta"; readonly index: number; readonly argumentsChunk: string }
  | { readonly type: "tool_call_done"; readonly index: number }
  | { readonly type: "thinking"; readonly delta: string }
  | { readonly type: "usage"; readonly usage: Usage }
  | { readonly type: "done"; readonly finishReason: FinishReason }
  | { readonly type: "error"; readonly error: LLMError };

export interface StreamContext {
  chunkIndex: number;
  inputStartAt: number;
  toolCalls: Map<number, { id: string; name: string; arguments: string }>;
  contentBuffer: string;
  usage: Usage;
}
```

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

**设计决定**：
- **8 个错误类型**对齐 HTTP 语义 + 2 个流式专用（`StreamInterrupted`、`ConnectionError`）
- 不为每个 provider 创建专用错误类型（LobeHub 30+ 个 errorType 对我们过头）
- `context.partialContent` 替代 `PartialResponseError`——语义并入 `StreamInterrupted + finishReason: "error_partial"`
- `hint` 字段放当前 `wrapLLMError` 里的中文建议，保持用户可见的 DX

## 5. `LLMRuntime` 抽象类（核心契约）

```ts
// runtime/interface.ts
export abstract class LLMRuntime {
  abstract readonly id: string;
  abstract readonly baseUrl: string;
  abstract readonly defaults: RuntimeDefaults;

  /**
   * 公共入口 —— 模板方法，子类不应重写。
   * 所有健壮性（fallback、salvage、错误包装、progress）都在这里生效。
   */
  async chat(payload: ChatPayload): Promise<ChatResult> {
    const ctx = buildErrorContext(this, payload);
    try {
      if (payload.stream ?? this.defaults.stream) {
        return await this.runStreaming(payload, ctx);
      }
      return await this.chatSync(payload);
    } catch (err) {
      return await handleChatError(this, payload, err, ctx);
    }
  }

  /** 子类实现：流式原语 */
  protected abstract chatStream(payload: ChatPayload): ReadableStream<StreamEvent>;

  /** 子类实现：同步原语（也是 stream 失败时 fallback 的目标） */
  protected abstract chatSync(payload: ChatPayload): Promise<ChatResult>;

  /** 子类可选覆盖：错误映射（handleError 钩子入口） */
  mapError(error: unknown, ctx: ErrorContext): LLMError {
    return defaultErrorMapper(error, ctx);
  }

  /** chat() 内部使用：运行流式 + pipeline + collect */
  private async runStreaming(payload: ChatPayload, ctx: ErrorContext): Promise<ChatResult> {
    const rawStream = this.chatStream(payload);
    const piped = rawStream
      .pipeThrough(createProgressMonitor(payload.onStreamProgress))
      .pipeThrough(createSalvageBuffer())
      .pipeThrough(createCallbacksTransformer(payload));
    return await collectStream(piped, ctx);
  }
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

**注**：本 spec 中出现的 `RuntimeConfig` 类型**就是现有的 `LLMConfig`**（`packages/core/src/models/project.ts`）。我们不引入新的配置类型，直接复用；factory 的构造函数签名是 `new (config: LLMConfig) => LLMRuntime`。

**设计决定**：
- **抽象类 + 模板方法**：`chat()` 是 final（TypeScript 没有 `final` 关键字，但约定子类不重写），子类只实现 `chatStream` / `chatSync` 两个原语。子类**无法跳过**健壮性编排。
- 流式管道使用 **Web Streams API** (`ReadableStream` / `TransformStream`)，Node 18+ 原生支持。比 `AsyncIterable` 更可组合。
- **tool-calling 和 simple chat 共用 `chat()`**。Runtime 内部看 `payload.tools` 决定是否注入 tools 参数。下游 `collectStream` 会把 `tool_call_*` 事件折叠进 `ChatResult.toolCalls`。

## 6. OpenAI 兼容工厂

### 6.1 工厂签名

```ts
// runtime/openai-compatible/index.ts
export interface OpenAICompatibleFactoryOptions {
  readonly id: string;
  readonly apiFormat?: "chat" | "responses";
  readonly debug?: {
    readonly chatCompletion?: () => boolean;
  };
  readonly chatCompletion?: {
    /** 定制请求体：ChatPayload → OpenAI SDK 原生类型。返回 undefined 使用默认。 */
    readonly handlePayload?: (
      payload: ChatPayload,
      options: OpenAICompatibleContext,
    ) => OpenAI.ChatCompletionCreateParams | undefined;

    /** 定制错误映射。返回 null 则继续用默认映射。 */
    readonly handleError?: (
      error: unknown,
      ctx: ErrorContext,
    ) => LLMError | null;

    /**
     * 定制流 transformer。替换默认 SSE chunk → StreamEvent 转换。
     * 接收 OpenAI SDK 的 stream，返回 StreamEvent 流。
     */
    readonly handleStream?: (
      sdkStream: ReadableStream<OpenAI.ChatCompletionChunk>,
    ) => ReadableStream<StreamEvent>;

    /** 跳过 stream_options.include_usage（某些代理不接受） */
    readonly excludeUsage?: boolean;

    /** 强制使用 Responses API，不管 apiFormat */
    readonly useResponse?: boolean;

    /** 正则匹配的模型走 Responses API */
    readonly useResponseModels?: ReadonlyArray<string | RegExp>;
  };
  readonly defaultHeaders?: Record<string, string>;
}

export interface OpenAICompatibleContext {
  readonly client: OpenAI;
  readonly config: RuntimeConfig;
  readonly defaults: RuntimeDefaults;
}

export function createOpenAICompatibleRuntime(
  options: OpenAICompatibleFactoryOptions,
): new (config: RuntimeConfig) => LLMRuntime;
```

### 6.2 默认行为

工厂生成的 runtime 类内部流程：

```ts
// chatStream 伪码
protected chatStream(payload: ChatPayload): ReadableStream<StreamEvent> {
  const ctx = { client: this.client, config: this.config, defaults: this.defaults };
  const sdkPayload =
    options.chatCompletion?.handlePayload?.(payload, ctx)
    ?? defaultHandlePayload(payload, ctx);  // ChatPayload → OpenAI params

  const sdkStream = this.client.chat.completions.create(sdkPayload, {
    headers: { Accept: "*/*", ...(options.defaultHeaders ?? {}) },
    signal: payload.signal,
  });

  const transform = options.chatCompletion?.handleStream
    ?? defaultStreamTransform;

  return transform(sdkStream as ReadableStream<OpenAI.ChatCompletionChunk>);
}

// chatSync 伪码
protected async chatSync(payload: ChatPayload): Promise<ChatResult> {
  const ctx = { client: this.client, config: this.config, defaults: this.defaults };
  const sdkPayload = {
    ...(options.chatCompletion?.handlePayload?.(payload, ctx) ?? defaultHandlePayload(payload, ctx)),
    stream: false,
  };
  const response = await this.client.chat.completions.create(sdkPayload);
  return syncResponseToChatResult(response);
}

// mapError 伪码
mapError(error: unknown, ctx: ErrorContext): LLMError {
  const custom = options.chatCompletion?.handleError?.(error, ctx);
  if (custom) return custom;
  return defaultErrorMapper(error, ctx);
}
```

### 6.3 典型 provider 配置文件示例

**官方 OpenAI**：

```ts
// providers/openai.ts
import { createOpenAICompatibleRuntime } from "../runtime/openai-compatible/index.js";

export const OpenAIRuntime = createOpenAICompatibleRuntime({
  id: "openai",
  apiFormat: "chat",
  debug: { chatCompletion: () => process.env.INKOS_DEBUG_OPENAI_CHAT === "1" },
});
```

**OpenAI Responses API**（variant）：

```ts
// providers/openai-responses.ts
import { createOpenAICompatibleRuntime } from "../runtime/openai-compatible/index.js";

export const OpenAIResponsesRuntime = createOpenAICompatibleRuntime({
  id: "openai-responses",
  apiFormat: "responses",
  chatCompletion: {
    useResponse: true,
  },
});
```

**通用代理**（当前大量 bug 的来源）：

```ts
// providers/openai-custom.ts
import { createOpenAICompatibleRuntime } from "../runtime/openai-compatible/index.js";
import { ErrorType, LLMError } from "../errors/types.js";

export const OpenAICustomRuntime = createOpenAICompatibleRuntime({
  id: "openai-custom",
  apiFormat: "chat",
  chatCompletion: {
    excludeUsage: true,  // 默认跳过，某些代理不接受 stream_options
    handleError: (err, ctx) => {
      const msg = String(err);
      // 代理特有：内容审查误报
      if (msg.includes("content_filter") || (msg.includes("403") && msg.includes("sensitive"))) {
        return new LLMError(ErrorType.PermissionDenied, "代理拦截了内容", {
          ...ctx,
          hint: "公益/免费 API 常见，建议换不限制内容的提供方",
        });
      }
      return null; // 交还默认
    },
  },
});
```

## 7. Anthropic 兼容工厂

与 OpenAI 兼容工厂对称：

```ts
// runtime/anthropic-compatible/index.ts
export interface AnthropicCompatibleFactoryOptions {
  readonly id: string;
  readonly debug?: { readonly chatCompletion?: () => boolean };
  readonly chatCompletion?: {
    readonly handlePayload?: (
      payload: ChatPayload,
      options: AnthropicCompatibleContext,
    ) => Anthropic.MessageCreateParams | undefined;
    readonly handleError?: (error: unknown, ctx: ErrorContext) => LLMError | null;
    readonly handleStream?: (
      sdkStream: AsyncIterable<Anthropic.MessageStreamEvent>,
    ) => ReadableStream<StreamEvent>;
  };
  readonly defaultHeaders?: Record<string, string>;
}

export function createAnthropicCompatibleRuntime(
  options: AnthropicCompatibleFactoryOptions,
): new (config: RuntimeConfig) => LLMRuntime;
```

**配置文件**：

```ts
// providers/anthropic.ts
import { createAnthropicCompatibleRuntime } from "../runtime/anthropic-compatible/index.js";

export const AnthropicRuntime = createAnthropicCompatibleRuntime({
  id: "anthropic",
  debug: { chatCompletion: () => process.env.INKOS_DEBUG_ANTHROPIC === "1" },
});
```

原本 150+ 行的 Anthropic bespoke 实现，被压缩到**工厂内部共享**。Anthropic 本体的 provider 文件只有 ~10 行。

## 8. Stream Transformer Pipeline

所有流式处理通过 Web Streams `TransformStream` 组合，串联在 `LLMRuntime.runStreaming` 里：

```
raw ReadableStream<StreamEvent>  (from chatStream)
  → pipeThrough(createProgressMonitor)     # 30s 一次进度回调
  → pipeThrough(createSalvageBuffer)       # 缓存 chunks，流中断时抢救
  → pipeThrough(createCallbacksTransformer)# 触发 onText / onToolCall
  → collectStream(piped)                   # 折叠成 ChatResult
```

### 8.1 `createSalvageBuffer`

```ts
// runtime/pipeline/salvage.ts
const MIN_SALVAGEABLE_CHARS = 500;

export function createSalvageBuffer(): TransformStream<StreamEvent, StreamEvent> {
  let buffered = "";
  return new TransformStream({
    transform(event, controller) {
      if (event.type === "text") buffered += event.delta;
      controller.enqueue(event);
    },
    flush(controller) {
      // 正常结束不做任何事；中断由上层 catch 处理并读取 context.partialContent
    },
  });
}
```

中断抢救的入口在 `orchestrator/fallback.ts` 的 `handleChatError`：如果捕获到流错误且已缓存 `>= MIN_SALVAGEABLE_CHARS`，返回 `ChatResult { content: buffered, finishReason: "error_partial" }`。

### 8.2 `createProgressMonitor`

对齐当前 `createStreamMonitor` 语义（30s 一次进度回调）。实现为独立 `TransformStream`，保留现有行为。

## 9. Provider Registry 和 Variant 机制

```ts
// providers/registry.ts
import { OpenAIRuntime } from "./openai.js";
import { OpenAIResponsesRuntime } from "./openai-responses.js";
import { OpenAICustomRuntime } from "./openai-custom.js";
import { AnthropicRuntime } from "./anthropic.js";

export const providerRegistry = {
  "openai": OpenAIRuntime,
  "openai-responses": OpenAIResponsesRuntime,
  "openai-custom": OpenAICustomRuntime,
  "anthropic": AnthropicRuntime,
} as const;

export type ProviderId = keyof typeof providerRegistry;
```

**Variant 机制**：`openai` 和 `openai-responses` 是同一个 OpenAI 工厂的两个变体。未来加 `gemini-openai`、`deepseek` 时，它们也都是 `createOpenAICompatibleRuntime` 的变体。

## 10. Dispatch 表（从 LLMConfig 选择 provider）

```ts
// dispatch/config-builders.ts
interface ConfigBuilder {
  readonly match: (config: LLMConfig) => boolean;
  readonly providerId: ProviderId;
}

export const configBuilders: ReadonlyArray<ConfigBuilder> = [
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

替代当前 `createLLMClient` 里的 `if (config.provider === "anthropic") ... else ...` 分支。加 provider 只需要在数组加一项。

## 11. Pool + Router（Layer 3 打桩）

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
export class LLMPool {
  private readonly runtimes = new Map<string, LLMRuntime>();

  constructor(private readonly router: Router) {}

  register(alias: string, runtime: LLMRuntime): void {
    this.runtimes.set(alias, runtime);
  }

  async chat(req: ChatPayload & { task?: TaskIntent; alias?: string }): Promise<ChatResult> {
    const alias = this.router.route(req.task, req.alias);
    const runtime = this.runtimes.get(alias);
    if (!runtime) {
      throw new Error(`No runtime registered for alias "${alias}"`);
    }
    return runtime.chat(req);
  }
}
```

**未来扩展路径**：`CapabilityRouter`（按声明式模型能力表打分）、`CostRouter`（按成本优先）、`FallbackRouter`（失败降级到下一个 runtime）。本次均不实现。

## 12. 向后兼容 Shim

```ts
// compat/legacy-api.ts
import { LLMPool } from "../pool/pool.js";
import { DirectRouter } from "../pool/router.js";
import { providerRegistry } from "../providers/registry.js";
import { resolveProviderId } from "../dispatch/config-builders.js";
import { parseEnvHeaders } from "./env-headers.js"; // 从老 provider.ts 迁移

/** 老接口：保持符号、保持签名。内部转成 Pool + DirectRouter。 */
export function createLLMClient(config: LLMConfig): LLMClient {
  const providerId = resolveProviderId(config);
  const RuntimeClass = providerRegistry[providerId];
  const mergedHeaders = config.headers ?? parseEnvHeaders(); // 保留 INKOS_LLM_HEADERS 行为
  const runtime = new RuntimeClass({ ...config, headers: mergedHeaders });
  const pool = new LLMPool(new DirectRouter(new Map(), "default"));
  pool.register("default", runtime);
  // 注意：不再包含 _openai / _anthropic 字段（自审确认无生产消费）
  return { _pool: pool, provider: config.provider, defaults: runtime.defaults };
}

export async function chatCompletion(
  client: LLMClient,
  model: string,
  messages: ReadonlyArray<LLMMessage>,
  options?: { temperature?: number; maxTokens?: number; webSearch?: boolean; onStreamProgress?: OnStreamProgress },
): Promise<LLMResponse> {
  const result = await client._pool.chat({
    model,
    messages,
    ...options,
  });
  return {
    content: result.content,
    usage: result.usage,
  };
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
    messages: adaptAgentMessages(messages),  // AgentMessage → LLMMessage
    tools,
    ...options,
  });
  return {
    content: result.content,
    toolCalls: result.toolCalls,
  };
}
```

**导出符号对齐**：`index.ts` 重新导出 `createLLMClient`、`chatCompletion`、`chatWithTools`、`createStreamMonitor`、`PartialResponseError`（继续存在但内部转换）、`type LLMClient` / `LLMResponse` / `LLMMessage` / `ToolDefinition` / `ToolCall` / `AgentMessage` / `ChatWithToolsResult` / `StreamProgress` / `OnStreamProgress`。**7 个调用点一行不动**。

## 13. 代理怪毛病沉淀

代理 bug 是用户明确的主要痛点。本次重构给它们一个正式的家：

1. **通用代理默认**：`providers/openai-custom.ts` 的 `excludeUsage: true`、`handleError` 里处理内容审查误报
2. **每个代理一份小档案**：如果用户报告某个特定代理有独特的 bug（比如"某代理只接受 stream=true"），在 `providers/` 下新建一个文件 `openai-<quirk-name>.ts`，在它的 `handlePayload` / `handleError` 里打补丁。这个文件是**可测试的回归档案**。
3. **测试**：`runtime/openai-compatible/__tests__/` 下按 provider 写回归测试，mock SDK 注入怪毛病响应，验证钩子按预期工作。

## 14. 测试策略

### 14.1 单元测试层级

- **`runtime/pipeline/*.test.ts`**：TransformStream 单独可测（progress monitor、salvage、callbacks）
- **`runtime/openai-compatible/index.test.ts`**：mock `OpenAI` SDK，验证工厂生成的 runtime 在各种 payload 下调用 SDK 的参数正确
- **`runtime/anthropic-compatible/index.test.ts`**：同上
- **`providers/<name>.test.ts`**：每个 provider 的 `handleError` / `handlePayload` 钩子行为（代理怪毛病回归档案）
- **`orchestrator/fallback.test.ts`**：stream → sync 降级路径
- **`pool/pool.test.ts`** / **`pool/router.test.ts`**：DirectRouter 分派
- **`compat/legacy-api.test.ts`**：老 API 签名行为不变

### 14.2 关键回归测试（从现有 `provider.test.ts` 迁移）

1. `streamed chat returns no chunks → fallback to sync`
2. `generic 400 不盲目建议 stream: false`
3. `sync fallback 被拒绝（stream must be true）→ 报告正确的 hint`

新增：

4. `tool-calling stream 失败 → 自动 fallback 到 tool-calling sync`
5. `tool-calling stream 中断（>500 字符）→ salvage 到 finishReason: "error_partial"`
6. `openai-custom 默认跳过 stream_options.include_usage`
7. `openai-custom handleError 把 content_filter 映射为 PermissionDenied`

### 14.3 集成测试

保留现有 `packages/core/src/__tests__/provider.test.ts` 的行为断言，切到新 API 后行为应当**等价或更强**。

## 15. 迁移计划（原子 commit 序列）

严格遵守 `CLAUDE.md` 的原子化提交规范。每个 commit 都能独立通过 `pnpm build` 和相关测试。

| # | Commit | 内容 | 验证 |
|---|---|---|---|
| 1 | `refactor(llm): add types/ module (payload, result, stream-event, message)` | 新增 `types/` 下的所有类型定义，`index.ts` 暂不导出 | `pnpm build` |
| 2 | `refactor(llm): add errors/ module with LLMError taxonomy` | 8 个 ErrorType + LLMError 基类 + defaultErrorMapper | `pnpm build` + 新单测 |
| 3 | `refactor(llm): add runtime/pipeline transformers` | progress monitor / salvage / callbacks / collect | `pnpm build` + pipeline 单测 |
| 4 | `refactor(llm): add LLMRuntime abstract class` | `runtime/interface.ts` + orchestrator/{fallback,context}.ts | `pnpm build` |
| 5 | `refactor(llm): add createOpenAICompatibleRuntime factory` | 工厂 + default-handle-payload/error/stream + message-adapter | `pnpm build` + 工厂单测 |
| 6 | `refactor(llm): add createAnthropicCompatibleRuntime factory` | 同上对 Anthropic | `pnpm build` + 工厂单测 |
| 7 | `refactor(llm): add provider configs (openai/openai-responses/openai-custom/anthropic)` | 4 个配置文件 + registry | `pnpm build` + provider 单测 |
| 8 | `refactor(llm): add dispatch/config-builders` | `{match, build}[]` 表 + `resolveProviderId` | `pnpm build` + 单测 |
| 9 | `refactor(llm): add pool/ layer (LLMPool, Router, DirectRouter)` | Layer 3 打桩 | `pnpm build` + 单测 |
| 10 | `refactor(llm): wire new runtime behind legacy API via compat shim` | 在 `compat/legacy-api.ts` 里实现老函数，**但还不切换** `index.ts` 的导出 | `pnpm build` |
| 11 | `refactor(llm): switch index.ts to export from compat shim` | 删除旧 `provider.ts`，`index.ts` 指向 `compat/legacy-api.ts`。**关键原子点**：这一步让所有调用点切到新实现 | `pnpm build` + `pnpm test` 全绿 |
| 12 | `test(llm): migrate provider.test.ts to new module paths` | 原有 3 个测试迁移到新路径，行为断言不变 | `pnpm test` 全绿 |
| 13 | `test(llm): add proxy quirks regression suite` | 新增代理怪毛病回归测试（`openai-custom.test.ts`） | `pnpm test` |
| 14 | `test(llm): add tool-calling hardening tests` | 新增 tool-calling fallback + salvage 测试 | `pnpm test` |

**分两个 PR 更稳**：
- PR1：commits 1-11（骨架建立 + 切换实现），必须保持行为等价
- PR2：commits 12-14（测试补充 + 硬化回归）

## 16. 风险与未决问题

### 16.1 风险

- **R1：`PartialResponseError` 符号保留**。spec 自审阶段已确认（见下 Q1）：**没有任何生产代码 `import` 或 `instanceof` 它**；它只是在 `packages/core/src/index.ts` 的 re-export 列表里。**决定**：`errors/types.ts` 提供一个 `class PartialResponseError extends Error` 的**空壳兼容类**（标注 `@deprecated`），保留在 `index.ts` 的导出列表里以保证 type + runtime 符号兼容；新 API 使用 `ChatResult.finishReason === "error_partial"` 表达 salvage 结果；兼容 shim 里 `chatCompletion` 的返回值不再抛此 error，而是把 salvage 的 content 作为正常 `LLMResponse` 返回（因为原老代码在 `chatCompletion` 内部已经 catch `PartialResponseError` 并返回 `{content, usage:{0,0,0}}`，见老 `provider.ts:298-304`）。外部观察到的行为：**stream 中断抢救的调用路径继续返回 content，不抛错**。
- **R2：Web Streams API 在 Node 18 下的可用性**。`ReadableStream` / `TransformStream` / `pipeThrough` 在 Node 18 标准库已原生可用。OpenAI SDK 的 `Stream` 对象是 `AsyncIterable`，不是 `ReadableStream`。**决定**：在 `runtime/openai-compatible/` 下提供一个内部工具 `asyncIterableToReadableStream(iter)`（~15 行），在 `chatStream` 开头转换。在 commit 5 开始前写一个 10 行 POC 验证 `OpenAI.Stream` → `ReadableStream<OpenAI.ChatCompletionChunk>` → `for await` 能正确消费。
- **R3：`INKOS_LLM_HEADERS` 环境变量行为**。当前 `parseEnvHeaders()` 在 `createLLMClient` 里解析（支持 JSON 对象或 `Key: Value` 字符串）。**决定**：`compat/legacy-api.ts` 的 `createLLMClient` 继续调用原 `parseEnvHeaders()` 并把结果传入 `OpenAICompatibleFactoryOptions.defaultHeaders`；现有测试断言保持不变。
- **R4：`stripReservedKeys` 行为**。当前代码有 `RESERVED_KEYS = ["max_tokens","temperature","model","messages","stream"]` 防止 `defaults.extra` 覆盖核心参数。**决定**：在 `runtime/openai-compatible/default-handle-payload.ts` 和 `runtime/anthropic-compatible/default-handle-payload.ts` 里各自保留一份 `stripReservedKeys`（两者 reserved keys 集合不同：Anthropic 多 `system`、少 `max_tokens` 的替代 key）。
- **R5：关键原子 commit 的爆炸半径**。Commit #11（删 `provider.ts` 并把 `index.ts` 切到 shim）一次性影响 7 个消费点。**缓解**：在 commit #10 完成后，先本地手动跑一次 `pnpm -w build && pnpm -w test && pnpm -C packages/cli dev` 的烟雾流程；在 commit #11 落地后立即再跑一次相同序列确认 0 退化。若失败，commit #11 的变更是单文件删除 + `index.ts` 一行切换，`git revert` 成本最小。
- **R6：`chatWithTools` 签名兼容**。自审确认 `packages/core/src/pipeline/agent.ts:312` 以**位置参数**调用 `chatWithTools(config.client, config.model, messages, TOOLS)`。shim 的 `chatWithTools` 函数签名必须**逐字节对齐**老签名（四个位置参数 + 可选 options 对象），否则会编译失败。

### 16.2 已解决的原开放问题（自审阶段 grep 验证完成）

自审阶段在当前 spec 草稿之上运行了 grep，记录结果以便 writing-plans 直接进入实施，不再重复验证：

- **Q1（已解决）：`_openai` / `_anthropic` 字段的生产访问**。grep `_openai\b|_anthropic\b` 结果：**仅**出现在 `packages/core/src/llm/provider.ts`（要被替换的文件）和 `packages/core/src/__tests__/provider.test.ts`（需要迁移的测试 mock）。**没有任何其他生产代码访问这两个字段**。→ 新 `LLMClient` 类型**可以完全去掉 `_openai?` / `_anthropic?` 字段**；兼容 shim 返回的 `LLMClient` 对象只需包含 `provider`、`defaults`、`_pool` 三个字段。测试迁移在 commit #12。
- **Q2（已解决）：`ChatWithToolsResult.toolCalls` 的可空性**。grep `\.toolCalls` 结果：`packages/core/src/pipeline/agent.ts:318,327,330` 分别用 `result.toolCalls.length > 0`、`result.toolCalls.length === 0`、`for (const toolCall of result.toolCalls)`——**三处都假设必定是数组，从不 null-check**。→ 新 `ChatResult.toolCalls` 保持 `ReadonlyArray<ToolCall>`（空数组代替 undefined），与现有消费对齐。
- **Q3（已解决）：`OnStreamProgress` 的使用**。grep 结果：
  - `packages/cli/src/utils.ts:69-90`（CLI 的进度日志 hook）
  - `packages/studio/src/api/server.ts:99`（studio HTTP 服务的 SSE 转发）
  - `packages/core/src/agents/base.ts:1,12,32,50`（BaseAgent 的 ctx 透传）
  - `packages/core/src/pipeline/runner.ts:1,72,353,412`（runner 层传递）
  → **4 个包、4 处生产使用**。`OnStreamProgress` 类型、`StreamProgress` 类型、`createStreamMonitor` 函数都必须在 `index.ts` 保留导出；兼容 shim 和新 API 都必须正确转发 `onStreamProgress` 回调。
- **Q4（已解决）：`apiFormat === "responses"` 是否有生产使用**。grep 结果：`packages/core/src/models/project.ts:13` 明确定义 `apiFormat: z.enum(["chat", "responses"]).default("chat")`——**schema 层面支持，是用户可配置字段**。→ `openai-responses.ts` provider 配置文件在本次重构中**必须实现**，不能省略。测试要覆盖 `apiFormat: "responses"` 路径。
- **Q5（已解决）：`chatWithTools` 的调用点和签名**。grep 结果：**整个仓库只有一个调用点**——`packages/core/src/pipeline/agent.ts:312` 的 `chatWithTools(config.client, config.model, messages, TOOLS)`。位置参数调用。→ shim 的 `chatWithTools` 签名必须是 `(client, model, messages, tools, options?)` 严格对齐（R6 已捕获）。
- **Q6（已解决）：`PartialResponseError` 的外部 instanceof/import**。grep 结果：**除了 `provider.ts` 自身和 `index.ts` 的 re-export 之外，无任何 import 或 instanceof 检查**。→ 可以降级为空壳 `@deprecated` 类（R1 已捕获）。

## 17. 成功标准

1. `pnpm build` 全绿
2. `pnpm test` 全绿（老测试不动、新测试覆盖 R1-R5 风险）
3. 老 7 个消费点**一行未修改**
4. `packages/core/src/llm/provider.ts` 不存在（被拆分）
5. 新增文件总行数 ≤1800 行（单文件 ≤250 行）
6. 手工跑一次完整小说生成 pipeline，对比重构前后的 token 使用、耗时、输出一致性
7. 主观：加一个新的 fake provider（比如 mock 一个带怪毛病的 OpenAI 兼容端点）只需修改 ≤2 个文件
