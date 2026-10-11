#!/usr/bin/env node
/**
 * Smoke test for an NVIDIA NIM API key (NVIDIA_AI_API_KEY).
 *
 * Sends one short chat completion to the hosted NIM endpoint.
 * Optional: NVIDIA_MODEL (default nvidia/nemotron-3.5-lightning-30b-a3b).
 *
 * Run: node scripts/test-nvidia-nim.js
 */

require('dotenv').config();

const API_URL = 'https://integrate.api.nvidia.com/v1/chat/completions';
const MODEL = process.env.NVIDIA_MODEL || 'nvidia/nemotron-3.5-lightning-30b-a3b';

async function main() {
  const apiKey = process.env.NVIDIA_AI_API_KEY?.trim();
  if (!apiKey) {
    console.error('Missing NVIDIA_AI_API_KEY. Add it to .env or the environment.');
    process.exit(1);
  }

  const started = Date.now();
  const response = await fetch(API_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: 'user', content: 'Reply with exactly: nvidia-nim-ok' }],
      max_tokens: 256,
      temperature: 0,
      stream: false,
    }),
  });

  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }

  if (!response.ok) {
    console.error(`NVIDIA NIM request failed (${response.status} ${response.statusText})`);
    console.error(typeof body === 'string' ? body : JSON.stringify(body, null, 2));
    process.exit(1);
  }

  const reply = body?.choices?.[0]?.message?.content ?? '';
  console.log(`model: ${body?.model || MODEL}`);
  console.log(`latency: ${Date.now() - started}ms`);
  if (body?.usage) console.log(`usage: ${JSON.stringify(body.usage)}`);
  console.log('reply:');
  console.log(String(reply).trim() || '(empty)');
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
