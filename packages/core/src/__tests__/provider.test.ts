import { beforeEach, describe, expect, it, vi } from "vitest";
import type OpenAI from "openai";
import {
  __resetFixedTemperatureWarnings,
  chatCompletion,
  type LLMClient,
} from "../llm/provider.js";

const ZERO_USAGE = {
  prompt_tokens: 11,
  completion_tokens: 7,
  total_tokens: 18,
} as const;

async function captureError(task: Promise<unknown>): Promise<Error> {
  try {
    await task;
  } catch (error) {
    return error as Error;
  }
  throw new Error("Expected promise to reject");
}

describe("chatCompletion stream fallback", () => {
  it("falls back to sync chat completion when streamed chat returns no chunks", async () => {
    const create = vi.fn()
      .mockResolvedValueOnce({
        async *[Symbol.asyncIterator](): AsyncIterableIterator<unknown> {
          return;
        },
      })
      .mockResolvedValueOnce({
        choices: [{ message: { content: "fallback content" } }],
        usage: ZERO_USAGE,
      });

    const client: LLMClient = {
      provider: "openai",
      apiFormat: "chat",
      stream: true,
      _openai: {
        chat: {
          completions: {
            create,
          },
        },
      } as unknown as OpenAI,
      defaults: {
        temperature: 0.7,
        maxTokens: 512,
        thinkingBudget: 0, maxTokensCap: null,
        extra: {},
      },
    };

    const result = await chatCompletion(client, "test-model", [
      { role: "user", content: "ping" },
    ]);

    expect(result.content).toBe("fallback content");
    expect(result.usage).toEqual({
      promptTokens: 11,
      completionTokens: 7,
      totalTokens: 18,
    });
    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls[0]?.[0]).toMatchObject({ stream: true });
    expect(create.mock.calls[1]?.[0]).toMatchObject({ stream: false });
  });

  it("does not blindly suggest stream false for generic 400 errors", async () => {
    const create = vi.fn().mockRejectedValue(new Error("400 Bad Request"));

    const client: LLMClient = {
      provider: "openai",
      apiFormat: "chat",
      stream: false,
      _openai: {
        chat: {
          completions: {
            create,
          },
        },
      } as unknown as OpenAI,
      defaults: {
        temperature: 0.7,
        maxTokens: 512,
        thinkingBudget: 0, maxTokensCap: null,
        extra: {},
      },
    };

    const error = await captureError(chatCompletion(client, "test-model", [
      { role: "user", content: "ping" },
    ]));

    expect(error.message).toContain("API 返回 400");
    expect(error.message).not.toContain("\"stream\": false");
    expect(error.message).toContain("检查提供方文档");
  });

  it("reports when sync fallback is rejected because provider requires streaming", async () => {
    const create = vi.fn()
      .mockResolvedValueOnce({
        async *[Symbol.asyncIterator](): AsyncIterableIterator<unknown> {
          return;
        },
      })
      .mockRejectedValueOnce(new Error("400 {\"detail\":\"Stream must be set to true\"}"));

    const client: LLMClient = {
      provider: "openai",
      apiFormat: "chat",
      stream: true,
      _openai: {
        chat: {
          completions: {
            create,
          },
        },
      } as unknown as OpenAI,
      defaults: {
        temperature: 0.7,
        maxTokens: 512,
        thinkingBudget: 0, maxTokensCap: null,
        extra: {},
      },
    };

    const error = await captureError(chatCompletion(client, "test-model", [
      { role: "user", content: "ping" },
    ]));

    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls[0]?.[0]).toMatchObject({ stream: true });
    expect(create.mock.calls[1]?.[0]).toMatchObject({ stream: false });
    expect(error.message).toContain("stream:true");
    expect(error.message).not.toContain("\"stream\": false");
  });
});

describe("chatCompletion fixed-temperature clamp (thinking models)", () => {
  beforeEach(() => {
    __resetFixedTemperatureWarnings();
  });

  function makeSyncClient(create: ReturnType<typeof vi.fn>, temperature: number): LLMClient {
    return {
      provider: "openai",
      apiFormat: "chat",
      stream: false,
      _openai: {
        chat: { completions: { create } },
      } as unknown as OpenAI,
      defaults: {
        temperature,
        maxTokens: 512,
        thinkingBudget: 0,
        maxTokensCap: null,
        extra: {},
      },
    };
  }

  const OK_RESPONSE = {
    choices: [{ message: { content: "ok" } }],
    usage: ZERO_USAGE,
  };

  it("forces temperature=1 for kimi-k2.5 even when client default is 0.7", async () => {
    const create = vi.fn().mockResolvedValue(OK_RESPONSE);
    const client = makeSyncClient(create, 0.7);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await chatCompletion(client, "kimi-k2.5", [{ role: "user", content: "hi" }]);

    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0]?.[0]).toMatchObject({ temperature: 1 });
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]?.[0]).toContain("kimi-k2.5");
    warn.mockRestore();
  });

  it("clamps per-call temperature override (0.3) to 1 for kimi-k2.5", async () => {
    const create = vi.fn().mockResolvedValue(OK_RESPONSE);
    const client = makeSyncClient(create, 0.7);
    vi.spyOn(console, "warn").mockImplementation(() => {});

    await chatCompletion(
      client,
      "kimi-k2.5",
      [{ role: "user", content: "hi" }],
      { temperature: 0.3 },
    );

    expect(create.mock.calls[0]?.[0]).toMatchObject({ temperature: 1 });
  });

  it("only warns once per model name across multiple calls", async () => {
    const create = vi.fn().mockResolvedValue(OK_RESPONSE);
    const client = makeSyncClient(create, 0.7);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await chatCompletion(client, "kimi-k2.5", [{ role: "user", content: "a" }]);
    await chatCompletion(client, "kimi-k2.5", [{ role: "user", content: "b" }]);
    await chatCompletion(client, "kimi-k2.5", [{ role: "user", content: "c" }]);

    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it("also clamps any model name containing 'thinking'", async () => {
    const create = vi.fn().mockResolvedValue(OK_RESPONSE);
    const client = makeSyncClient(create, 0.5);
    vi.spyOn(console, "warn").mockImplementation(() => {});

    await chatCompletion(client, "kimi-thinking-preview", [
      { role: "user", content: "hi" },
    ]);

    expect(create.mock.calls[0]?.[0]).toMatchObject({ temperature: 1 });
  });

  it("leaves regular models untouched (no clamp, no warning)", async () => {
    const create = vi.fn().mockResolvedValue(OK_RESPONSE);
    const client = makeSyncClient(create, 0.7);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await chatCompletion(
      client,
      "moonshot-v1-32k",
      [{ role: "user", content: "hi" }],
      { temperature: 0.3 },
    );

    expect(create.mock.calls[0]?.[0]).toMatchObject({ temperature: 0.3 });
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("does not warn when requested temperature is already 1", async () => {
    const create = vi.fn().mockResolvedValue(OK_RESPONSE);
    const client = makeSyncClient(create, 1);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await chatCompletion(client, "kimi-k2.5", [{ role: "user", content: "hi" }]);

    expect(create.mock.calls[0]?.[0]).toMatchObject({ temperature: 1 });
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});
