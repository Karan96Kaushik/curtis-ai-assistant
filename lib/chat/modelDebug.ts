export const MODEL_DEBUG_STORAGE_KEY = 'curtis-model-debug';

/** One provider call (a chat completion request). */
export interface ModelDebugCall {
  model: string;
  messages: unknown[];
  tools?: unknown[];
  toolChoice?: string | object;
}

export function isModelDebugEnabled(stored: string | null): boolean {
  return stored === '1' || stored === 'true';
}

export function readModelDebugEnabled(): boolean {
  if (typeof localStorage === 'undefined') return false;
  return isModelDebugEnabled(localStorage.getItem(MODEL_DEBUG_STORAGE_KEY));
}

export function writeModelDebugEnabled(enabled: boolean): void {
  if (typeof localStorage === 'undefined') return;
  localStorage.setItem(MODEL_DEBUG_STORAGE_KEY, enabled ? '1' : '0');
}
