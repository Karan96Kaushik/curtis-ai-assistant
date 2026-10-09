import { useEffect, useState } from 'react';
import { AGENT_MODELS, DEFAULT_AGENT_MODEL, isAgentModel } from '@/lib/chat/models';

const STORAGE_KEY = 'curtis-model';

export function useAgentModel() {
  const [model, setModelState] = useState(DEFAULT_AGENT_MODEL);

  useEffect(() => {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (isAgentModel(saved)) setModelState(saved);
  }, []);

  function setModel(next: string) {
    if (!isAgentModel(next)) return;
    setModelState(next);
    localStorage.setItem(STORAGE_KEY, next);
  }

  return { model, setModel, models: AGENT_MODELS };
}
