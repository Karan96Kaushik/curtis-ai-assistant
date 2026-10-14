import { AGENT_MODELS, type AgentRouter } from '@/lib/chat/models';

export const DEFAULT_MODEL_IDS = ['openai/gpt-oss-120b', 'openai/gpt-oss-20b', 'gemini-3.5-flash-lite'] as const;

export type ChainProvider = 'groq' | 'google' | 'google_vertex' | 'openrouter';

export interface ChainEntry {
  provider: ChainProvider;
  model: string;
}

export function providerForRouter(router: AgentRouter): ChainProvider {
  if (router === 'AI Studio') return 'google';
  if (router === 'Google Vertex') return 'google_vertex';
  if (router === 'OpenRouter') return 'openrouter';
  return 'groq';
}

/** Keep the selected order. That order is the fallback chain. */
export function chainFromModelIds(ids: readonly string[]): { chain: ChainEntry[]; unknown: string[] } {
  const chain: ChainEntry[] = [];
  const unknown: string[] = [];
  const seen = new Set<string>();
  for (const raw of ids) {
    const id = raw.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const model = AGENT_MODELS.find((entry) => entry.id === id);
    if (!model) {
      unknown.push(id);
      continue;
    }
    chain.push({ provider: providerForRouter(model.router), model: id });
  }
  return { chain, unknown };
}

export function modelIdsFromChain(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
    const model = (entry as { model?: unknown }).model;
    return typeof model === 'string' ? [model] : [];
  });
}

export function providersInChain(chain: readonly ChainEntry[]): ChainProvider[] {
  return [...new Set(chain.map((entry) => entry.provider))];
}

/** Prefixed ids keep the same model name from colliding across providers. */
export function apiModelId(provider: ChainProvider, model: string): string {
  if (provider === 'openrouter' && model.startsWith('openrouter:')) return model.slice('openrouter:'.length);
  if (provider === 'google_vertex' && model.startsWith('vertex:')) return model.slice('vertex:'.length);
  return model;
}
