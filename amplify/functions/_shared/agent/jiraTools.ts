import { z } from 'zod';
import jiraComments from '../../../../src/tasks/jiraComments.js';
import jiraCreateTask from '../../../../src/tasks/jiraCreate.js';
import jiraGetIssueTask from '../../../../src/tasks/jiraGetIssue.js';
import jiraLookups from '../../../../src/tasks/jiraLookups.js';
import jiraMonthlyActivityTask from '../../../../src/tasks/jiraMonthlyActivity.js';
import jiraMyIssuesTask from '../../../../src/tasks/jiraMyIssues.js';
import jiraSearchTask from '../../../../src/tasks/jiraSearch.js';
import jiraUpdateTask from '../../../../src/tasks/jiraUpdate.js';
import jiraWhoamiTask from '../../../../src/tasks/jiraWhoami.js';
import jiraWrites from '../../../../src/tasks/jiraWrites.js';
import { extractIssueKeys } from '../../../../src/util/jiraKeys.js';
import { runLocalTask } from '../../../../src/util/runLocalTask.js';
import type { ToolDef } from './types.js';

type TaskFn = (payload: Record<string, unknown>) => Promise<unknown>;
type FormatFn = (raw: unknown) => string;
type FormattedTask = TaskFn & { formatResult: FormatFn };

function asTask(mod: unknown): FormattedTask {
  return mod as FormattedTask;
}

const comments = jiraComments as {
  list: TaskFn;
  formatListResult: FormatFn;
  delete: TaskFn;
  formatDeleteResult: FormatFn;
};

const lookups = jiraLookups as {
  transitions: TaskFn;
  formatTransitions: FormatFn;
  findUser: TaskFn;
  formatFindUser: FormatFn;
  listProjects: TaskFn;
  formatListProjects: FormatFn;
};

const writes = jiraWrites as {
  linkIssues: TaskFn;
  formatLinkIssues: FormatFn;
  logWork: TaskFn;
  formatLogWork: FormatFn;
};

function task(name: string, execute: TaskFn, format: FormatFn | undefined): ToolDef['handler'] {
  return async (args) => {
    const out = await runLocalTask(name, execute, format, args);
    return { text: String(out.text ?? '') };
  };
}

const optStr = z.string().max(4000).optional();
const optInt = z.coerce.number().int().min(1).max(200).optional();
const issueKey = z.string().min(1).max(40);
const boolish = z.union([z.boolean(), z.string().max(20)]).optional();

/** Jira tools backed by JIRA_* env (same tasks as the chat client). */
export const JIRA_TOOLS: ToolDef[] = [
  {
    name: 'jira_get_issue',
    integration: 'jira',
    access: 'read',
    risk: 'low',
    description:
      'Fetch ONE issue by exact key (e.g. P25-3488): summary, status, description, parent, subtasks, linked issues, fix versions, and GitHub PRs that mention the key.',
    schema: z.object({
      issue: issueKey,
      include_comments: boolish,
      max_comments: optInt,
      include_github: boolish,
    }),
    maxResultChars: 12000,
    handler: task('jira-get-issue', asTask(jiraGetIssueTask), asTask(jiraGetIssueTask).formatResult),
  },
  {
    name: 'jira_my_issues',
    integration: 'jira',
    access: 'read',
    risk: 'low',
    description:
      'List issues assigned to the auth user. Default resolution=unresolved. Do NOT pass an issue key as query — use jira_get_issue instead.',
    schema: z.object({
      max: optInt,
      status: optStr,
      query: optStr,
      types: optStr,
      resolution: z.enum(['unresolved', 'resolved', 'all']).optional(),
    }),
    maxResultChars: 8000,
    handler: async (args) => {
      const query = typeof args.query === 'string' ? args.query : '';
      const key = extractIssueKeys(query)[0];
      if (key && !/\s/.test(query.trim())) {
        const out = await runLocalTask(
          'jira-get-issue',
          asTask(jiraGetIssueTask),
          asTask(jiraGetIssueTask).formatResult,
          { issue: key, include_comments: true }
        );
        return { text: String(out.text ?? '') };
      }
      const out = await runLocalTask(
        'jira-my-issues',
        asTask(jiraMyIssuesTask),
        asTask(jiraMyIssuesTask).formatResult,
        args
      );
      return { text: String(out.text ?? '') };
    },
  },
  {
    name: 'jira_search',
    integration: 'jira',
    access: 'read',
    risk: 'low',
    description:
      'Search ANY issues with JQL — sprints, teammates, unassigned work, projects, epics. Always add ORDER BY (e.g. ORDER BY updated DESC).',
    schema: z.object({
      jql: z.string().min(1).max(2000),
      max: optInt,
      next_page_token: optStr,
    }),
    maxResultChars: 8000,
    handler: task('jira-search', asTask(jiraSearchTask), asTask(jiraSearchTask).formatResult),
  },
  {
    name: 'jira_monthly_activity',
    integration: 'jira',
    access: 'read',
    risk: 'low',
    description:
      'Jira activity report for the auth user over ONE calendar month: issues created, transitioned, commented on, edited, or logged work against.',
    schema: z.object({
      month: optStr,
      year: z.coerce.number().int().optional(),
      detail: boolish,
      max_issues: optInt,
    }),
    maxResultChars: 12000,
    handler: async (args) => {
      const out = await runLocalTask(
        'jira-monthly-activity',
        asTask(jiraMonthlyActivityTask),
        asTask(jiraMonthlyActivityTask).formatResult,
        {
          month: args.month,
          year: args.year,
          detail: args.detail,
          maxIssues: args.max_issues,
        }
      );
      return { text: String(out.text ?? '') };
    },
  },
  {
    name: 'jira_get_transitions',
    integration: 'jira',
    access: 'read',
    risk: 'low',
    description: 'List the workflow transitions currently available on an issue (valid values for jira_update status).',
    schema: z.object({ issue: issueKey }),
    maxResultChars: 3000,
    handler: task('jira-get-transitions', lookups.transitions, lookups.formatTransitions),
  },
  {
    name: 'jira_find_user',
    integration: 'jira',
    access: 'read',
    risk: 'low',
    description: 'Find Jira users by name or email fragment (accountId, display name).',
    schema: z.object({
      query: z.string().min(1).max(200),
      max: optInt,
    }),
    maxResultChars: 3000,
    handler: task('jira-find-user', lookups.findUser, lookups.formatFindUser),
  },
  {
    name: 'jira_list_projects',
    integration: 'jira',
    access: 'read',
    risk: 'low',
    description: 'List Jira projects (key + name), or — with project set — the issue types you can create in that project.',
    schema: z.object({
      query: optStr,
      project: optStr,
    }),
    maxResultChars: 4000,
    handler: task('jira-list-projects', lookups.listProjects, lookups.formatListProjects),
  },
  {
    name: 'jira_list_comments',
    integration: 'jira',
    access: 'read',
    risk: 'low',
    description: 'List comments on a Jira issue.',
    schema: z.object({
      issue: issueKey,
      max: optInt,
    }),
    maxResultChars: 6000,
    handler: task('jira-list-comments', comments.list, comments.formatListResult),
  },
  {
    name: 'jira_whoami',
    integration: 'jira',
    access: 'read',
    risk: 'low',
    description: 'Show which Jira account is authenticated.',
    schema: z.object({}),
    maxResultChars: 1000,
    handler: task('jira-whoami', asTask(jiraWhoamiTask), asTask(jiraWhoamiTask).formatResult),
  },
  {
    name: 'jira_update',
    integration: 'jira',
    access: 'write',
    risk: 'high',
    egress: true,
    description:
      'Update a Jira issue: status (transition or target status), comment, description (markdown, replaces), summary, assignee, priority, labels.',
    schema: z.object({
      issue: issueKey,
      status: optStr,
      description: z.string().max(20000).optional(),
      comment: z.string().max(8000).optional(),
      summary: optStr,
      assignee: optStr,
      priority: optStr,
      add_labels: optStr,
      remove_labels: optStr,
    }),
    maxResultChars: 4000,
    handler: task('jira-update', asTask(jiraUpdateTask), asTask(jiraUpdateTask).formatResult),
  },
  {
    name: 'jira_create',
    integration: 'jira',
    access: 'write',
    risk: 'high',
    egress: true,
    description: 'Create a new Jira issue (optionally a sub-task/child via parent).',
    schema: z.object({
      project: z.string().min(1).max(40),
      summary: z.string().min(1).max(500),
      type: optStr,
      description: z.string().max(20000).optional(),
      assign_me: boolish,
      parent: optStr,
      labels: optStr,
      priority: optStr,
      components: optStr,
    }),
    maxResultChars: 4000,
    handler: async (args) => {
      const out = await runLocalTask(
        'jira-create',
        asTask(jiraCreateTask),
        asTask(jiraCreateTask).formatResult,
        {
          project: args.project,
          summary: args.summary,
          type: args.type,
          description: args.description,
          assignToMe: args.assign_me,
          parent: args.parent,
          labels: args.labels,
          priority: args.priority,
          components: args.components,
        }
      );
      return { text: String(out.text ?? '') };
    },
  },
  {
    name: 'jira_link_issues',
    integration: 'jira',
    access: 'write',
    risk: 'medium',
    egress: true,
    description:
      'Link two issues. Read as "<from> <type> <to>": "P25-1 blocks P25-2" → from=P25-1, to=P25-2, type=Blocks.',
    schema: z.object({
      from: issueKey,
      to: issueKey,
      type: optStr,
    }),
    maxResultChars: 2000,
    handler: task('jira-link-issues', writes.linkIssues, writes.formatLinkIssues),
  },
  {
    name: 'jira_log_work',
    integration: 'jira',
    access: 'write',
    risk: 'medium',
    egress: true,
    description: 'Log time spent on an issue (worklog).',
    schema: z.object({
      issue: issueKey,
      time_spent: z.string().min(1).max(40),
      started: optStr,
      comment: z.string().max(4000).optional(),
    }),
    maxResultChars: 2000,
    handler: task('jira-log-work', writes.logWork, writes.formatLogWork),
  },
  {
    name: 'jira_delete_comment',
    integration: 'jira',
    access: 'write',
    risk: 'high',
    egress: true,
    description: 'Delete a comment.',
    schema: z.object({
      issue: issueKey,
      comment_id: optStr,
      delete_last: boolish,
    }),
    maxResultChars: 2000,
    handler: async (args) => {
      const out = await runLocalTask(
        'jira-delete-comment',
        comments.delete,
        comments.formatDeleteResult,
        {
          issue: args.issue,
          commentId: args.comment_id,
          deleteLast: args.delete_last,
        }
      );
      return { text: String(out.text ?? '') };
    },
  },
];
