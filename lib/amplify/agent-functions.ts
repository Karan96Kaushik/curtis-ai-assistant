import { callFunction } from '@/lib/amplify/client';

export async function createAgentRun(command: string, profileId?: string): Promise<{ id: string; status: string }> {
  return callFunction('agentApi', { action: 'create', command, profile_id: profileId || undefined });
}

export async function answerAgentRun(id: string, text: string): Promise<{ id: string; status: string }> {
  return callFunction('agentApi', { action: 'answer', id, text });
}

export async function decideAgentApproval(
  id: string,
  decision: 'approve' | 'deny',
  editedArgs?: unknown,
  note?: string
): Promise<{ id: string; status: string }> {
  return callFunction('agentApi', { action: 'approval', id, decision, edited_args: editedArgs, note });
}

export async function cancelAgentRun(id: string): Promise<{ id: string; status: string }> {
  return callFunction('agentApi', { action: 'cancel', id });
}

export async function retryAgentRun(id: string): Promise<{ id: string; status: string }> {
  return callFunction('agentApi', { action: 'retry', id });
}

export async function continueAgentRun(id: string, text: string): Promise<{ id: string; status: string }> {
  return callFunction('agentApi', { action: 'continue', id, text });
}

export interface ProfileRunSuggestion {
  rationale: string;
  suggested_system_prompt: string;
  change_bullets: string[];
}

export async function analyzeProfileRun(id: string): Promise<ProfileRunSuggestion> {
  return callFunction('agentApi', { action: 'analyze_profile_run', id });
}

export async function improveAgentPrompt(input: {
  systemPrompt: string;
  profileId?: string;
  modelIds?: string[];
}): Promise<{ system_prompt: string; word_count: number; max_words: number }> {
  return callFunction('agentApi', {
    action: 'improve_prompt',
    system_prompt: input.systemPrompt,
    profile_id: input.profileId,
    model_ids: input.modelIds,
  });
}

export interface SaveAgentProfileInput {
  id?: string;
  name: string;
  description: string;
  systemPrompt: string;
  allowedTools: string[];
  approvalRequired: string[];
  allowedApps: string[];
  modelIds: string[];
  maxSteps: number;
  maxRuntimeMin: number;
  tokenBudget: number;
  isDefault: boolean;
}

export async function saveAgentProfile(input: SaveAgentProfileInput): Promise<{ id: string; name: string }> {
  return callFunction('agentApi', {
    action: 'save_profile',
    id: input.id,
    name: input.name,
    description: input.description,
    system_prompt: input.systemPrompt,
    allowed_tools: input.allowedTools,
    approval_required: input.approvalRequired,
    allowed_apps: input.allowedApps,
    model_ids: input.modelIds,
    max_steps: input.maxSteps,
    max_runtime_min: input.maxRuntimeMin,
    token_budget: input.tokenBudget,
    is_default: input.isDefault,
  });
}
