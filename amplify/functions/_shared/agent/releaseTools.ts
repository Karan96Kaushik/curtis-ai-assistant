import { z } from 'zod';
import engine from '../../../../src/workflows/wfRelease/engine.js';
import { formatDraft } from '../../../../src/workflows/wfRelease/draft.js';
import type { ToolDef } from './types.js';

type ReleaseOutcome = {
  text?: string;
  result?: { pause?: string | null; pendingArgs?: Record<string, unknown> | null };
  ctx?: { workflow?: { id?: string; state?: string } };
};

const releaseEngine = engine as {
  start: (input: Record<string, unknown>) => Promise<ReleaseOutcome>;
  load: (id: string) => Promise<{
    workflow?: { id?: string; state?: string; mode?: string };
  }>;
  reviseDraft: (id: string, args: Record<string, unknown>) => Promise<ReleaseOutcome>;
  approveDraft: (id: string, opts: { runAll?: boolean }) => Promise<ReleaseOutcome>;
  skipStep: (id: string) => Promise<ReleaseOutcome>;
  status: (id: string) => Promise<ReleaseOutcome>;
  advance: (id: string) => Promise<ReleaseOutcome>;
  executePending: (args: Record<string, unknown>) => Promise<ReleaseOutcome>;
};

const formatDraftFn = formatDraft as (ctx: unknown) => string;

function formatOutcome(outcome: ReleaseOutcome): { text: string } {
  let text = String(outcome?.text || 'OK');
  const id = outcome?.ctx?.workflow?.id;
  const state = outcome?.ctx?.workflow?.state;
  if (id || state) {
    text += `\n\n[workflow ${id ?? '?'} state=${state ?? '?'}]`;
  }
  const pendingArgs = outcome?.result?.pendingArgs;
  if (outcome?.result?.pause === 'confirmation' && pendingArgs) {
    text +=
      '\n\nStaged write ready. Call wf_release_execute_pending with these args' +
      ' (profile approval may be required before it runs):\n' +
      JSON.stringify(pendingArgs);
  }
  return { text };
}

const optStr = z.string().max(8000).optional();
const optBool = z.boolean().optional();
const optInt = z.coerce.number().int().positive().optional();
const workflowId = z.string().min(1).max(80);

const startArgs = z.object({
  text: optStr,
  repo: optStr,
  pr: optInt,
  jira: optStr,
  branch: optStr,
  skip_tag: optBool,
  id: optStr,
});

/** Release workflow tools (same engine as chat; state under WF_RELEASE_DIR). */
export const RELEASE_TOOLS: ToolDef[] = [
  {
    name: 'wf_release_start',
    integration: 'release',
    access: 'read',
    risk: 'low',
    description:
      'Start a release workflow from a PR, Jira key, branch, and/or repository. Builds a complete draft first. No GitHub/Jira writes until the draft is approved.',
    schema: startArgs,
    maxResultChars: 16000,
    handler: async (args) => formatOutcome(await releaseEngine.start(args)),
  },
  {
    name: 'wf_release_draft',
    integration: 'release',
    access: 'read',
    risk: 'low',
    description:
      'Build a complete release draft (reads GitHub/Jira). Pass id to re-show an existing draft. Does not write until approved.',
    schema: startArgs,
    maxResultChars: 16000,
    handler: async (args) => {
      const id = typeof args.id === 'string' ? args.id.trim() : '';
      if (id) {
        const loaded = await releaseEngine.load(id);
        if (loaded.workflow?.mode === 'draft' && loaded.workflow.state === 'DRAFT_REVIEW') {
          return formatOutcome({
            ctx: loaded,
            text: formatDraftFn(loaded),
            result: { pause: 'draft' },
          });
        }
      }
      return formatOutcome(await releaseEngine.start(args));
    },
  },
  {
    name: 'wf_release_revise_draft',
    integration: 'release',
    access: 'read',
    risk: 'low',
    description:
      'Edit a release draft and re-show it. Covers tag, QA/Deploy tickets, and form fields. Never writes to GitHub/Jira.',
    schema: z
      .object({
        id: workflowId,
        tag: optStr,
        tag_sha: optStr,
        message: optStr,
        skip_tag: optBool,
        qa_summary: optStr,
        qa_project: optStr,
        qa_issue_type: optStr,
        qa_parent: optStr,
        qa_description: optStr,
        skip_qa: optBool,
        deploy_summary: optStr,
        deploy_project: optStr,
        deploy_issue_type: optStr,
        deploy_parent: optStr,
        deploy_description: optStr,
        skip_deploy: optBool,
        summary: optStr,
        developer: optStr,
        component: optStr,
        submission_date: optStr,
        previous_version: optStr,
        release_summary: optStr,
        technical_summary: optStr,
        feature_group: optStr,
        software_stack_changes: optStr,
        snyk_security: optStr,
        rollback_plan: optStr,
        risk: optStr,
        security: optStr,
        customer_impact: optStr,
        monitoring_owner: optStr,
        github_link: optStr,
        regenerate_notes: optStr,
      })
      .passthrough(),
    maxResultChars: 16000,
    handler: async (args) => {
      const id = String(args.id);
      return formatOutcome(await releaseEngine.reviseDraft(id, args));
    },
  },
  {
    name: 'wf_release_approve_draft',
    integration: 'release',
    access: 'write',
    risk: 'medium',
    description:
      'Approve the release draft and stage the first write (or all remaining with run_all=true). Then call wf_release_execute_pending after user approval.',
    schema: z.object({
      id: workflowId,
      run_all: optBool,
    }),
    maxResultChars: 8000,
    handler: async (args) =>
      formatOutcome(await releaseEngine.approveDraft(String(args.id), { runAll: args.run_all === true })),
  },
  {
    name: 'wf_release_skip_step',
    integration: 'release',
    access: 'write',
    risk: 'medium',
    description: 'Skip the release write waiting for confirmation and stage the next one.',
    schema: z.object({ id: workflowId }),
    maxResultChars: 8000,
    handler: async (args) => formatOutcome(await releaseEngine.skipStep(String(args.id))),
  },
  {
    name: 'wf_release_status',
    integration: 'release',
    access: 'read',
    risk: 'low',
    description: 'Show status of a release workflow by id.',
    schema: z.object({ id: workflowId }),
    maxResultChars: 8000,
    handler: async (args) => formatOutcome(await releaseEngine.status(String(args.id))),
  },
  {
    name: 'wf_release_advance',
    integration: 'release',
    access: 'write',
    risk: 'medium',
    description: 'Resume a paused release workflow to the next pause.',
    schema: z.object({ id: workflowId }),
    maxResultChars: 8000,
    handler: async (args) => formatOutcome(await releaseEngine.advance(String(args.id))),
  },
  {
    name: 'wf_release_execute_pending',
    integration: 'release',
    access: 'write',
    risk: 'high',
    egress: true,
    description:
      'Execute the staged release write(s): one step (execute_step) or every remaining step (execute_draft). Use after wf_release_approve_draft.',
    schema: z
      .object({
        workflowId: workflowId,
        type: z.enum(['execute_step', 'execute_draft']),
        payload: z.record(z.string(), z.unknown()).optional(),
      })
      .passthrough(),
    maxResultChars: 12000,
    handler: async (args) => formatOutcome(await releaseEngine.executePending(args)),
  },
];
