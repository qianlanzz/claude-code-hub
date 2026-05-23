import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { decodeAnthropicSseResponse } from "@/lib/opus-trace/sse-anthropic";
import { validateOpusTraceRequest } from "@/lib/opus-trace/validation";
import { writeOpusTraceRecord } from "@/lib/opus-trace/writer";
import { redactOpusTraceSecrets } from "@/lib/opus-trace/redaction";

describe("opus trace", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("validates opus adaptive high effort requests", () => {
    expect(
      validateOpusTraceRequest({
        model: "claude-opus-4-7-20260501",
        thinking: { type: "adaptive" },
        output_config: { effort: "xhigh" },
      })
    ).toEqual({ ok: true, effort: "xhigh" });

    expect(
      validateOpusTraceRequest({
        model: "claude-sonnet-4-5",
        thinking: { type: "adaptive" },
        output_config: { effort: "xhigh" },
      }).ok
    ).toBe(false);

    expect(
      validateOpusTraceRequest({
        model: "claude-opus-4-7",
        thinking: { type: "enabled" },
        output_config: { effort: "xhigh" },
      }).ok
    ).toBe(false);

    expect(
      validateOpusTraceRequest({
        model: "claude-opus-4-7",
        thinking: { type: "adaptive" },
        output_config: { effort: "high" },
        messages: [{ role: "user", content: [{ type: "text", text: "heartbeat" }] }],
      }).ok
    ).toBe(false);
  });

  it("decodes Anthropic SSE into a response_data message", () => {
    const response = decodeAnthropicSseResponse(
      [
        "event: message_start",
        'data: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","model":"claude-opus-4-7-20260501","content":[],"usage":{"input_tokens":10}}}',
        "",
        "event: content_block_start",
        'data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}',
        "",
        "event: content_block_delta",
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"plan"}}',
        "",
        "event: content_block_delta",
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"sig"}}',
        "",
        "event: content_block_start",
        'data: {"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}',
        "",
        "event: content_block_delta",
        'data: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"done"}}',
        "",
        "event: content_block_start",
        'data: {"type":"content_block_start","index":2,"content_block":{"type":"tool_use","id":"toolu_1","name":"Read","input":{}}}',
        "",
        "event: content_block_delta",
        'data: {"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\":"}}',
        "",
        "event: content_block_delta",
        'data: {"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":"\\"src/a.ts\\"}"}}',
        "",
        "event: content_block_stop",
        'data: {"type":"content_block_stop","index":2}',
        "",
        "event: message_delta",
        'data: {"type":"message_delta","delta":{"stop_reason":"tool_use","stop_sequence":null},"usage":{"output_tokens":7}}',
        "",
      ].join("\n")
    );

    expect(response).toMatchObject({
      id: "msg_1",
      role: "assistant",
      model: "claude-opus-4-7-20260501",
      stop_reason: "tool_use",
      usage: { input_tokens: 10, output_tokens: 7 },
      content: [
        { type: "thinking", thinking: "plan", signature: "sig" },
        { type: "text", text: "done" },
        { type: "tool_use", id: "toolu_1", name: "Read", input: { path: "src/a.ts" } },
      ],
    });
  });

  it("writes one call-level JSON record per request", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "opus-trace-"));
    vi.stubEnv("OPUS_TRACE_COLLECTION_ENABLED", "true");
    vi.stubEnv("OPUS_TRACE_OUTPUT_DIR", dir);

    const session = {
      sessionId: "sess_1",
      requestSequence: 3,
      originalFormat: "claude",
      forwardedRequestBody: JSON.stringify({
        model: "claude-opus-4-7",
        thinking: { type: "adaptive" },
        output_config: { effort: "high" },
        messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      }),
      request: { message: {} },
      messageContext: { id: 42, createdAt: new Date("2026-05-07T16:15:32.123Z") },
    } as any;

    await writeOpusTraceRecord(session, {
      responseHeaders: new Headers({ "x-request-id": "req_1" }),
      statusCode: 200,
      responseText: JSON.stringify({
        id: "msg_1",
        type: "message",
        role: "assistant",
        model: "claude-opus-4-7",
        content: [{ type: "text", text: "ok" }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    });

    const text = await readFile(path.join(dir, "sess_1", "req_1.json"), "utf8");
    const record = JSON.parse(text);
    expect(record).toMatchObject({
      session_id: "sess_1",
      request_id: "req_1",
      timestamp: "2026-05-07T16:15:32.123Z",
      thinking_effort: "high",
      request: { model: "claude-opus-4-7" },
      response: { response_data: { id: "msg_1", stop_reason: "end_turn" } },
    });

    await rm(dir, { recursive: true, force: true });
  });

  it("redacts secrets and common PII while preserving structure", () => {
    expect(
      redactOpusTraceSecrets({
        authorization: "Bearer sk-test12345678901234567890",
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: "email me at user@example.com token=abc123456" }],
          },
        ],
      })
    ).toEqual({
      authorization: "[REDACTED]",
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "email me at [REDACTED] [REDACTED]" }],
        },
      ],
    });
  });
});
