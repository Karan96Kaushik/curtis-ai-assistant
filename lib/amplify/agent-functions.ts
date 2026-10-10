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
