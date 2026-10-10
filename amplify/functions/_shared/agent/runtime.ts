import { supabaseAsService } from '../supabaseUser.js';
import type { AgentRuntime } from './deps.js';
import { supabaseEmailReader } from './emailReader.js';
import { enqueueStep } from './enqueue.js';
import { notifyUser } from './notify.js';
import { callModelChain } from './provider.js';
import { TOOLS } from './registry.js';
import { SupabaseAgentStore } from './store.js';

export function productionRuntime(): AgentRuntime {
  const db = supabaseAsService();
  return {
    store: new SupabaseAgentStore(db),
    tools: TOOLS,
    callModel: (profile, messages, tools) => callModelChain({ profile, messages, tools }),
    enqueue: enqueueStep,
    notify: notifyUser,
    email: supabaseEmailReader(db),
    now: () => new Date(),
  };
}
