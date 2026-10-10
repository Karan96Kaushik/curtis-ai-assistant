import './loadEnv.js';
import { defineBackend } from '@aws-amplify/backend';
import { Duration } from 'aws-cdk-lib';
import { SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import { FunctionUrlAuthType, HttpMethod, type Function as LambdaFunction, type FunctionUrlOptions, type IFunction } from 'aws-cdk-lib/aws-lambda';
import { Queue } from 'aws-cdk-lib/aws-sqs';
import { agentApi } from './functions/agentApi/resource.js';
import { agentStep } from './functions/agentStep/resource.js';
import { chat } from './functions/chat/resource.js';
import { runScheduledJob } from './functions/runScheduledJob/resource.js';
import { scheduleTick } from './functions/scheduleTick/resource.js';
import { sendPush } from './functions/sendPush/resource.js';

const backend = defineBackend({ chat, sendPush, scheduleTick, runScheduledJob, agentApi, agentStep });

const agentStack = backend.createStack('agent');
const agentDlq = new Queue(agentStack, 'AgentStepDlq', {
  fifo: true,
  retentionPeriod: Duration.days(14),
});
const agentQueue = new Queue(agentStack, 'AgentStepQueue', {
  fifo: true,
  contentBasedDeduplication: false,
  visibilityTimeout: Duration.seconds(180),
  deadLetterQueue: { queue: agentDlq, maxReceiveCount: 3 },
});
const stepFn = backend.agentStep.resources.lambda as LambdaFunction;
stepFn.addEventSource(
  new SqsEventSource(agentQueue, {
    batchSize: 1,
    reportBatchItemFailures: true,
    maxConcurrency: 2,
  })
);
agentQueue.grantSendMessages(stepFn);
agentQueue.grantSendMessages(backend.agentApi.resources.lambda);
for (const fn of [stepFn, backend.agentApi.resources.lambda]) {
  (fn as IFunction & { addEnvironment(key: string, value: string): void }).addEnvironment(
    'AGENT_STEP_QUEUE_URL',
    agentQueue.queueUrl
  );
}

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
const agentApiUrl = backend.agentApi.resources.lambda.addFunctionUrl(functionUrlOptions);

backend.addOutput({
  custom: {
    chatUrl: chatUrl.url,
    sendPushUrl: sendPushUrl.url,
    agentApiUrl: agentApiUrl.url,
  },
});

