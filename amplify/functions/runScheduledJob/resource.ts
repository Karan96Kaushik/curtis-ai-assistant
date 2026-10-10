import { defineFunction } from '@aws-amplify/backend';
import { agentFunctionEnvironment } from '../../agentFunctionEnv.js';

/** Runs one claimed schedule. Invoked asynchronously by scheduleTick. */
export const runScheduledJob = defineFunction({
  name: 'runScheduledJob',
  entry: './handler.ts',
  runtime: 22,
  timeoutSeconds: 900,
  memoryMB: 1024,
  environment: agentFunctionEnvironment(),
});
