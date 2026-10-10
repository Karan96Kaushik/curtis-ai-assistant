import { defineFunction } from '@aws-amplify/backend';
import { agentFunctionEnvironment } from '../../agentFunctionEnv.js';

export const agentStep = defineFunction({
  name: 'agentStep',
  entry: './handler.ts',
  runtime: 22,
  timeoutSeconds: 90,
  memoryMB: 512,
  environment: agentFunctionEnvironment(),
});
