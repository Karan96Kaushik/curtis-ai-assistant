#!/usr/bin/env node
/**
 * Jira activity report for any calendar month.
 *
 * Thin wrapper over the `jira-monthly-activity` task (same code path the
 * Discord agent and CLI use), plus a full timeline dump written to logs/.
 *
 * Run:
 *   npm run jira:activity -- 2026-07
 *   npm run jira:activity -- July 2026
 *   npm run jira:activity -- --last-month
 *   npm run jira:activity              # current month
 *
 * Options: --json  --no-detail  --help
 */

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { run } = require('../src/core/taskEngine');
const { parseMonthArgs, printMonthUsage } = require('../src/util/monthRange');
const { formatFullReport } = require('../src/tasks/jiraMonthlyActivity');

const LOG_DIR = path.join(__dirname, '..', 'logs');
const USAGE_COMMAND = 'npm run jira:activity --';

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    printMonthUsage(USAGE_COMMAND);
    console.error('Options: --json  --no-detail  --help');
    return;
  }

  let month;
  try {
    month = parseMonthArgs(argv);
  } catch (err) {
    console.error(`FAIL ${err.message}`);
    printMonthUsage(USAGE_COMMAND);
    process.exitCode = 1;
    return;
  }

  const asJson = month.rest.includes('--json');
  const detail = !month.rest.includes('--no-detail');

  const result = await run('jira-monthly-activity', {
    month: month.slug,
    detail,
  });

  const out = asJson ? JSON.stringify(result, null, 2) : formatFullReport(result);
  console.log(out);

  const logFile = path.join(LOG_DIR, `jira-${result.slug}-activity.log`);
  fs.mkdirSync(LOG_DIR, { recursive: true });
  fs.writeFileSync(logFile, `${out}\n`, 'utf8');
  console.error(`\nWrote ${logFile}`);
}

main().catch((err) => {
  console.error('FAIL', err.message || err);
  process.exitCode = 1;
});
