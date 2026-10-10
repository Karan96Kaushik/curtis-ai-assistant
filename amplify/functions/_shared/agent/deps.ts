import type { AgentStore } from './store.js';
import type {
  ChatMessage,
  EmailReader,
  EnqueueMessage,
  ModelTool,
  ModelTurn,
  ProfileSnapshot,
  ToolDef,
} from './types.js';

export interface AgentRuntime {
  store: AgentStore;
  tools: ToolDef[];
  callModel: (profile: ProfileSnapshot, messages: ChatMessage[], tools: ModelTool[]) => Promise<ModelTurn>;
  enqueue: (message: EnqueueMessage) => Promise<void>;
  notify: (
    userId: string,
    runId: string,
    kind: 'question' | 'approval' | 'done' | 'failed',
    text: string
  ) => Promise<void>;
  email: EmailReader;
  now: () => Date;
}
