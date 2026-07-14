#!/usr/bin/env node
require('dotenv').config();

const { Command } = require('commander');
const { run } = require('./src/core/taskEngine');
const { formatResult: formatUpdate } = require('./src/tasks/jiraUpdate');
const { formatResult: formatMyIssues } = require('./src/tasks/jiraMyIssues');
const { formatResult: formatWhoami } = require('./src/tasks/jiraWhoami');
const { formatResult: formatCreate } = require('./src/tasks/jiraCreate');

const program = new Command();

program
  .name('cli')
  .description('Run local task automation (bypasses Discord)')
  .version('1.0.0');

program
  .command('jira-update')
  .description('Update a Jira issue (status transition and/or comment)')
  .requiredOption('--issue <key>', 'Jira issue key (e.g. PROJ-123)')
  .option('--status <name>', 'Target status / transition name')
  .option('--comment <text>', 'Comment to add on the issue')
  .action(async (opts) => {
    try {
      const result = await run('jira-update', {
        issue: opts.issue,
        status: opts.status,
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
  .description('Create a Jira issue')
  .requiredOption('--project <key>', 'Project key (e.g. AATP)')
  .requiredOption('--summary <text>', 'Issue summary')
  .option('--type <name>', 'Issue type name', 'Task')
  .option('--description <text>', 'Optional description')
  .option('--assign-me', 'Assign the issue to the authenticated user')
  .action(async (opts) => {
    try {
      const result = await run('jira-create', {
        project: opts.project,
        summary: opts.summary,
        type: opts.type,
        description: opts.description,
        assignToMe: opts.assignMe,
      });
      console.log(formatCreate(result));
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
  .description('List unresolved Jira issues assigned to you')
  .option('--max <n>', 'Max issues to return (default 25, max 50)', '25')
  .option('--status <name>', 'Filter by status name (use --status="In Progress")')
  .action(async (opts) => {
    try {
      const result = await run('jira-my-issues', {
        max: opts.max,
        status: opts.status,
      });
      console.log(formatMyIssues(result));
    } catch (err) {
      console.error(err.message || err);
      process.exitCode = 1;
    }
  });

program.parseAsync(process.argv).catch((err) => {
  console.error(err.message || err);
  process.exitCode = 1;
});
