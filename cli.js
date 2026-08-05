#!/usr/bin/env node
require('dotenv').config();

const { Command } = require('commander');
const { run } = require('./src/core/taskEngine');
const { formatResult: formatUpdate } = require('./src/tasks/jiraUpdate');
const { formatResult: formatMyIssues } = require('./src/tasks/jiraMyIssues');
const { formatResult: formatWhoami } = require('./src/tasks/jiraWhoami');
const { formatResult: formatCreate } = require('./src/tasks/jiraCreate');
const {
  formatListResult: formatListComments,
  formatDeleteResult: formatDeleteComment,
} = require('./src/tasks/jiraComments');
const { formatResult: formatGhSearchRepos } = require('./src/tasks/githubSearchRepos');
const { formatResult: formatGhListRepos } = require('./src/tasks/githubListRepos');
const { formatResult: formatGhListTags } = require('./src/tasks/githubListTags');
const { formatResult: formatGhCreateTag } = require('./src/tasks/githubCreateTag');
const { formatResult: formatGhSearchPrs } = require('./src/tasks/githubSearchPrs');
const { formatResult: formatGhGetPr } = require('./src/tasks/githubGetPr');
const {
  formatResult: formatJiraActivity,
  formatFullReport: formatJiraActivityFull,
} = require('./src/tasks/jiraMonthlyActivity');
const {
  formatResult: formatGhActivity,
  formatFullReport: formatGhActivityFull,
} = require('./src/tasks/githubMonthlyActivity');

const program = new Command();

program
  .name('cli')
  .description('Run local task automation (bypasses Discord)')
  .version('1.0.0');

program
  .command('jira-update')
  .description('Update a Jira issue (status, description, and/or comment)')
  .requiredOption('--issue <key>', 'Jira issue key (e.g. PROJ-123)')
  .option('--status <name>', 'Target status / transition name')
  .option('--description <text>', 'Replace description (markdown)')
  .option('--comment <text>', 'Comment to add on the issue')
  .action(async (opts) => {
    try {
      const result = await run('jira-update', {
        issue: opts.issue,
        status: opts.status,
        description: opts.description,
        comment: opts.comment,
      });
      console.log(formatUpdate(result));
    } catch (err) {
      console.error(err.message || err);
      process.exitCode = 1;
    }
  });

program
  .command('jira-create')
  .description('Create a Jira issue (assigns to you by default)')
  .requiredOption('--project <key>', 'Project key (e.g. P25)')
  .requiredOption('--summary <text>', 'Issue summary')
  .option('--type <name>', 'Issue type name', 'Task')
  .option('--description <text>', 'Optional description (markdown)')
  .option('--assign-me', 'Assign to auth user (default)')
  .option('--no-assign-me', 'Do not assign the issue')
  .action(async (opts) => {
    try {
      const result = await run('jira-create', {
        project: opts.project,
        summary: opts.summary,
        type: opts.type,
        description: opts.description,
        assignToMe: opts.assignMe !== false,
      });
      console.log(formatCreate(result));
    } catch (err) {
      console.error(err.message || err);
      process.exitCode = 1;
    }
  });

program
  .command('jira-list-comments')
  .description('List comments on a Jira issue')
  .requiredOption('--issue <key>', 'Jira issue key')
  .option('--max <n>', 'Max comments (default 20)', '20')
  .action(async (opts) => {
    try {
      const result = await run('jira-list-comments', {
        issue: opts.issue,
        max: opts.max,
      });
      console.log(formatListComments(result));
    } catch (err) {
      console.error(err.message || err);
      process.exitCode = 1;
    }
  });

program
  .command('jira-delete-comment')
  .description('Delete a comment by id, or the last comment')
  .requiredOption('--issue <key>', 'Jira issue key')
  .option('--comment-id <id>', 'Comment id to delete')
  .option('--last', 'Delete the most recent comment')
  .action(async (opts) => {
    try {
      const result = await run('jira-delete-comment', {
        issue: opts.issue,
        commentId: opts.commentId,
        deleteLast: Boolean(opts.last),
      });
      console.log(formatDeleteComment(result));
    } catch (err) {
      console.error(err.message || err);
      process.exitCode = 1;
    }
  });

program
  .command('jira-whoami')
  .description('Verify Jira API auth and print the authenticated user profile')
  .action(async () => {
    try {
      const result = await run('jira-whoami');
      console.log(formatWhoami(result));
    } catch (err) {
      console.error(err.message || err);
      process.exitCode = 1;
    }
  });

program
  .command('jira-my-issues')
  .description('List Jira issues assigned to you (default: unresolved)')
  .option('--max <n>', 'Max issues to return (default 25, max 50)', '25')
  .option('--status <name>', 'Filter by status name (use --status="In Progress")')
  .option('--query <text>', 'Topic/keyword filter (summary or body)')
  .option('--types <list>', 'Comma-separated issue types, e.g. Story,Epic')
  .option(
    '--resolution <mode>',
    'unresolved (default), resolved, or all',
    'unresolved'
  )
  .action(async (opts) => {
    try {
      const result = await run('jira-my-issues', {
        max: opts.max,
        status: opts.status,
        query: opts.query,
        types: opts.types,
        resolution: opts.resolution,
      });
      console.log(formatMyIssues(result));
    } catch (err) {
      console.error(err.message || err);
      process.exitCode = 1;
    }
  });

program
  .command('jira-monthly-activity')
  .description('Full Jira activity report for one calendar month')
  .option('--month <ref>', 'YYYY-MM, "July 2026", last month, or this month')
  .option('--year <year>', 'Year, if --month is a bare month name')
  .option('--no-detail', 'Skip changelog/comment/worklog timeline (faster)')
  .option('--max-issues <n>', 'Max issues to scan (default 100)')
  .option('--full', 'Print the full per-issue timeline instead of a summary')
  .action(async (opts) => {
    try {
      const result = await run('jira-monthly-activity', {
        month: opts.month,
        year: opts.year,
        detail: opts.detail,
        maxIssues: opts.maxIssues,
      });
      console.log(opts.full ? formatJiraActivityFull(result) : formatJiraActivity(result));
    } catch (err) {
      console.error(err.message || err);
      process.exitCode = 1;
    }
  });

program
  .command('github-monthly-activity')
  .description('Full GitHub activity report for one calendar month')
  .option('--month <ref>', 'YYYY-MM, "July 2026", last month, or this month')
  .option('--year <year>', 'Year, if --month is a bare month name')
  .option('--login <user>', 'Primary GitHub login (default: auth user)')
  .option('--logins <list>', 'Comma-separated extra logins (default: config)')
  .option('--aliases <list>', 'Comma-separated git name/email fragments (default: config)')
  .option('--exclude-owners <list>', 'Comma-separated repo owners to skip (default: config)')
  .option('--no-all-branches', 'Only look at default branches (skip the branch sweep)')
  .option('--full', 'Print the full per-repo timeline instead of a summary')
  .action(async (opts) => {
    try {
      const result = await run('github-monthly-activity', {
        month: opts.month,
        year: opts.year,
        login: opts.login,
        logins: opts.logins,
        aliases: opts.aliases,
        excludeOwners: opts.excludeOwners,
        // Only override the config default when --no-all-branches was passed.
        allBranches: opts.allBranches === false ? false : undefined,
      });
      console.log(opts.full ? formatGhActivityFull(result) : formatGhActivity(result));
    } catch (err) {
      console.error(err.message || err);
      process.exitCode = 1;
    }
  });

program
  .command('github-search-repos')
  .description('Search GitHub repositories')
  .requiredOption('--query <text>', 'Search query')
  .option('--max <n>', 'Max results (default 10)', '10')
  .option('--sort <field>', 'stars | forks | updated | help-wanted-issues')
  .option('--order <dir>', 'asc | desc')
  .action(async (opts) => {
    try {
      const result = await run('github-search-repos', {
        query: opts.query,
        max: opts.max,
        sort: opts.sort,
        order: opts.order,
      });
      console.log(formatGhSearchRepos(result));
    } catch (err) {
      console.error(err.message || err);
      process.exitCode = 1;
    }
  });

program
  .command('github-list-repos')
  .description('List GitHub repos for the auth user or an org')
  .option('--org <login>', 'Organization login')
  .option('--type <type>', 'Repo type filter', 'all')
  .option('--max <n>', 'Max repos (default 30)', '30')
  .option('--sort <field>', 'created | updated | pushed | full_name', 'updated')
  .action(async (opts) => {
    try {
      const result = await run('github-list-repos', {
        org: opts.org,
        type: opts.type,
        max: opts.max,
        sort: opts.sort,
      });
      console.log(formatGhListRepos(result));
    } catch (err) {
      console.error(err.message || err);
      process.exitCode = 1;
    }
  });

program
  .command('github-list-tags')
  .description('List (or check) tags on a GitHub repo')
  .requiredOption('--repo <owner/repo>', 'Repository (owner/repo)')
  .option('--tag <name>', 'Optional tag name to check')
  .option('--max <n>', 'Max tags (default 30)', '30')
  .action(async (opts) => {
    try {
      const result = await run('github-list-tags', {
        repo: opts.repo,
        tag: opts.tag,
        max: opts.max,
      });
      console.log(formatGhListTags(result));
    } catch (err) {
      console.error(err.message || err);
      process.exitCode = 1;
    }
  });

program
  .command('github-create-tag')
  .description('Create a git tag on a GitHub repo')
  .requiredOption('--repo <owner/repo>', 'Repository (owner/repo)')
  .requiredOption('--tag <name>', 'Tag name')
  .option('--sha <sha>', 'Commit SHA')
  .option('--branch <ref>', 'Branch or ref to tag (default HEAD)')
  .option('--message <text>', 'Annotation message (creates annotated tag)')
  .action(async (opts) => {
    try {
      const result = await run('github-create-tag', {
        repo: opts.repo,
        tag: opts.tag,
        sha: opts.sha,
        branch: opts.branch,
        message: opts.message,
      });
      console.log(formatGhCreateTag(result));
    } catch (err) {
      console.error(err.message || err);
      process.exitCode = 1;
    }
  });

program
  .command('github-search-prs')
  .description('Search pull requests, or list PRs for a repo')
  .option('--query <text>', 'Search query')
  .option('--repo <owner/repo>', 'Repository (owner/repo)')
  .option('--state <state>', 'open | closed | merged | all')
  .option('--max <n>', 'Max results (default 10)', '10')
  .action(async (opts) => {
    try {
      const result = await run('github-search-prs', {
        query: opts.query,
        repo: opts.repo,
        state: opts.state,
        max: opts.max,
      });
      console.log(formatGhSearchPrs(result));
    } catch (err) {
      console.error(err.message || err);
      process.exitCode = 1;
    }
  });

program
  .command('github-get-pr')
  .description('Read a single GitHub pull request')
  .requiredOption('--repo <owner/repo>', 'Repository (owner/repo)')
  .requiredOption('--number <n>', 'PR number')
  .action(async (opts) => {
    try {
      const result = await run('github-get-pr', {
        repo: opts.repo,
        number: opts.number,
      });
      console.log(formatGhGetPr(result));
    } catch (err) {
      console.error(err.message || err);
      process.exitCode = 1;
    }
  });

program
  .command('wf-release-start')
  .description('Start a WF release workflow (PR / Jira / branch / repo)')
  .option('--text <text>', 'Free-form start prompt')
  .option('--repo <owner/repo>', 'Repository')
  .option('--pr <n>', 'Pull request number')
  .option('--jira <key>', 'Development Jira key')
  .option('--branch <name>', 'Source branch')
  .option('--confirm', 'Execute pending mutating action immediately after start (if any)')
  .action(async (opts) => {
    try {
      const result = await run('wf-release-start', {
        text: opts.text,
        repo: opts.repo,
        pr: opts.pr,
        jira: opts.jira,
        branch: opts.branch,
      });
      console.log(result.text || JSON.stringify(result, null, 2));
      if (opts.confirm && result.pendingArgs) {
        const engine = require('./src/workflows/wfRelease/engine');
        const executed = await engine.executePending(result.pendingArgs);
        console.log('\n--- confirmed ---\n');
        console.log(executed.text);
      }
    } catch (err) {
      console.error(err.message || err);
      process.exitCode = 1;
    }
  });

program
  .command('wf-release-status')
  .description('Show WF release workflow status')
  .requiredOption('--id <workflowId>', 'Workflow id')
  .action(async (opts) => {
    try {
      const result = await run('wf-release-status', { id: opts.id });
      console.log(result.text || JSON.stringify(result, null, 2));
    } catch (err) {
      console.error(err.message || err);
      process.exitCode = 1;
    }
  });

program
  .command('wf-release-advance')
  .description('Advance a WF release workflow until the next pause')
  .requiredOption('--id <workflowId>', 'Workflow id')
  .option('--confirm', 'Execute pending mutating action if waiting for confirmation')
  .action(async (opts) => {
    try {
      const result = await run('wf-release-advance', { id: opts.id });
      console.log(result.text || JSON.stringify(result, null, 2));
      if (opts.confirm && result.pendingArgs) {
        const engine = require('./src/workflows/wfRelease/engine');
        const executed = await engine.executePending(result.pendingArgs);
        console.log('\n--- confirmed ---\n');
        console.log(executed.text);
      }
    } catch (err) {
      console.error(err.message || err);
      process.exitCode = 1;
    }
  });

program.parseAsync(process.argv).catch((err) => {
  console.error(err.message || err);
  process.exitCode = 1;
});
