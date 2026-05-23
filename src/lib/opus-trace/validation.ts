const ALLOWED_EFFORTS = new Set(["high", "xhigh", "max"]);

function envBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return value !== "false" && value !== "0";
}

export type OpusTraceValidationResult =
  | { ok: true; effort: string }
  | { ok: false; reason: string; details?: Record<string, unknown> };

function collectText(value: unknown, output: string[]): void {
  if (typeof value === "string") {
    output.push(value);
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) collectText(item, output);
    return;
  }

  if (!value || typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  if (typeof record.text === "string") output.push(record.text);
  if ("content" in record) collectText(record.content, output);
}

function isObviousMachineNoReplyTurn(request: Record<string, unknown>): boolean {
  if (!Array.isArray(request.messages)) return false;

  const userMessages = request.messages.filter(
    (item): item is Record<string, unknown> =>
      !!item && typeof item === "object" && !Array.isArray(item) && item.role === "user"
  );
  const lastUser = userMessages.at(-1);
  if (!lastUser) return false;

  const textParts: string[] = [];
  collectText(lastUser.content, textParts);
  const text = textParts.join("\n").trim();
  if (text.length > 120) return false;

  return (
    /^(?:no[_ -]?reply|heartbeat|ping|keepalive)$/i.test(text) ||
    /^(?:cron|scheduled)\s+(?:heartbeat|ping|check)$/i.test(text)
  );
}

export function isOpusTraceCollectionEnabled(): boolean {
  return envBoolean(process.env.OPUS_TRACE_COLLECTION_ENABLED, false);
}

export function isOpusTraceGateEnabled(): boolean {
  return envBoolean(process.env.OPUS_TRACE_ENFORCE_GATE, false);
}

export function isAllowedOpusTraceModel(model: unknown): model is string {
  if (typeof model !== "string") return false;
  const normalized = model.toLowerCase();
  return (
    normalized === "claude-opus-4-6" ||
    normalized === "claude-opus-4-7" ||
    normalized.startsWith("claude-opus-4-6-") ||
    normalized.startsWith("claude-opus-4-7-")
  );
}

export function validateOpusTraceRequest(request: unknown): OpusTraceValidationResult {
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    return { ok: false, reason: "Request body must be a JSON object." };
  }

  const body = request as Record<string, unknown>;
  if (!isAllowedOpusTraceModel(body.model)) {
    return {
      ok: false,
      reason: "Only claude-opus-4-6/4-7 requests are allowed for Opus trace collection.",
      details: { model: body.model ?? null },
    };
  }

  const thinking = body.thinking;
  if (!thinking || typeof thinking !== "object" || Array.isArray(thinking)) {
    return {
      ok: false,
      reason: 'Opus trace collection requires thinking.type="adaptive".',
    };
  }

  const thinkingType = (thinking as Record<string, unknown>).type;
  if (thinkingType !== "adaptive") {
    return {
      ok: false,
      reason: 'Opus trace collection requires thinking.type="adaptive".',
      details: { thinkingType: thinkingType ?? null },
    };
  }

  const outputConfig = body.output_config;
  const effort =
    outputConfig && typeof outputConfig === "object" && !Array.isArray(outputConfig)
      ? (outputConfig as Record<string, unknown>).effort
      : null;

  if (typeof effort !== "string" || !ALLOWED_EFFORTS.has(effort)) {
    return {
      ok: false,
      reason: "Opus trace collection requires output_config.effort in {high,xhigh,max}.",
      details: { effort: effort ?? null },
    };
  }

  if (isObviousMachineNoReplyTurn(body)) {
    return {
      ok: false,
      reason: "Opus trace collection rejects obvious cron/heartbeat/no_reply machine turns.",
    };
  }

  return { ok: true, effort };
}
