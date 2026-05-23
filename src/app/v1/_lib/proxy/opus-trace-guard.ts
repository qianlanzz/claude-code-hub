import { isOpusTraceGateEnabled, validateOpusTraceRequest } from "@/lib/opus-trace/validation";
import { ProxyResponses } from "./responses";
import type { ProxySession } from "./session";

export class ProxyOpusTraceGuard {
  static async ensure(session: ProxySession): Promise<Response | null> {
    if (!isOpusTraceGateEnabled()) return null;
    if (session.originalFormat !== "claude") return null;

    const result = validateOpusTraceRequest(session.request.message);
    if (result.ok) return null;

    return ProxyResponses.buildError(400, result.reason, "invalid_request_error", result.details);
  }
}
