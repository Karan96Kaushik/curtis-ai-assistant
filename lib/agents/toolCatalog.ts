export type PermissionAccess = 'read' | 'write';
export type PermissionRisk = 'low' | 'medium' | 'high';
export type PermissionIntegration =
  | 'phone'
  | 'push'
  | 'jira'
  | 'github'
  | 'web'
  | 'browser'
  | 'teams'
  | 'scheduler'
  | 'memory'
  | 'timesheet'
  | 'release';

export interface PermissionTool {
  name: string;
  integration: PermissionIntegration;
  access: PermissionAccess;
  risk: PermissionRisk;
  description: string;
  /** The agent run can call this today. Others can be granted and start working when connected. */
  connected: boolean;
  /** Reads private message or device-notification content. */
  privateRead?: boolean;
  /** Can send content outside the user's own devices. Combined with a private read, approval is required. */
  outbound?: boolean;
}

export const INTEGRATION_LABEL: Record<PermissionIntegration, string> = {
  phone: 'Phone',
  push: 'Push',
  jira: 'Jira',
  github: 'GitHub',
  web: 'Web',
  browser: 'Browser',
  teams: 'Teams',
  scheduler: 'Scheduler',
  memory: 'Memory',
  timesheet: 'Timesheet',
  release: 'Release',
};

/**
 * Same function names the chat agent already offers.
 * Session controls (think, clear_context, clear_chat, confirm_pending, cancel_pending)
 * stay off profiles: agent runs use ask_user, finish, and approval instead.
 */
export const PERMISSION_TOOLS: readonly PermissionTool[] = [
  {
    name: 'request_phone_notifications',
    integration: 'phone',
    access: 'read',
    risk: 'low',
    description: 'Read this user\'s recent phone notifications, including mail, codes, and personal messages.',
    connected: true,
    privateRead: true,
  },
  {
    name: 'send_push_notification',
    integration: 'push',
    access: 'write',
    risk: 'low',
    description: 'Send a push notification to this user\'s Android app.',
    connected: true,
  },
  { name: 'jira_get_issue', integration: 'jira', access: 'read', risk: 'low', description: 'Fetch one Jira issue by exact key.', connected: false },
  { name: 'jira_my_issues', integration: 'jira', access: 'read', risk: 'low', description: 'List issues assigned to the signed-in user.', connected: false },
  { name: 'jira_search', integration: 'jira', access: 'read', risk: 'low', description: 'Search Jira issues with JQL.', connected: false },
  { name: 'jira_monthly_activity', integration: 'jira', access: 'read', risk: 'low', description: 'Report this user\'s Jira activity for one calendar month.', connected: false },
  { name: 'jira_get_transitions', integration: 'jira', access: 'read', risk: 'low', description: 'List workflow transitions available on an issue.', connected: false },
  { name: 'jira_find_user', integration: 'jira', access: 'read', risk: 'low', description: 'Find Jira users by name or email.', connected: false },
  { name: 'jira_list_projects', integration: 'jira', access: 'read', risk: 'low', description: 'List Jira projects, or issue types for one project.', connected: false },
  { name: 'jira_list_comments', integration: 'jira', access: 'read', risk: 'low', description: 'List comments on a Jira issue.', connected: false },
  { name: 'jira_whoami', integration: 'jira', access: 'read', risk: 'low', description: 'Show which Jira account is authenticated.', connected: false },
  { name: 'jira_update', integration: 'jira', access: 'write', risk: 'high', description: 'Update a Jira issue: status, comment, description, assignee, or labels.', connected: false, outbound: true },
  { name: 'jira_create', integration: 'jira', access: 'write', risk: 'high', description: 'Create a Jira issue.', connected: false, outbound: true },
  { name: 'jira_link_issues', integration: 'jira', access: 'write', risk: 'medium', description: 'Link two Jira issues.', connected: false, outbound: true },
  { name: 'jira_log_work', integration: 'jira', access: 'write', risk: 'medium', description: 'Log time spent on a Jira issue.', connected: false, outbound: true },
  { name: 'jira_delete_comment', integration: 'jira', access: 'write', risk: 'high', description: 'Delete a Jira comment.', connected: false, outbound: true },
  { name: 'github_search_repos', integration: 'github', access: 'read', risk: 'low', description: 'Search GitHub repositories.', connected: false },
  { name: 'github_list_repos', integration: 'github', access: 'read', risk: 'low', description: 'List repositories for the user or an organization.', connected: false },
  { name: 'github_get_repo', integration: 'github', access: 'read', risk: 'low', description: 'Read details for one repository.', connected: false },
  { name: 'github_list_tags', integration: 'github', access: 'read', risk: 'low', description: 'List tags on a repository.', connected: false },
  { name: 'github_list_branches', integration: 'github', access: 'read', risk: 'low', description: 'List branches on a repository.', connected: false },
  { name: 'github_list_commits', integration: 'github', access: 'read', risk: 'low', description: 'List recent commits on a ref.', connected: false },
  { name: 'github_compare', integration: 'github', access: 'read', risk: 'low', description: 'Compare two refs: commits, files, and referenced Jira issues.', connected: false },
  { name: 'github_get_file', integration: 'github', access: 'read', risk: 'low', description: 'Read a file or list a directory in a repository.', connected: false },
  { name: 'github_search_prs', integration: 'github', access: 'read', risk: 'low', description: 'Search or list pull requests.', connected: false },
  { name: 'github_get_pr', integration: 'github', access: 'read', risk: 'low', description: 'Read one pull request, including checks and reviews.', connected: false },
  { name: 'github_search_issues', integration: 'github', access: 'read', risk: 'low', description: 'Search GitHub issues.', connected: false },
  { name: 'github_get_issue', integration: 'github', access: 'read', risk: 'low', description: 'Read one GitHub issue and recent comments.', connected: false },
  { name: 'github_monthly_activity', integration: 'github', access: 'read', risk: 'low', description: 'Report this user\'s GitHub activity for one calendar month.', connected: false },
  { name: 'github_create_tag', integration: 'github', access: 'write', risk: 'high', description: 'Create a git tag on a repository.', connected: false, outbound: true },
  { name: 'github_add_comment', integration: 'github', access: 'write', risk: 'high', description: 'Post a comment on a GitHub pull request or issue.', connected: false, outbound: true },
  { name: 'github_create_issue', integration: 'github', access: 'write', risk: 'high', description: 'Open a GitHub issue.', connected: false, outbound: true },
  { name: 'web_search', integration: 'web', access: 'read', risk: 'low', description: 'Search the web and return the top results.', connected: false },
  { name: 'web_fetch_page', integration: 'web', access: 'read', risk: 'low', description: 'Open a URL and return readable page text.', connected: false },
  { name: 'browser_status', integration: 'browser', access: 'read', risk: 'low', description: 'Check whether the Firefox extension is connected.', connected: false },
  { name: 'browser_list_tabs', integration: 'browser', access: 'read', risk: 'low', description: 'List open Firefox tabs.', connected: false },
  { name: 'browser_read_page', integration: 'browser', access: 'read', risk: 'low', description: 'Read visible text from a Firefox tab.', connected: false },
  { name: 'browser_open_tab', integration: 'browser', access: 'write', risk: 'medium', description: 'Open a URL in Firefox or focus a matching tab.', connected: false },
  { name: 'browser_navigate', integration: 'browser', access: 'write', risk: 'medium', description: 'Navigate a Firefox tab to a URL.', connected: false },
  { name: 'browser_click', integration: 'browser', access: 'write', risk: 'high', description: 'Click an element in the active Firefox tab.', connected: false },
  { name: 'browser_type', integration: 'browser', access: 'write', risk: 'high', description: 'Type text into a field in the active Firefox tab.', connected: false, outbound: true },
  { name: 'teams_open', integration: 'teams', access: 'write', risk: 'low', description: 'Focus an existing Teams tab, or open one if none exists.', connected: false },
  { name: 'teams_list_chats', integration: 'teams', access: 'read', risk: 'low', description: 'List recent Teams chats and channels.', connected: false, privateRead: true },
  { name: 'teams_read_messages', integration: 'teams', access: 'read', risk: 'low', description: 'Read recent messages from a Teams chat.', connected: false, privateRead: true },
  { name: 'list_schedules', integration: 'scheduler', access: 'read', risk: 'low', description: 'List pending and running schedules for this user.', connected: false },
  { name: 'schedule_task', integration: 'scheduler', access: 'write', risk: 'medium', description: 'Schedule work for later with a delay, a clock time, or a cron expression.', connected: false },
  { name: 'cancel_schedule', integration: 'scheduler', access: 'write', risk: 'medium', description: 'Cancel a pending scheduled task by id.', connected: false },
  { name: 'memory_read', integration: 'memory', access: 'read', risk: 'low', description: 'Read org-memory.md.', connected: false },
  { name: 'context_list', integration: 'memory', access: 'read', risk: 'low', description: 'List stored reference contexts.', connected: false },
  { name: 'context_read', integration: 'memory', access: 'read', risk: 'low', description: 'Read one stored reference context by slug.', connected: false },
  { name: 'memory_append', integration: 'memory', access: 'write', risk: 'medium', description: 'Append facts to org-memory.md.', connected: false },
  { name: 'memory_write', integration: 'memory', access: 'write', risk: 'medium', description: 'Replace org-memory.md.', connected: false },
  { name: 'timesheet_draft', integration: 'timesheet', access: 'read', risk: 'low', description: 'Draft a monthly timesheet from that month\'s Jira and GitHub activity.', connected: false },
  { name: 'wf_release_start', integration: 'release', access: 'read', risk: 'low', description: 'Start a release draft from a PR, Jira key, branch, or repository. Does not write yet.', connected: false },
  { name: 'wf_release_draft', integration: 'release', access: 'read', risk: 'low', description: 'Build or re-show a release draft. Does not write yet.', connected: false },
  { name: 'wf_release_revise_draft', integration: 'release', access: 'read', risk: 'low', description: 'Edit a release draft and re-show it. Does not write yet.', connected: false },
  { name: 'wf_release_status', integration: 'release', access: 'read', risk: 'low', description: 'Show the status of a release workflow.', connected: false },
  { name: 'wf_release_approve_draft', integration: 'release', access: 'write', risk: 'medium', description: 'Approve a release draft and stage its writes for confirmation.', connected: false },
  { name: 'wf_release_skip_step', integration: 'release', access: 'write', risk: 'medium', description: 'Skip the release write that is waiting and stage the next one.', connected: false },
  { name: 'wf_release_advance', integration: 'release', access: 'write', risk: 'medium', description: 'Resume a paused release workflow.', connected: false },
  { name: 'wf_release_execute_pending', integration: 'release', access: 'write', risk: 'high', description: 'Execute the staged release writes to GitHub and Jira.', connected: false, outbound: true },
];

export const INTEGRATION_ORDER: readonly PermissionIntegration[] = [
  'phone',
  'push',
  'jira',
  'github',
  'web',
  'browser',
  'teams',
  'scheduler',
  'memory',
  'timesheet',
  'release',
];
