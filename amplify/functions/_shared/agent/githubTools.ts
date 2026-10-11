import { z } from 'zod';
import githubCreateTagTask from '../../../../src/tasks/githubCreateTag.js';
import githubGetPrTask from '../../../../src/tasks/githubGetPr.js';
import githubIssues from '../../../../src/tasks/githubIssues.js';
import githubListReposTask from '../../../../src/tasks/githubListRepos.js';
import githubListTagsTask from '../../../../src/tasks/githubListTags.js';
import githubMonthlyActivityTask from '../../../../src/tasks/githubMonthlyActivity.js';
import repoInfo from '../../../../src/tasks/githubRepoInfo.js';
import githubSearchPrsTask from '../../../../src/tasks/githubSearchPrs.js';
import githubSearchReposTask from '../../../../src/tasks/githubSearchRepos.js';
import { runLocalTask } from '../../../../src/util/runLocalTask.js';
import type { ToolDef } from './types.js';

type TaskFn = (payload: Record<string, unknown>) => Promise<unknown>;
type FormatFn = (raw: unknown) => string;
type FormattedTask = TaskFn & { formatResult: FormatFn };

function asTask(mod: unknown): FormattedTask {
  return mod as FormattedTask;
}

const issues = githubIssues as {
  searchIssues: TaskFn;
  formatSearchIssues: FormatFn;
  getIssue: TaskFn;
  formatGetIssue: FormatFn;
  addComment: TaskFn;
  formatAddComment: FormatFn;
  createIssue: TaskFn;
  formatCreateIssue: FormatFn;
};

const repo = repoInfo as {
  getRepo: TaskFn;
  formatGetRepo: FormatFn;
  listBranches: TaskFn;
  formatListBranches: FormatFn;
  listCommits: TaskFn;
  formatListCommits: FormatFn;
  compare: TaskFn;
  formatCompare: FormatFn;
  getFile: TaskFn;
  formatGetFile: FormatFn;
};

function task(
  name: string,
  execute: TaskFn,
  format: FormatFn | undefined
): ToolDef['handler'] {
  return async (args) => {
    const out = await runLocalTask(name, execute, format, args);
    return { text: String(out.text ?? '') };
  };
}

const optStr = z.string().max(500).optional();
const optInt = z.coerce.number().int().min(1).max(100).optional();
const repoArg = z.string().min(1).max(400);

/** GitHub tools backed by GITHUB_TOKEN (same tasks as the chat client). */
export const GITHUB_TOOLS: ToolDef[] = [
  {
    name: 'github_search_repos',
    integration: 'github',
    access: 'read',
    risk: 'low',
    description: 'Search GitHub repositories by query (name, topic, language, user:, org:). For one known repo use github_get_repo.',
    schema: z.object({
      query: z.string().min(1).max(300),
      max: optInt,
      sort: optStr,
      order: z.enum(['asc', 'desc']).optional(),
    }),
    maxResultChars: 6000,
    handler: task('github-search-repos', asTask(githubSearchReposTask), asTask(githubSearchReposTask).formatResult),
  },
  {
    name: 'github_list_repos',
    integration: 'github',
    access: 'read',
    risk: 'low',
    description: 'List repositories for the authenticated user, or for an organization if org is set.',
    schema: z.object({
      org: optStr,
      type: optStr,
      max: optInt,
      sort: optStr,
    }),
    maxResultChars: 6000,
    handler: task('github-list-repos', asTask(githubListReposTask), asTask(githubListReposTask).formatResult),
  },
  {
    name: 'github_get_repo',
    integration: 'github',
    access: 'read',
    risk: 'low',
    description: 'Details for one repo: description, default branch, language, topics, last push; optional README excerpt.',
    schema: z.object({
      repo: repoArg,
      include_readme: z.boolean().optional(),
    }),
    maxResultChars: 8000,
    handler: task('github-get-repo', repo.getRepo, repo.formatGetRepo),
  },
  {
    name: 'github_list_tags',
    integration: 'github',
    access: 'read',
    risk: 'low',
    description: 'List tags on a repo. Optionally check whether a specific tag exists (tag=).',
    schema: z.object({
      repo: repoArg,
      owner: optStr,
      tag: optStr,
      max: optInt,
    }),
    maxResultChars: 4000,
    handler: task('github-list-tags', asTask(githubListTagsTask), asTask(githubListTagsTask).formatResult),
  },
  {
    name: 'github_list_branches',
    integration: 'github',
    access: 'read',
    risk: 'low',
    description: 'List branches on a repo, optionally filtered by a name fragment.',
    schema: z.object({
      repo: repoArg,
      filter: optStr,
      max: optInt,
    }),
    maxResultChars: 4000,
    handler: task('github-list-branches', repo.listBranches, repo.formatListBranches),
  },
  {
    name: 'github_list_commits',
    integration: 'github',
    access: 'read',
    risk: 'low',
    description: 'Recent commits on a branch/tag/SHA (default branch if omitted), optionally filtered by author, path, or date window.',
    schema: z.object({
      repo: repoArg,
      branch: optStr,
      author: optStr,
      path: optStr,
      since: optStr,
      until: optStr,
      max: optInt,
    }),
    maxResultChars: 6000,
    handler: task('github-list-commits', repo.listCommits, repo.formatListCommits),
  },
  {
    name: 'github_compare',
    integration: 'github',
    access: 'read',
    risk: 'low',
    description:
      'Compare two refs (base...head): commits, changed files, ahead/behind, and Jira issues referenced in commit messages. head defaults to the default branch.',
    schema: z.object({
      repo: repoArg,
      base: z.string().min(1).max(200),
      head: optStr,
    }),
    maxResultChars: 8000,
    handler: task('github-compare', repo.compare, repo.formatCompare),
  },
  {
    name: 'github_get_file',
    integration: 'github',
    access: 'read',
    risk: 'low',
    description: 'Read a file (or list a directory) from a repo at a ref.',
    schema: z.object({
      repo: repoArg,
      path: z.string().max(500).optional(),
      ref: optStr,
    }),
    maxResultChars: 10000,
    handler: task('github-get-file', repo.getFile, repo.formatGetFile),
  },
  {
    name: 'github_search_prs',
    integration: 'github',
    access: 'read',
    risk: 'low',
    description:
      'Search pull requests, or list PRs for a repo when only repo is given. Syntax: repo:, org:, is:open, author:@me, review-requested:@me, involves:@me, label:, head:<branch>.',
    schema: z.object({
      query: optStr,
      repo: optStr,
      state: z.union([z.enum(['open', 'closed', 'merged', 'all']), z.string().max(20)]).optional(),
      max: optInt,
      sort: optStr,
      order: z.enum(['asc', 'desc']).optional(),
    }),
    maxResultChars: 8000,
    handler: task('github-search-prs', asTask(githubSearchPrsTask), asTask(githubSearchPrsTask).formatResult),
  },
  {
    name: 'github_get_pr',
    integration: 'github',
    access: 'read',
    risk: 'low',
    description:
      'Read a single pull request: title, body, state, diff stats, CI checks, reviews, and referenced Jira issues. Prefer this for github.com/…/pull/N links.',
    schema: z.object({
      repo: repoArg,
      number: z.coerce.number().int().positive().optional(),
      owner: optStr,
      include: optStr,
    }),
    maxResultChars: 12000,
    handler: task('github-get-pr', asTask(githubGetPrTask), asTask(githubGetPrTask).formatResult),
  },
  {
    name: 'github_search_issues',
    integration: 'github',
    access: 'read',
    risk: 'low',
    description: 'Search GitHub issues (not PRs). Syntax: repo:, org:, is:open, label:, assignee:@me, author:.',
    schema: z.object({
      query: optStr,
      repo: optStr,
      state: z.enum(['open', 'closed', 'all']).optional(),
      max: optInt,
    }),
    maxResultChars: 6000,
    handler: task('github-search-issues', issues.searchIssues, issues.formatSearchIssues),
  },
  {
    name: 'github_get_issue',
    integration: 'github',
    access: 'read',
    risk: 'low',
    description: 'Read one GitHub issue by repo and number, with recent comments.',
    schema: z.object({
      repo: repoArg,
      number: z.coerce.number().int().positive().optional(),
    }),
    maxResultChars: 8000,
    handler: task('github-get-issue', issues.getIssue, issues.formatGetIssue),
  },
  {
    name: 'github_monthly_activity',
    integration: 'github',
    access: 'read',
    risk: 'low',
    description:
      'GitHub activity for one calendar month: commits, PRs, issues, and comments grouped by repository.',
    schema: z.object({
      month: optStr,
      year: z.coerce.number().int().optional(),
      login: optStr,
      logins: optStr,
      aliases: optStr,
    }),
    maxResultChars: 12000,
    handler: task(
      'github-monthly-activity',
      asTask(githubMonthlyActivityTask),
      asTask(githubMonthlyActivityTask).formatResult
    ),
  },
  {
    name: 'github_create_tag',
    integration: 'github',
    access: 'write',
    risk: 'high',
    egress: true,
    description: 'Create a git tag on a repo at a commit SHA or branch (default HEAD/default branch). Annotated if message is set.',
    schema: z.object({
      repo: repoArg,
      tag: z.string().min(1).max(200),
      sha: optStr,
      branch: optStr,
      message: z.string().max(2000).optional(),
      owner: optStr,
    }),
    maxResultChars: 2000,
    handler: task('github-create-tag', asTask(githubCreateTagTask), asTask(githubCreateTagTask).formatResult),
  },
  {
    name: 'github_add_comment',
    integration: 'github',
    access: 'write',
    risk: 'high',
    egress: true,
    description: 'Post a comment on a GitHub PR or issue conversation (markdown).',
    schema: z.object({
      repo: repoArg,
      number: z.coerce.number().int().positive(),
      body: z.string().min(1).max(8000),
    }),
    maxResultChars: 2000,
    handler: task('github-add-comment', issues.addComment, issues.formatAddComment),
  },
  {
    name: 'github_create_issue',
    integration: 'github',
    access: 'write',
    risk: 'high',
    egress: true,
    description: 'Open a GitHub issue in a repo.',
    schema: z.object({
      repo: repoArg,
      title: z.string().min(1).max(300),
      body: z.string().max(8000).optional(),
      labels: optStr,
      assignees: optStr,
    }),
    maxResultChars: 2000,
    handler: task('github-create-issue', issues.createIssue, issues.formatCreateIssue),
  },
];
