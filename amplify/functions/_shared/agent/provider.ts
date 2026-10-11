import { apiModelId } from '../../../../lib/agents/modelChain.js';
import type { ChatMessage, ModelTool, ModelTurn, ProfileSnapshot, ProviderFallback, ProviderName } from './types.js';

const ENDPOINTS: Record<ProviderName, { url: string; env: string }> = {
  groq: { url: 'https://api.groq.com/openai/v1/chat/completions', env: 'GROQ_API_KEY' },
  google: {
    url: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
    env: 'GOOGLE_AI_STUDIO_API_KEY',
  },
  openrouter: { url: 'https://openrouter.ai/api/v1/chat/completions', env: 'OPENROUTER_API_KEY' },
};

const CALL_TIMEOUT_MS = 18_000;

interface ChatCompletion {
  choices?: { message?: ChoiceMessage }[];
  usage?: { total_tokens?: number; prompt_tokens?: number; completion_tokens?: number };
  error?: unknown;
  message?: unknown;
}

/** Pull a human-readable reason out of OpenAI-compatible and Google error bodies. */
export function providerErrorDetail(status: number, provider: string, raw: string, payload: unknown): string {
  const parts: string[] = [`${provider} returned ${status}`];
  const fromPayload = extractErrorText(payload);
  if (fromPayload) {
    parts.push(fromPayload);
  } else {
    const flat = raw.replace(/\s+/g, ' ').trim();
    if (flat) parts.push(flat.slice(0, 400));
  }
  return parts.join(': ').slice(0, 480);
}

function extractErrorText(value: unknown, depth = 0): string {
  if (depth > 4 || value == null) return '';
  if (typeof value === 'string') {
    const flat = value.replace(/\s+/g, ' ').trim();
    return flat.slice(0, 400);
  }
  if (typeof value !== 'object') return '';
  const row = value as Record<string, unknown>;
  if (typeof row.message === 'string' && row.message.trim()) {
    const status = typeof row.status === 'string' ? row.status : typeof row.code === 'string' || typeof row.code === 'number' ? String(row.code) : '';
    return status ? `${status}: ${row.message.trim()}` : row.message.trim();
  }
  if (row.error != null) {
    const nested = extractErrorText(row.error, depth + 1);
    if (nested) return nested;
  }
  if (Array.isArray(row.details)) {
    for (const item of row.details) {
      const nested = extractErrorText(item, depth + 1);
      if (nested) return nested;
    }
  }
  if (typeof row.error === 'string' && row.error.trim()) return row.error.trim();
  return '';
}

interface ChoiceMessage {
  content?: string | null;
  tool_calls?: {
    id?: string;
    function?: { name?: string; arguments?: unknown };
    extra_content?: { google?: { thought_signature?: string } };
  }[];
}

const SKIP_THOUGHT_SIGNATURE = 'skip_thought_signature_validator';

function thoughtSignatureOf(call: {
  thought_signature?: string;
  extra_content?: { google?: { thought_signature?: string } };
}): string | undefined {
  if (typeof call.thought_signature === 'string' && call.thought_signature.trim()) return call.thought_signature.trim();
  const nested = call.extra_content?.google?.thought_signature;
  if (typeof nested === 'string' && nested.trim()) return nested.trim();
  return undefined;
}

/**
 * OpenAI-compatible providers require type and a nested function on each tool call.
 * Google also requires thought_signature on the first function call of each step,
 * and a non-empty name on every tool (function_response) message.
 */
export function toProviderMessages(messages: ChatMessage[], provider?: ProviderName): Record<string, unknown>[] {
  const nameByCallId = new Map<string, string>();
  for (const message of messages) {
    if (message.role !== 'assistant' || !message.tool_calls?.length) continue;
    for (const call of message.tool_calls) {
      const name = typeof call.name === 'string' ? call.name.trim() : '';
      const id = typeof call.id === 'string' ? call.id.trim() : '';
      if (name && id) nameByCallId.set(id, name);
    }
  }

  return messages.flatMap((message) => {
    if (message.role === 'tool') {
      const toolCallId = (message.tool_call_id ?? '').trim();
      const name = (message.name ?? nameByCallId.get(toolCallId) ?? '').trim();
      if (!name) return [];
      return [
        {
          role: 'tool',
          name,
          content: message.content ?? '',
          tool_call_id: toolCallId || name,
        },
      ];
    }
    if (message.role !== 'assistant' || !message.tool_calls?.length) {
      return [{ role: message.role, content: message.content ?? '' }];
    }
    const tool_calls = message.tool_calls.flatMap((call, index) => {
      const name = typeof call.name === 'string' ? call.name.trim() : '';
      if (!name) return [];
      const id = (typeof call.id === 'string' ? call.id.trim() : '') || name;
      const wire: Record<string, unknown> = {
        id,
        type: 'function',
        function: {
          name,
          arguments: typeof call.arguments === 'string' ? call.arguments : JSON.stringify(call.arguments ?? {}),
        },
      };
      if (provider === 'google') {
        const signature = thoughtSignatureOf(call) || (index === 0 ? SKIP_THOUGHT_SIGNATURE : undefined);
        if (signature) {
          wire.extra_content = { google: { thought_signature: signature } };
        }
      }
      return [wire];
    });
    if (!tool_calls.length) {
      return [{ role: 'assistant', content: message.content ?? '' }];
    }
    return [
      {
        role: 'assistant',
        // Google rejects null content on tool-call turns.
        content: message.content ?? '',
        tool_calls,
      },
    ];
  });
}

function chainFor(profile: ProfileSnapshot): { provider: ProviderName; model: string }[] {
  const allowed = new Set(profile.allowed_providers);
  const seen = new Set<string>();
  const chain: { provider: ProviderName; model: string }[] = [];
  for (const entry of profile.model_chain) {
    if (!allowed.has(entry.provider)) continue;
    const key = `${entry.provider}:${entry.model}`;
    if (seen.has(key)) continue;
    seen.add(key);
    chain.push(entry);
  }
  return chain;
}

function retryAfterSeconds(res: Response): number {
  const header = res.headers.get('retry-after');
  let seconds = 30;
  if (header) {
    const asNumber = Number(header);
    if (Number.isFinite(asNumber)) seconds = asNumber;
    else {
      const when = Date.parse(header);
      if (Number.isFinite(when)) seconds = Math.ceil((when - Date.now()) / 1000);
    }
  }
  return Math.min(900, Math.max(15, Math.ceil(seconds)));
}

function parseToolCalls(message: ChoiceMessage | undefined): { id: string; name: string; args: unknown; thought_signature?: string }[] {
  const calls = message?.tool_calls;
  if (!Array.isArray(calls)) return [];
  return calls.slice(0, 2).flatMap((call, index) => {
    const name = call.function?.name?.trim();
    if (!name) return [];
    const raw = call.function?.arguments;
    let args: unknown = raw ?? {};
    if (typeof raw === 'string') {
      try {
        args = JSON.parse(raw);
      } catch {
        args = { __invalidJson: raw.slice(0, 500) };
      }
    }
    const thought_signature = thoughtSignatureOf(call);
    // Gemini often returns id: ""; use the function name so tool responses can be matched.
    const id = call.id?.trim() || `${name}_${index}`;
    return [
      {
        id,
        name,
        args,
        ...(thought_signature ? { thought_signature } : {}),
      },
    ];
  });
}

function lenientToolCalls(text: string): { id: string; name: string; args: unknown }[] {
  if (process.env.AGENT_LENIENT_TOOLS === '0') return [];
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return [];
  try {
    const parsed = JSON.parse(text.slice(start, end + 1)) as { name?: unknown; arguments?: unknown; args?: unknown };
    if (typeof parsed.name !== 'string' || !parsed.name.trim()) return [];
    const args = parsed.arguments ?? parsed.args ?? {};
    return [{ id: `call_lenient_${Date.now()}`, name: parsed.name.trim(), args }];
  } catch {
    return [];
  }
}

function usageTokens(payload: { usage?: { total_tokens?: number; prompt_tokens?: number; completion_tokens?: number } }, fallbackChars: number): number {
  const usage = payload.usage;
  if (usage?.total_tokens && usage.total_tokens > 0) return usage.total_tokens;
  const sum = (usage?.prompt_tokens ?? 0) + (usage?.completion_tokens ?? 0);
  if (sum > 0) return sum;
  return Math.ceil(fallbackChars / 3.5);
}

export async function callModelChain(opts: {
  profile: ProfileSnapshot;
  messages: ChatMessage[];
  tools: ModelTool[];
  fetchImpl?: typeof fetch;
}): Promise<ModelTurn> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const chain = chainFor(opts.profile);
  if (!chain.length) {
    return { kind: 'provider_error', message: 'No providers left in the model chain.', fallbacks: [] };
  }

  const fallbacks: ProviderFallback[] = [];
  let retryable = false;
  let delaySeconds = 30;
  let lastMessage = 'Every provider failed.';

  for (let i = 0; i < chain.length; i += 1) {
    const current = chain[i];
    const next = chain[i + 1];
    const endpoint = ENDPOINTS[current.provider];
    const key = process.env[endpoint.env]?.trim() ?? '';
    if (!key) {
      lastMessage = `${current.provider} is not configured.`;
      if (next) fallbacks.push({ from: `${current.provider}:${current.model}`, to: `${next.provider}:${next.model}`, status: 0 });
      continue;
    }

    const tools = opts.tools.filter((tool) => typeof tool.function?.name === 'string' && tool.function.name.trim());
    const body: Record<string, unknown> = {
      model: apiModelId(current.provider, current.model),
      messages: toProviderMessages(opts.messages, current.provider),
      temperature: 0.2,
    };
    if (tools.length) {
      body.tools = tools;
      body.tool_choice = 'auto';
      if (current.provider === 'groq') body.parallel_tool_calls = false;
    }

    const started = Date.now();
    let res: Response;
    try {
      res = await fetchImpl(endpoint.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${key}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      });
    } catch (err) {
      const timedOut = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
      const detail = timedOut
        ? `${current.provider} timed out.`
        : `${current.provider} request failed${err instanceof Error && err.message ? `: ${err.message}` : '.'}`;
      lastMessage = detail.slice(0, 480);
      retryable = true;
      delaySeconds = Math.max(delaySeconds, 30);
      if (next) {
        fallbacks.push({
          from: `${current.provider}:${current.model}`,
          to: `${next.provider}:${next.model}`,
          status: timedOut ? 408 : 0,
          detail: lastMessage,
        });
      }
      continue;
    }

    const raw = await res.text();
    let payload: ChatCompletion | null = null;
    try {
      payload = raw ? (JSON.parse(raw) as ChatCompletion) : null;
    } catch {
      payload = null;
    }

    if (!res.ok) {
      lastMessage = providerErrorDetail(res.status, current.provider, raw, payload);
      const retry = res.status === 429 || res.status >= 500;
      if (retry) {
        retryable = true;
        delaySeconds = Math.max(delaySeconds, res.status === 429 ? retryAfterSeconds(res) : 30);
      }
      if (next) {
        fallbacks.push({
          from: `${current.provider}:${current.model}`,
          to: `${next.provider}:${next.model}`,
          status: res.status,
          detail: lastMessage,
        });
      }
      continue;
    }

    const message = payload?.choices?.[0]?.message;
    const text = typeof message?.content === 'string' ? message.content : '';
    let toolCalls = parseToolCalls(message);
    if (!toolCalls.length && text) toolCalls = lenientToolCalls(text);
    return {
      kind: 'ok',
      text,
      toolCalls,
      usage: {
        provider: current.provider,
        model: current.model,
        tokens: usageTokens(payload ?? {}, raw.length),
        latencyMs: Date.now() - started,
      },
      fallbacks,
    };
  }

  if (retryable) return { kind: 'rate_limited', delaySeconds: Math.min(900, delaySeconds), fallbacks };
  return { kind: 'provider_error', message: lastMessage.slice(0, 480), fallbacks };
}
