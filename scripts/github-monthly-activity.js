#!/usr/bin/env node
/**
 * GitHub activity report for any calendar month.
 *
 * Thin wrapper over the `github-monthly-activity` task (same code path the
 * Discord agent and CLI use), plus a full timeline dump written to logs/.
 *
 * Run:
 *   npm run github:activity -- 2026-07
 *   npm run github:activity -- July 2026
 *   npm run github:activity -- --last-month
 *   npm run github:activity              # current month
 *
 * Options: --json  --login <user>  --logins <list>  --aliases <list>
 *          --exclude-owners <list>  --default-branch-only  --help
 */

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { run } = require('../src/core/taskEngine');
const { parseMonthArgs, printMonthUsage } = require('../src/util/monthRange');
const { formatFullReport } = require('../src/tasks/githubMonthlyActivity');

const LOG_DIR = path.join(__dirname, '..', 'logs');
const USAGE_COMMAND = 'npm run github:activity --';

const VALUE_FLAGS = ['--login', '--logins', '--aliases', '--exclude-owners'];
const OPTIONS_HELP =
  'Options: --json  --login <user>  --logins <list>  --aliases <list>\n' +
  '         --exclude-owners <list>  --default-branch-only  --help';

/** Pull `--flag value` / `--flag=value` pairs out of argv. */
function takeValueFlags(argv) {
  const values = {};
  const remaining = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const exact = VALUE_FLAGS.find((f) => arg === f);
    if (exact) {
      values[exact.slice(2)] = argv[++i];
      continue;
    }
    const inline = VALUE_FLAGS.find((f) => arg.startsWith(`${f}=`));
    if (inline) {
      values[inline.slice(2)] = arg.slice(inline.length + 1);
      continue;
    }
    remaining.push(arg);
  }

  return { values, remaining };
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    printMonthUsage(USAGE_COMMAND);
    console.error(OPTIONS_HELP);
    return;
  }

  const { values, remaining: monthArgv } = takeValueFlags(argv);

  let month;
  try {
    month = parseMonthArgs(monthArgv);
  } catch (err) {
    console.error(`FAIL ${err.message}`);
    printMonthUsage(USAGE_COMMAND);
    process.exitCode = 1;
    return;
  }

  const asJson = month.rest.includes('--json');

  const result = await run('github-monthly-activity', {
    month: month.slug,
    login: values.login,
    logins: values.logins,
    aliases: values.aliases,
    excludeOwners: values['exclude-owners'],
    allBranches: month.rest.includes('--default-branch-only') ? false : undefined,
  });

  const out = asJson ? JSON.stringify(result, null, 2) : formatFullReport(result);
  console.log(out);

  const logFile = path.join(LOG_DIR, `github-${result.slug}-activity.log`);
  fs.mkdirSync(LOG_DIR, { recursive: true });
  fs.writeFileSync(logFile, `${out}\n`, 'utf8');
  console.error(`\nWrote ${logFile}`);
}

main().catch((err) => {
  console.error('FAIL', err.message || err);
  process.exitCode = 1;
});
