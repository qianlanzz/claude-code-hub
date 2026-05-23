const SENSITIVE_KEY_PATTERN =
  /(?:api[-_]?key|authorization|password|passwd|pwd|secret|token|access[-_]?token|refresh[-_]?token|session[-_]?token|cookie)/i;

const STRING_PATTERNS: RegExp[] = [
  /\b(?:sk|pk|ak|rk|xox[baprs])-[-_a-zA-Z0-9]{16,}\b/g,
  /\b(?:ghp|github_pat)_[a-zA-Z0-9_]{20,}\b/g,
  /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
  /\b(?:\+?\d[\d .-]{8,}\d)\b/g,
  /\bBearer\s+[-._~+/=a-zA-Z0-9]{12,}\b/gi,
  /\b(?:api[_-]?key|token|password|secret)\s*[:=]\s*["']?[^"',\s]{6,}/gi,
];

const REDACTED = "[REDACTED]";

function redactString(value: string): string {
  return STRING_PATTERNS.reduce((text, pattern) => text.replace(pattern, REDACTED), value);
}

export function redactOpusTraceSecrets(value: unknown): unknown {
  if (typeof value === "string") {
    return redactString(value);
  }

  if (Array.isArray(value)) {
    return value.map((item) => redactOpusTraceSecrets(item));
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    output[key] = SENSITIVE_KEY_PATTERN.test(key) ? REDACTED : redactOpusTraceSecrets(item);
  }
  return output;
}
