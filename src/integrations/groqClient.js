const Groq = require('groq-sdk');

const DEFAULT_MODEL = process.env.GROQ_MODEL || 'llama-3.1-8b-instant';

function createGroqClient() {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    throw new Error('Missing GROQ_API_KEY in .env');
  }
  return new Groq({ apiKey });
}

/**
 * Chat completion with optional tools.
 * @param {{ messages: object[], tools?: object[], toolChoice?: string|object, model?: string, temperature?: number }} opts
 */
async function chat({ messages, tools, toolChoice, model = DEFAULT_MODEL, temperature = 0.2 }) {
  const client = createGroqClient();
  const body = {
    model,
    messages,
    temperature,
  };
  if (tools?.length) {
    body.tools = tools;
    body.tool_choice = toolChoice || 'auto';
  }
  return client.chat.completions.create(body);
}

function isConfigured() {
  return Boolean(process.env.GROQ_API_KEY);
}

module.exports = {
  createGroqClient,
  chat,
  isConfigured,
  DEFAULT_MODEL,
};
