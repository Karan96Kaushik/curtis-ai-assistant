import { useCallback, useEffect, useState } from 'react';
import { MODEL_DEBUG_STORAGE_KEY, readModelDebugEnabled, writeModelDebugEnabled } from '@/lib/chat/modelDebug';

export function useModelDebug() {
  const [enabled, setEnabledState] = useState(false);

  useEffect(() => {
    setEnabledState(readModelDebugEnabled());
  }, []);

  const setEnabled = useCallback((next: boolean) => {
    setEnabledState(next);
    writeModelDebugEnabled(next);
  }, []);

  const toggle = useCallback(() => {
    setEnabled(!enabled);
  }, [enabled, setEnabled]);

  return { enabled, setEnabled, toggle, storageKey: MODEL_DEBUG_STORAGE_KEY };
}
