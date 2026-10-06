export interface RequestTimer {
  end(outcome: string | number): number;
}

/** One log line per request: `[timing] chat 200 1834ms`. */
export function startRequestTimer(label: string): RequestTimer {
  const started = Date.now();
  return {
    end(outcome) {
      const ms = Date.now() - started;
      console.log(`[timing] ${label} ${outcome} ${ms}ms`);
      return ms;
    },
  };
}
