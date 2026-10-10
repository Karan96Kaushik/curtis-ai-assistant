/** Which API serves this model. Shown in brackets next to the name. */
export type AgentRouter = 'Groq' | 'AI Studio' | 'OpenRouter';

export interface AgentModel {
  id: string;
  label: string;
  detail: string;
  router: AgentRouter;
}

export const AGENT_MODELS: readonly AgentModel[] = [
  { id: 'openai/gpt-oss-120b', label: 'GPT-OSS 120B', detail: 'Most capable', router: 'Groq' },
  { id: 'qwen/qwen3.8-27b', label: 'Qwen 3.8 27B', detail: 'Strong reasoning', router: 'Groq' },
  { id: 'llama-3.3-70b-versatile', label: 'Llama 3.3 70B', detail: 'Enterprise', router: 'Groq' },
  { id: 'minimaxai/minimax-m2.7', label: 'MiniMax M2.7', detail: 'Enterprise', router: 'Groq' },
  { id: 'openai/gpt-oss-20b', label: 'GPT-OSS 20B', detail: 'Fastest', router: 'Groq' },
  { id: 'llama-3.1-8b-instant', label: 'Llama 3.1 8B', detail: 'Enterprise, fast', router: 'Groq' },
  { id: 'gemini-3.1-pro-preview', label: 'Gemini 3.1 Pro', detail: 'Most capable', router: 'AI Studio' },
  { id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash', detail: 'Best for agents', router: 'AI Studio' },
  { id: 'gemini-3.6-flash', label: 'Gemini 3.6 Flash', detail: 'Everyday tasks', router: 'AI Studio' },
  { id: 'gemini-3.5-flash-lite', label: 'Gemini 3.5 Flash-Lite', detail: 'Fastest', router: 'AI Studio' },
  { id: 'gemini-3.1-flash-lite', label: 'Gemini 3.1 Flash-Lite', detail: 'Lowest cost', router: 'AI Studio' },
  { id: 'openrouter:nvidia/nemotron-3-ultra-550b-a55b:free', label: 'Nemotron 3 Ultra', detail: 'Most capable', router: 'OpenRouter' },
  { id: 'openrouter:thinkingmachines/inkling:free', label: 'Inkling', detail: 'Strong reasoning', router: 'OpenRouter' },
  { id: 'openrouter:nvidia/nemotron-3-super-120b-a12b:free', label: 'Nemotron 3 Super', detail: 'Best for agents', router: 'OpenRouter' },
  { id: 'openrouter:thinkingmachines/inkling-small:free', label: 'Inkling Small', detail: 'Coding', router: 'OpenRouter' },
  { id: 'openrouter:google/gemma-4-31b-it:free', label: 'Gemma 4 31B', detail: 'Multimodal', router: 'OpenRouter' },
  { id: 'openrouter:qwen/qwen3.8-27b:free', label: 'Qwen 3.8 27B', detail: 'Vision', router: 'OpenRouter' },
  { id: 'openrouter:google/gemma-4-26b-a4b-it:free', label: 'Gemma 4 26B', detail: 'Efficient', router: 'OpenRouter' },
  { id: 'openrouter:nvidia/nemotron-3.5-lightning:free', label: 'Nemotron 3.5 Lightning', detail: 'Fastest', router: 'OpenRouter' },
] as const;

export const DEFAULT_AGENT_MODEL = AGENT_MODELS[0].id;

const ALLOWED = new Set<string>(AGENT_MODELS.map((model) => model.id));

export function isAgentModel(value: unknown): value is string {
  return typeof value === 'string' && ALLOWED.has(value);
}

/** Use an allow-listed id, otherwise the env default when that is allow-listed, otherwise GPT-OSS 120B. */
export function resolveAgentModel(value: unknown, fallback?: string): string {
  if (isAgentModel(value)) return value;
  if (isAgentModel(fallback)) return fallback;
  return DEFAULT_AGENT_MODEL;
}

export function agentModelLabel(id: string): string {
  const model = AGENT_MODELS.find((entry) => entry.id === id);
  if (!model) return id;
  return `${model.label} (${model.router})`;
}
