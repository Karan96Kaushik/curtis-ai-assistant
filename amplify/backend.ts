import './loadEnv.js';
import { defineBackend } from '@aws-amplify/backend';
import { FunctionUrlAuthType, HttpMethod, type FunctionUrlOptions, type IFunction } from 'aws-cdk-lib/aws-lambda';
import { chat } from './functions/chat/resource.js';
import { runScheduledJob } from './functions/runScheduledJob/resource.js';
import { scheduleTick } from './functions/scheduleTick/resource.js';
import { sendPush } from './functions/sendPush/resource.js';

const backend = defineBackend({ chat, sendPush, scheduleTick, runScheduledJob });

const tickFn = backend.scheduleTick.resources.lambda;
const runnerFn = backend.runScheduledJob.resources.lambda;
runnerFn.grantInvoke(tickFn);
(tickFn as IFunction & { addEnvironment(key: string, value: string): void }).addEnvironment(
  'RUN_SCHEDULED_JOB_FUNCTION_NAME',
  runnerFn.functionName
);

const functionUrlOptions: FunctionUrlOptions = {
  authType: FunctionUrlAuthType.NONE,
  cors: {
    allowedOrigins: ['*'],
    allowedMethods: [HttpMethod.POST],
    allowedHeaders: ['content-type', 'authorization'],
  },
};

const chatUrl = backend.chat.resources.lambda.addFunctionUrl(functionUrlOptions);
const sendPushUrl = backend.sendPush.resources.lambda.addFunctionUrl(functionUrlOptions);

backend.addOutput({
  custom: {
    chatUrl: chatUrl.url,
    sendPushUrl: sendPushUrl.url,
  },
});

