const SECRET_PATTERNS: RegExp[] = [
  /(?:api[_-]?key|client[_-]?secret|secret|password|passwd|access[_-]?token|refresh[_-]?token)\s*[:=]\s*\S+/gi,
  /\b(?:sk|pk)-[a-zA-Z0-9]{16,}\b/g,
  /\bghp_[a-zA-Z0-9]{16,}\b/g,
  /\bgithub_pat_[a-zA-Z0-9_]{16,}\b/g,
  /\beyJ[a-zA-Z0-9_-]{20,}\.[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\b/g,
  /\bBearer\s+[a-zA-Z0-9._-]{12,}\b/gi,
];

/** Strip credential-shaped strings before behavior or context text is stored or shown. */
export function redactSecrets(text: string): string {
  let out = text;
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, '[redacted]');
  }
  return out;
}
