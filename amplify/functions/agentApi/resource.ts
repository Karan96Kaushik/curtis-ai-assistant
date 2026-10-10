import { defineFunction } from '@aws-amplify/backend';
import { agentFunctionEnvironment } from '../../agentFunctionEnv.js';

export const agentApi = defineFunction({
  name: 'agentApi',
  entry: './handler.ts',
  runtime: 22,
  timeoutSeconds: 30,
  memoryMB: 512,
  environment: agentFunctionEnvironment(),
});
