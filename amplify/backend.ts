import './loadEnv.js';
import { defineBackend } from '@aws-amplify/backend';
import { FunctionUrlAuthType, HttpMethod, type FunctionUrlOptions } from 'aws-cdk-lib/aws-lambda';
import { chat } from './functions/chat/resource.js';
import { sendPush } from './functions/sendPush/resource.js';

const backend = defineBackend({ chat, sendPush });

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

