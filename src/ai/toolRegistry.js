const registry = require('../core/moduleRegistry');

/**
 * @param {{ confirmOn?: boolean }} opts
 * @returns {object[]}
 */
function buildAllTools(opts = {}) {
  // We can filter tools globally here if needed (e.g. disabling confirmation tools)
  const confirmOn = opts.confirmOn !== false;
  let allTools = registry.getTools();
  
  if (!confirmOn) {
    allTools = allTools.filter(t => t.function.name !== 'confirm_pending' && t.function.name !== 'cancel_pending');
  }

  // Update descriptions for mutating tools if confirmOn is enabled/disabled
  const mutatingNames = new Set([
    'jira_create',
    'jira_update',
    'jira_delete_comment',
    'github_create_tag',
    'browser_click',
    'browser_type',
    'wf_release_execute_pending',
  ]);

  return allTools.map(t => {
    if (mutatingNames.has(t.function.name)) {
      const copy = JSON.parse(JSON.stringify(t));
      if (confirmOn) {
        copy.function.description = `Propose ${t.function.name}. HARD-GATED: does not apply until user confirms in a later message.`;
      } else {
        copy.function.description = `${t.function.name}. Executes immediately.`;
      }
      return copy;
    }
    return t;
  });
}

function toolsForIntent(intent, opts = {}) {
  // A simplified approach for modularity: 
  // Let's just return all tools if it's a general intent,
  // or maybe the modules should also specify which tools are allowed for their domain.
  // For now, to keep the strict scoping from before, we'll implement a simple filter:
  
  const allTools = buildAllTools(opts);
  const confirmOn = opts.confirmOn !== false;
  const hasPending = Boolean(opts.hasPending);

  const allowed = new Set(['clear_context', 'think', 'memory_read']);

  if (confirmOn && (hasPending || intent.mode === 'confirm' || intent.domain === 'jira' || intent.domain === 'github' || intent.domain === 'browser' || intent.domain === 'teams' || intent.domain === 'release')) {
    allowed.add('confirm_pending');
    allowed.add('cancel_pending');
  }

  if (intent.domain === 'jira' || intent.domain === 'mixed' || intent.forceJiraMyIssues || intent.forceJiraGetIssue) {
    allowed.add('jira_my_issues');
    allowed.add('jira_get_issue');
    allowed.add('jira_list_comments');
    allowed.add('jira_whoami');
  }
  
  if (intent.domain === 'jira' || intent.domain === 'mixed') {
    if (intent.mode === 'mutate' || intent.mode === 'confirm' || hasPending) {
      allowed.add('jira_create');
      allowed.add('jira_update');
      allowed.add('jira_delete_comment');
    }
  }

  if (intent.domain === 'memory' || intent.domain === 'mixed') {
    allowed.add('memory_append');
    allowed.add('memory_write');
  }

  if (intent.domain === 'web' || intent.mode === 'research' || intent.domain === 'mixed' || intent.forceWebFetch) {
    allowed.add('web_search');
    allowed.add('web_fetch_page');
  }

  // Travel price scrape only for travel/compare (not every heavy budget like Teams/browser)
  if (intent.domain === 'travel' || intent.mode === 'compare' || intent.domain === 'mixed') {
    allowed.add('web_search');
    allowed.add('web_check_prices');
    allowed.add('web_fetch_page');
  }

  if (intent.domain === 'scheduler') {
    allowed.add('schedule_task');
    allowed.add('list_schedules');
    allowed.add('cancel_schedule');
  }

  if (intent.domain === 'browser' || intent.domain === 'mixed') {
    allowed.add('browser_status');
    allowed.add('browser_list_tabs');
    allowed.add('browser_read_page');
    if (intent.mode === 'mutate' || intent.mode === 'confirm' || hasPending || intent.domain === 'mixed') {
      allowed.add('browser_open_tab');
      allowed.add('browser_navigate');
      allowed.add('browser_click');
      allowed.add('browser_type');
    }
  }

  if (intent.domain === 'github' || intent.domain === 'mixed') {
    allowed.add('github_search_repos');
    allowed.add('github_list_repos');
    allowed.add('github_list_tags');
    allowed.add('github_search_prs');
    allowed.add('github_get_pr');
    if (intent.mode === 'mutate' || intent.mode === 'confirm' || hasPending) {
      allowed.add('github_create_tag');
    }
  }

  if (intent.domain === 'release') {
    allowed.add('wf_release_start');
    allowed.add('wf_release_draft');
    allowed.add('wf_release_revise_draft');
    allowed.add('wf_release_approve_draft');
    allowed.add('wf_release_status');
    allowed.add('wf_release_advance');
    allowed.add('wf_release_skip');
    allowed.add('wf_release_revise_pending');
    allowed.add('wf_release_answer');
    allowed.add('wf_release_edit');
    allowed.add('wf_release_approve_review');
    if (intent.mode === 'mutate' || intent.mode === 'confirm' || hasPending) {
      allowed.add('wf_release_execute_pending');
    }
  }

  if (intent.domain === 'teams' || intent.domain === 'mixed') {
    allowed.add('teams_open');
    allowed.add('teams_list_chats');
    allowed.add('teams_read_messages');
  }

  if (intent.domain === 'meta') {
    allowed.add('jira_whoami');
    allowed.add('memory_append');
    allowed.add('memory_write');
  }

  if (intent.domain === 'chat' || intent.confidence === 'low') {
    allowed.add('jira_my_issues');
    allowed.add('jira_get_issue');
    allowed.add('jira_list_comments');
    allowed.add('jira_whoami');
    allowed.add('web_search');
    allowed.add('web_fetch_page');
    allowed.add('schedule_task');
    allowed.add('list_schedules');
    allowed.add('cancel_schedule');
    allowed.add('browser_status');
    allowed.add('browser_list_tabs');
    allowed.add('browser_read_page');
    allowed.add('browser_open_tab');
    allowed.add('browser_navigate');
    allowed.add('browser_click');
    allowed.add('browser_type');
    allowed.add('teams_open');
    allowed.add('teams_list_chats');
    allowed.add('teams_read_messages');
    allowed.add('github_search_repos');
    allowed.add('github_list_repos');
    allowed.add('github_list_tags');
    allowed.add('github_search_prs');
    allowed.add('github_get_pr');
  }

  return allTools.filter(t => allowed.has(t.function.name));
}

module.exports = {
  buildAllTools,
  toolsForIntent,
};
