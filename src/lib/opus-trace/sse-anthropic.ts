import { parseSSEData } from "@/lib/utils/sse";

type AnthropicMessage = {
  id: string;
  type: "message";
  role: "assistant";
  model?: string;
  content: Array<Record<string, unknown>>;
  stop_reason: "end_turn" | "tool_use" | "max_tokens" | "stop_sequence";
  stop_sequence: string | null;
  usage?: Record<string, unknown>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function normalizeStopReason(value: unknown): AnthropicMessage["stop_reason"] | null {
  if (
    value === "end_turn" ||
    value === "tool_use" ||
    value === "max_tokens" ||
    value === "stop_sequence"
  ) {
    return value;
  }
  return null;
}

function parseToolInput(value: string): unknown {
  if (!value.trim()) return {};
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

export function decodeAnthropicSseResponse(sseText: string): AnthropicMessage | null {
  const events = parseSSEData(sseText);
  let message: AnthropicMessage | null = null;
  const toolInputBuffers = new Map<number, string>();

  for (const event of events) {
    if (!isRecord(event.data)) continue;
    const data = event.data;

    if (event.event === "message_start" && isRecord(data.message)) {
      const started = data.message;
      message = {
        id: typeof started.id === "string" ? started.id : "",
        type: "message",
        role: "assistant",
        ...(typeof started.model === "string" ? { model: started.model } : {}),
        content: Array.isArray(started.content)
          ? (started.content.filter(isRecord) as Array<Record<string, unknown>>)
          : [],
        stop_reason: "end_turn",
        stop_sequence: null,
        ...(isRecord(started.usage) ? { usage: { ...started.usage } } : {}),
      };
      continue;
    }

    if (!message) continue;

    if (event.event === "content_block_start") {
      const index = typeof data.index === "number" ? data.index : message.content.length;
      if (isRecord(data.content_block)) {
        message.content[index] = { ...data.content_block };
        if (data.content_block.type === "tool_use") {
          const input = (data.content_block as Record<string, unknown>).input;
          if (typeof input === "string") {
            toolInputBuffers.set(index, input);
          } else if (input === undefined) {
            toolInputBuffers.set(index, "");
          }
        }
      }
      continue;
    }

    if (event.event === "content_block_delta") {
      const index = typeof data.index === "number" ? data.index : -1;
      if (index < 0 || !isRecord(data.delta)) continue;
      const block = message.content[index] ?? {};
      const delta = data.delta;

      if (delta.type === "text_delta" && typeof delta.text === "string") {
        block.type = block.type ?? "text";
        block.text = `${typeof block.text === "string" ? block.text : ""}${delta.text}`;
      } else if (delta.type === "thinking_delta" && typeof delta.thinking === "string") {
        block.type = block.type ?? "thinking";
        block.thinking = `${typeof block.thinking === "string" ? block.thinking : ""}${
          delta.thinking
        }`;
      } else if (delta.type === "signature_delta" && typeof delta.signature === "string") {
        block.signature = `${typeof block.signature === "string" ? block.signature : ""}${
          delta.signature
        }`;
      } else if (delta.type === "input_json_delta" && typeof delta.partial_json === "string") {
        block.type = block.type ?? "tool_use";
        toolInputBuffers.set(index, `${toolInputBuffers.get(index) ?? ""}${delta.partial_json}`);
      }

      message.content[index] = block;
      continue;
    }

    if (event.event === "content_block_stop") {
      const index = typeof data.index === "number" ? data.index : -1;
      const block = index >= 0 ? message.content[index] : null;
      if (block?.type === "tool_use" && toolInputBuffers.has(index)) {
        block.input = parseToolInput(toolInputBuffers.get(index) ?? "");
        toolInputBuffers.delete(index);
      }
      continue;
    }

    if (event.event === "message_delta") {
      if (isRecord(data.delta)) {
        const stopReason = normalizeStopReason(data.delta.stop_reason);
        if (stopReason) message.stop_reason = stopReason;
        if ("stop_sequence" in data.delta) {
          message.stop_sequence =
            typeof data.delta.stop_sequence === "string" ? data.delta.stop_sequence : null;
        }
      }
      if (isRecord(data.usage)) {
        message.usage = { ...(message.usage ?? {}), ...data.usage };
      }
    }
  }

  if (!message?.id) return null;

  for (const [index, input] of toolInputBuffers) {
    const block = message.content[index];
    if (block?.type === "tool_use") {
      block.input = parseToolInput(input);
    }
  }

  return message;
}
