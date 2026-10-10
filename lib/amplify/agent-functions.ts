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

export interface SaveAgentProfileInput {
  id?: string;
  name: string;
  description: string;
  systemPrompt: string;
  allowedTools: string[];
  approvalRequired: string[];
  modelIds: string[];
  maxSteps: number;
  maxRuntimeMin: number;
  tokenBudget: number;
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
    model_ids: input.modelIds,
    max_steps: input.maxSteps,
    max_runtime_min: input.maxRuntimeMin,
    token_budget: input.tokenBudget,
  });
}
