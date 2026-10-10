import { buildContext, summaryUpdate } from './context.js';
import type { AgentRuntime } from './deps.js';
import { executeTool } from './execute.js';
import { modelToolName, registryToolName, toModelTools, toolAllowed, toolsForProfile } from './registry.js';
import { preview, redactValue } from './text.js';
import type { ChatMessage, EventType, ParsedToolCall, RunRecord, StepOutcome, ToolCall } from './types.js';

const NUDGE = 'Use a tool. Call finish() if done or ask_user() if you need input.';

function patch(run: RunRecord): Partial<RunRecord> {
  return {
    messages: run.messages,
    summary: run.summary,
    scratchpad: run.scratchpad,
    summary_until: run.summary_until,
    pending_request: run.pending_request,
    result_summary: run.result_summary,
    error: run.error,
    step_count: run.step_count,
    tokens_used: run.tokens_used,
    no_tool_streak: run.no_tool_streak,
    consecutive_errors: run.consecutive_errors,
    next_attempt_at: run.next_attempt_at,
    started_at: run.started_at,
    finished_at: run.finished_at,
  };
}

async function emit(rt: AgentRuntime, runId: string, type: EventType, payload: Record<string, unknown>) {
  const seq = await rt.store.nextEventSeq(runId);
  const redacted = redactValue(payload);
  const body = redacted && typeof redacted === 'object' && !Array.isArray(redacted) ? (redacted as Record<string, unknown>) : {};
  await rt.store.insertEvent({ run_id: runId, seq, type, payload: body });
}

function storedCall(call: ParsedToolCall): ToolCall {
  const name = modelToolName(registryToolName(call.name));
  const args = call.args && typeof call.args === 'object' ? call.args : {};
  return { id: call.id, name, arguments: JSON.stringify(args) };
}

function logStep(run: RunRecord, extra: Record<string, unknown>) {
  console.log(JSON.stringify({ run_id: run.id, step: run.step_count, ...extra }));
}

async function stillActive(rt: AgentRuntime, run: RunRecord): Promise<boolean> {
  const fresh = await rt.store.loadRun(run.id);
  return Boolean(fresh && fresh.status !== 'cancelled' && (fresh.status === 'running' || fresh.status === 'queued'));
}

export async function handleStep(
  input: { run_id: string; expected_step: number },
  rt: AgentRuntime
): Promise<StepOutcome> {
  const run = await rt.store.loadRun(input.run_id);
  if (!run) return { outcome: 'missing' };
  if (run.status === 'cancelled') return { outcome: 'cancelled' };
  if (run.status !== 'running' && run.status !== 'queued') return { outcome: 'ignored' };

  if (run.step_count !== input.expected_step) {
    if (run.status === 'running' && run.step_count === input.expected_step + 1) {
      await rt.enqueue({ run_id: run.id, expected_step: run.step_count, dedupNonce: 'next' });
    }
    return { outcome: 'duplicate' };
  }

  const now = rt.now();
  const profile = run.profile_snapshot;

  if (run.next_attempt_at && now.getTime() < Date.parse(run.next_attempt_at)) {
    const delaySeconds = Math.min(900, Math.max(1, Math.ceil((Date.parse(run.next_attempt_at) - now.getTime()) / 1000)));
    await rt.enqueue({
      run_id: run.id,
      expected_step: run.step_count,
      delaySeconds,
      dedupNonce: `wait:${run.next_attempt_at}`,
    });
    return { outcome: 'requeued', delaySeconds };
  }

  if (run.started_at && now.getTime() > Date.parse(run.started_at) + profile.max_runtime_min * 60_000) {
    return fail(rt, run, 'runtime_exceeded', now);
  }
  if (run.step_count >= profile.max_steps) return fail(rt, run, 'max_steps', now);
  if (run.tokens_used >= profile.token_budget) return fail(rt, run, 'token_budget', now);

  if (run.status === 'queued') {
    const started = run.started_at ?? now.toISOString();
    const moved = await rt.store.transition(run.id, ['queued'], 'running', { started_at: started });
    if (!moved) return { outcome: 'lost_race' };
    run.status = 'running';
    run.started_at = started;
    if (run.step_count === 0) await emit(rt, run.id, 'started', { command: run.command });
  }

  run.next_attempt_at = null;
  const tools = toolsForProfile(profile, rt.tools);
  const prompt = buildContext(run);
  const out = await rt.callModel(profile, prompt, toModelTools(tools));

  for (const fallback of out.fallbacks) {
    await emit(rt, run.id, 'provider_fallback', { ...fallback });
  }

  if (out.kind === 'rate_limited') {
    run.next_attempt_at = new Date(now.getTime() + out.delaySeconds * 1000).toISOString();
    const saved = await rt.store.save(run);
    if (!saved) return { outcome: 'lost_race' };
    await emit(rt, run.id, 'rate_limited', { delaySeconds: out.delaySeconds });
    await rt.enqueue({
      run_id: run.id,
      expected_step: run.step_count,
      delaySeconds: out.delaySeconds,
      dedupNonce: `wait:${run.next_attempt_at}`,
    });
    logStep(run, { outcome: 'requeued', delay_seconds: out.delaySeconds });
    return { outcome: 'requeued', delaySeconds: out.delaySeconds };
  }

  if (out.kind === 'provider_error') return fail(rt, run, out.message || 'provider_error', now);

  if (!(await stillActive(rt, run))) return { outcome: 'cancelled' };

  run.tokens_used += out.usage.tokens;
  const source = run.trigger === 'schedule' ? 'schedule' : 'agent';
  await rt.store.addTokens(out.usage.provider, source, out.usage.tokens);

  const assistant: ChatMessage = {
    role: 'assistant',
    content: out.text || null,
    tool_calls: out.toolCalls.slice(0, 2).map(storedCall),
  };
  run.messages.push(assistant);
  if (out.text) await emit(rt, run.id, 'thought', { text: preview(out.text, 500) });

  const calls = out.toolCalls.slice(0, 2);
  if (!calls.length) {
    run.no_tool_streak += 1;
    if (run.no_tool_streak >= 2) return fail(rt, run, 'model_not_using_tools', now);
    run.messages.push({ role: 'system', content: NUDGE });
    return continueRun(rt, run, []);
  }

  run.no_tool_streak = 0;
  const kept: ParsedToolCall[] = [];
  for (const call of calls) {
    kept.push(call);
    assistant.tool_calls = kept.map(storedCall);
    const name = registryToolName(call.name);
    const def = rt.tools.find((tool) => tool.name === name);
    const allowed = toolAllowed(profile, name);
    if (!def || !allowed) {
      await emit(rt, run.id, 'tool_blocked', { name, args: call.args });
      run.messages.push({ role: 'tool', tool_call_id: call.id, content: 'Tool not available.' });
      continue;
    }

    const parsed = def.schema.safeParse(call.args);
    if (!parsed.success) {
      const message = parsed.error.issues.map((issue) => issue.message).join('; ').slice(0, 300);
      run.messages.push({ role: 'tool', tool_call_id: call.id, content: `Invalid arguments: ${message}` });
      continue;
    }
    const args = parsed.data as Record<string, unknown>;

    if (name === 'ask_user') {
      const question = String(args.question);
      const options = Array.isArray(args.options) ? args.options.map(String) : undefined;
      run.pending_request = { kind: 'question', question, tool_call_id: call.id, ...(options?.length ? { options } : {}) };
      const moved = await rt.store.transition(run.id, ['running'], 'waiting_input', patch(run));
      if (!moved) return { outcome: 'lost_race' };
      await emit(rt, run.id, 'question', { question, options: options ?? [] });
      await safeNotify(rt, run, 'question', question);
      logStep(run, { outcome: 'waiting_input', provider: out.usage.provider, model: out.usage.model, tokens: out.usage.tokens });
      return { outcome: 'paused', status: 'waiting_input' };
    }

    if (name === 'finish') {
      return complete(rt, run, String(args.summary), call.id, out.usage, now);
    }

    if (name === 'update_scratchpad') {
      run.scratchpad = String(args.text).slice(0, 800);
      run.messages.push({ role: 'tool', tool_call_id: call.id, content: 'Scratchpad updated.' });
      continue;
    }

    if (profile.approval_required.includes(name)) {
      run.pending_request = {
        kind: 'approval',
        tool: name,
        args,
        tool_call_id: call.id,
        reason: def.risk === 'high' ? 'Outbound action' : 'This action needs approval',
      };
      const moved = await rt.store.transition(run.id, ['running'], 'waiting_approval', patch(run));
      if (!moved) return { outcome: 'lost_race' };
      await emit(rt, run.id, 'approval_request', { tool: name, reason: run.pending_request.reason });
      await safeNotify(rt, run, 'approval', `${name}: ${run.pending_request.reason}`);
      logStep(run, { outcome: 'waiting_approval', tool_names: [name] });
      return { outcome: 'paused', status: 'waiting_approval' };
    }

    await emit(rt, run.id, 'tool_call', { name, args });
    const text = await executeTool(rt, run, call.id, def, args);
    await emit(rt, run.id, 'tool_result', { name, preview: preview(text) });
    run.messages.push({ role: 'tool', tool_call_id: call.id, content: text });
    if (run.consecutive_errors >= 3) return fail(rt, run, 'tool_errors', now);
  }

  return continueRun(rt, run, calls.map((call) => registryToolName(call.name)), out.usage);
}

async function continueRun(
  rt: AgentRuntime,
  run: RunRecord,
  toolNames: string[],
  usage?: { provider: string; model: string; tokens: number; latencyMs: number }
): Promise<StepOutcome> {
  run.step_count += 1;
  run.next_attempt_at = null;
  const folded = summaryUpdate(run);
  if (folded) {
    run.summary = folded.summary;
    run.summary_until = folded.summary_until;
    await emit(rt, run.id, 'summary', { chars: run.summary.length });
  }
  const saved = await rt.store.save(run);
  if (!saved) return { outcome: 'lost_race' };
  await rt.enqueue({ run_id: run.id, expected_step: run.step_count, dedupNonce: 'next' });
  logStep(run, {
    outcome: 'continued',
    provider: usage?.provider,
    model: usage?.model,
    latency_ms: usage?.latencyMs,
    tokens: usage?.tokens,
    tool_names: toolNames,
  });
  return { outcome: 'continued', step: run.step_count };
}

async function complete(
  rt: AgentRuntime,
  run: RunRecord,
  summary: string,
  toolCallId: string,
  usage: { provider: string; model: string; tokens: number; latencyMs: number },
  now: Date
): Promise<StepOutcome> {
  run.messages.push({ role: 'tool', tool_call_id: toolCallId, content: 'Finished.' });
  run.result_summary = summary.slice(0, 4000);
  run.pending_request = null;
  run.finished_at = now.toISOString();
  run.error = null;
  const moved = await rt.store.transition(run.id, ['running'], 'done', patch(run));
  if (!moved) return { outcome: 'lost_race' };
  await emit(rt, run.id, 'finished', { summary: preview(summary, 500) });
  await safeNotify(rt, run, 'done', summary);
  logStep(run, { outcome: 'done', provider: usage.provider, model: usage.model, latency_ms: usage.latencyMs, tokens: usage.tokens });
  return { outcome: 'done' };
}

async function fail(rt: AgentRuntime, run: RunRecord, code: string, now: Date): Promise<StepOutcome> {
  const error = code.replace(/\s+/g, ' ').trim().slice(0, 500);
  run.error = error;
  run.pending_request = null;
  run.finished_at = now.toISOString();
  const from = run.status === 'queued' ? (['queued'] as const) : (['queued', 'running'] as const);
  const moved = await rt.store.transition(run.id, [...from], 'failed', patch(run));
  if (!moved) return { outcome: 'lost_race' };
  await emit(rt, run.id, 'failed', { error });
  await safeNotify(rt, run, 'failed', error);
  logStep(run, { outcome: 'failed', error });
  return { outcome: 'failed', error };
}

async function safeNotify(rt: AgentRuntime, run: RunRecord, kind: 'question' | 'approval' | 'done' | 'failed', text: string) {
  try {
    await rt.notify(run.user_id, run.id, kind, text);
  } catch (err) {
    console.error('[agent] push failed', err instanceof Error ? err.message : err);
  }
}

