#!/usr/bin/env node
/**
 * Check Groq usage / quota for every GROQ_API_KEY* in .env.
 *
 * Run only via: npm run groq:billing
 * Not imported by the bot / Discord agent / CLI.
 *
 * Note: Groq does not expose dollar invoices over the public API.
 * Rate-limit headers (RPD / TPM) are only returned on inference calls,
 * so this script makes one tiny chat completion per key.
 */

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const axios = require('axios');

const KEY_ENVS = ['GROQ_API_KEY', 'GROQ_API_KEY_2', 'GROQ_API_KEY_3'];
const API_BASE = 'https://api.groq.com/openai/v1';
const PROM_BASE = 'https://api.groq.com/v1/metrics/prometheus';
const MODEL = process.env.GROQ_MODEL || 'openai/gpt-oss-120b';
const LOG_DIR = path.join(__dirname, '..', 'logs');
const LOG_FILE = path.join(LOG_DIR, 'groq-billing.log');

function maskKey(key) {
  if (!key || key.length < 8) return '(invalid)';
  return `…${key.slice(-6)}`;
}

function errText(err) {
  if (err == null) return null;
  if (typeof err === 'string') return err;
  if (typeof err === 'object') {
    return err.message || err.code || JSON.stringify(err);
  }
  return String(err);
}

function pickHeaders(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers || {})) {
    if (/^x-ratelimit-|^retry-after$/i.test(k)) out[k.toLowerCase()] = v;
  }
  return out;
}

function num(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function pct(used, limit) {
  if (used == null || limit == null || limit <= 0) return null;
  return Math.round((used / limit) * 1000) / 10;
}

function formatQuota({ limit, remaining, reset }) {
  if (limit == null && remaining == null) return 'n/a (no rate-limit headers)';
  const used = limit != null && remaining != null ? limit - remaining : null;
  const usedPct = pct(used, limit);
  const parts = [];
  if (used != null && limit != null) {
    parts.push(`${used.toLocaleString()} / ${limit.toLocaleString()} used`);
    parts.push(`${remaining.toLocaleString()} left`);
  } else if (remaining != null) {
    parts.push(`${remaining.toLocaleString()} remaining`);
  }
  if (usedPct != null) parts.push(`${usedPct}%`);
  if (reset) parts.push(`reset ${reset}`);
  return parts.join(' · ');
}

function quotaFromHeaders(headers) {
  const rate = pickHeaders(headers);
  const limitRequests = num(rate['x-ratelimit-limit-requests']);
  const remainingRequests = num(rate['x-ratelimit-remaining-requests']);
  const limitTokens = num(rate['x-ratelimit-limit-tokens']);
  const remainingTokens = num(rate['x-ratelimit-remaining-tokens']);

  return {
    rpd: {
      limit: limitRequests,
      remaining: remainingRequests,
      used:
        limitRequests != null && remainingRequests != null
          ? limitRequests - remainingRequests
          : null,
      reset: rate['x-ratelimit-reset-requests'] || null,
    },
    tpm: {
      limit: limitTokens,
      remaining: remainingTokens,
      used:
        limitTokens != null && remainingTokens != null
          ? limitTokens - remainingTokens
          : null,
      reset: rate['x-ratelimit-reset-tokens'] || null,
    },
    rawHeaders: rate,
  };
}

/**
 * Inference endpoints attach x-ratelimit-* headers; /models does not.
 * One tiny completion per key is required to read RPD/TPM.
 */
async function fetchRateLimits(apiKey) {
  const res = await axios.post(
    `${API_BASE}/chat/completions`,
    {
      model: MODEL,
      messages: [{ role: 'user', content: 'ok' }],
      max_tokens: 1,
      temperature: 0,
    },
    {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      timeout: 30000,
      validateStatus: () => true,
    }
  );

  const quotas = quotaFromHeaders(res.headers);
  const ok = res.status >= 200 && res.status < 300;
  // 429 still includes useful rate-limit headers
  const usable = ok || (res.status === 429 && (quotas.rpd.limit != null || quotas.tpm.limit != null));

  return {
    ok: usable,
    status: res.status,
    model: MODEL,
    usage: res.data?.usage || null,
    error: ok
      ? null
      : errText(res.data?.error) ||
        (typeof res.data === 'string' ? res.data.slice(0, 200) : JSON.stringify(res.data).slice(0, 200)),
    ...quotas,
  };
}

async function fetchPrometheusSnapshot(apiKey) {
  const queries = {
    requestsPerMin: 'sum(model_project_id_status_code:requests:rate5m)',
    tokensInPerMin: 'sum(model_project_id:tokens_in:rate5m)',
    tokensOutPerMin: 'sum(model_project_id:tokens_out:rate5m)',
  };

  const results = {};
  let available = false;
  let error = null;

  for (const [name, query] of Object.entries(queries)) {
    try {
      const res = await axios.get(`${PROM_BASE}/api/v1/query`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        params: { query },
        timeout: 15000,
        validateStatus: () => true,
      });

      if (res.status === 401 || res.status === 403 || res.status === 404) {
        error =
          errText(res.data?.error) ||
          `HTTP ${res.status} — Prometheus metrics are Enterprise-only`;
        break;
      }
      if (res.status !== 200 || res.data?.status !== 'success') {
        error =
          errText(res.data?.error) ||
          errText(res.data?.errorType) ||
          `HTTP ${res.status}`;
        break;
      }

      available = true;
      const value = res.data?.data?.result?.[0]?.value?.[1];
      results[name] = value != null ? Number(value) : 0;
    } catch (err) {
      error = err.message;
      break;
    }
  }

  return { available, error, results };
}

function line(...parts) {
  return parts.join(' ');
}

function appendLog(text) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  fs.appendFileSync(LOG_FILE, `${text}\n`, 'utf8');
}

async function checkAccount(envName, apiKey) {
  const started = new Date().toISOString();
  const label = `${envName} (${maskKey(apiKey)})`;

  const rate = await fetchRateLimits(apiKey);
  const prom = rate.ok
    ? await fetchPrometheusSnapshot(apiKey)
    : { available: false, error: 'skipped', results: {} };

  const summary = {
    at: started,
    env: envName,
    key: maskKey(apiKey),
    ok: rate.ok,
    status: rate.status,
    model: rate.model,
    usage: rate.usage,
    error: rate.error,
    rpd: rate.rpd,
    tpm: rate.tpm,
    prometheus: {
      available: prom.available,
      error: errText(prom.error),
      results: prom.results,
    },
  };

  const out = [];
  out.push('');
  out.push(`── ${label} ──`);
  out.push(`  checkedAt: ${started}`);

  if (!rate.ok) {
    out.push(`  status:   FAIL HTTP ${rate.status}`);
    out.push(`  error:    ${rate.error || 'unknown'}`);
  } else {
    out.push(`  status:   OK (HTTP ${rate.status})`);
    out.push(`  model:    ${rate.model}`);
    if (rate.usage) {
      out.push(
        `  probe:    prompt=${rate.usage.prompt_tokens} completion=${rate.usage.completion_tokens} total=${rate.usage.total_tokens}`
      );
    }
    out.push(`  RPD:      ${formatQuota(rate.rpd)}  (requests/day)`);
    out.push(`  TPM:      ${formatQuota(rate.tpm)}  (tokens/minute)`);

    if (prom.available) {
      out.push(
        `  metrics:  req/min≈${prom.results.requestsPerMin?.toFixed?.(3) ?? prom.results.requestsPerMin}` +
          ` · tok_in/min≈${prom.results.tokensInPerMin?.toFixed?.(1) ?? prom.results.tokensInPerMin}` +
          ` · tok_out/min≈${prom.results.tokensOutPerMin?.toFixed?.(1) ?? prom.results.tokensOutPerMin}`
      );
    } else {
      out.push(`  metrics:  unavailable (${errText(prom.error) || 'no Prometheus access'})`);
    }
  }

  out.push(
    `  invoice:  dollar spend / invoices → https://console.groq.com (Settings → Billing)`
  );

  return { summary, lines: out };
}

async function main() {
  const accounts = KEY_ENVS.map((name) => ({
    name,
    key: process.env[name]?.trim(),
  })).filter((a) => a.key);

  if (!accounts.length) {
    console.error('No GROQ_API_KEY / GROQ_API_KEY_2 / GROQ_API_KEY_3 found in .env');
    process.exit(1);
  }

  const header = [
    `Groq billing / usage check — ${new Date().toISOString()}`,
    `Accounts: ${accounts.length} (${accounts.map((a) => a.name).join(', ')})`,
    `Probe model: ${MODEL} (1 completion token each — needed for rate-limit headers)`,
    'Dollar invoices are console-only; this script logs API quota usage.',
  ];

  for (const h of header) console.log(h);
  appendLog(header.join('\n'));

  let failures = 0;
  for (const account of accounts) {
    try {
      const { summary, lines } = await checkAccount(account.name, account.key);
      for (const l of lines) console.log(l);
      appendLog(lines.join('\n'));
      appendLog(JSON.stringify(summary));
      if (!summary.ok) failures += 1;
    } catch (err) {
      failures += 1;
      const msg = line(`── ${account.name} (${maskKey(account.key)}) ──`, `ERROR ${err.message}`);
      console.error(msg);
      appendLog(msg);
    }
  }

  const footer = `\nDone. Log appended → ${LOG_FILE}`;
  console.log(footer);
  appendLog(footer);

  if (failures) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
