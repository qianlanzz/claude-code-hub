import "server-only";

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ProxySession } from "@/app/v1/_lib/proxy/session";
import { isSSEText } from "@/lib/utils/sse";
import { redactOpusTraceSecrets } from "./redaction";
import { decodeAnthropicSseResponse } from "./sse-anthropic";
import { isOpusTraceCollectionEnabled, validateOpusTraceRequest } from "./validation";

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function sanitizePathSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 160) || "unknown";
}

function extractRequestId(headers: Headers, fallback: string): string {
  return (
    headers.get("x-request-id") ??
    headers.get("request-id") ??
    headers.get("anthropic-request-id") ??
    fallback
  );
}

function resolveOutputRoot(): string {
  if (process.env.OPUS_TRACE_OUTPUT_DIR?.trim()) {
    return path.resolve(process.cwd(), process.env.OPUS_TRACE_OUTPUT_DIR.trim());
  }
  return path.join(process.cwd(), "data", "opus-traces");
}

function hasInvalidThinkingBlock(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;

  if (Array.isArray(value)) {
    return value.some(hasInvalidThinkingBlock);
  }

  const record = value as Record<string, unknown>;
  if (record.type === "thinking") {
    return (
      typeof record.thinking !== "string" ||
      record.thinking.trim().length === 0 ||
      typeof record.signature !== "string" ||
      record.signature.trim().length === 0
    );
  }

  return Object.values(record).some(hasInvalidThinkingBlock);
}

function extractOriginalEffortFromSession(session: ProxySession): string | null {
  const settings = session.getSpecialSettings?.();
  if (!Array.isArray(settings)) return null;

  for (const setting of settings) {
    if (!setting || typeof setting !== "object") continue;
    const record = setting as Record<string, unknown>;
    if (record.type === "anthropic_effort" && typeof record.effort === "string") {
      return record.effort;
    }
  }
  return null;
}

function parseResponseData(responseText: string): unknown | null {
  if (isSSEText(responseText)) {
    return decodeAnthropicSseResponse(responseText);
  }

  try {
    return JSON.parse(responseText) as unknown;
  } catch {
    return null;
  }
}

function isValidAnthropicResponseData(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  if (!Array.isArray(value.content)) return false;
  return (
    value.stop_reason === "end_turn" ||
    value.stop_reason === "tool_use" ||
    value.stop_reason === "max_tokens" ||
    value.stop_reason === "stop_sequence"
  );
}

export async function writeOpusTraceRecord(
  session: ProxySession,
  params: {
    responseHeaders: Headers;
    responseText: string;
    statusCode: number;
    errorMessage?: string;
  }
): Promise<void> {
  if (!isOpusTraceCollectionEnabled()) return;
  if (params.statusCode < 200 || params.statusCode >= 300) return;
  if (!session.sessionId || !session.messageContext) return;
  if (session.originalFormat !== "claude") return;

  let requestBody: unknown = session.request.message;
  if (session.forwardedRequestBody) {
    try {
      requestBody = JSON.parse(session.forwardedRequestBody) as unknown;
    } catch {
      requestBody = session.request.message;
    }
  }
  const validation = validateOpusTraceRequest(requestBody);
  if (!validation.ok) return;
  const originalEffort = extractOriginalEffortFromSession(session) ?? validation.effort;

  const responseData = parseResponseData(params.responseText);
  if (!isValidAnthropicResponseData(responseData)) {
    console.warn("[OpusTrace] Skipped record: response body is not a decoded Anthropic message", {
      sessionId: session.sessionId,
      requestSequence: session.requestSequence,
    });
    return;
  }
  if (hasInvalidThinkingBlock(requestBody) || hasInvalidThinkingBlock(responseData)) {
    console.warn("[OpusTrace] Skipped record: thinking block is missing thinking/signature", {
      sessionId: session.sessionId,
      requestSequence: session.requestSequence,
    });
    return;
  }

  const requestId = extractRequestId(
    params.responseHeaders,
    `cch_${session.messageContext.id}_${session.requestSequence}`
  );
  const timestamp = session.messageContext.createdAt.toISOString();

  const record = {
    session_id: session.sessionId,
    request_id: requestId,
    timestamp,
    thinking_effort: originalEffort,
    request: redactOpusTraceSecrets(requestBody),
    response: {
      response_data: redactOpusTraceSecrets(responseData),
    },
  };

  const outputRoot = resolveOutputRoot();
  const sessionDir = path.join(outputRoot, sanitizePathSegment(session.sessionId));
  await mkdir(sessionDir, { recursive: true });
  await writeFile(
    path.join(sessionDir, `${sanitizePathSegment(requestId)}.json`),
    `${JSON.stringify(record)}\n`,
    "utf8"
  );
}
