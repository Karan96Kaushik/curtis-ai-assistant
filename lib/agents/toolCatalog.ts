export type PermissionAccess = 'read' | 'write';
export type PermissionRisk = 'low' | 'medium' | 'high';
export type PermissionIntegration = 'email' | 'whatsapp' | 'jira' | 'github' | 'push' | 'schedule';

export interface PermissionTool {
  name: string;
  integration: PermissionIntegration;
  access: PermissionAccess;
  risk: PermissionRisk;
  description: string;
  /** The agent can call this tool. Others can still be granted and start working when connected. */
  connected: boolean;
}

export const INTEGRATION_LABEL: Record<PermissionIntegration, string> = {
  email: 'Email',
  whatsapp: 'WhatsApp',
  jira: 'Jira',
  github: 'GitHub',
  push: 'Push',
  schedule: 'Schedule',
};

export const PERMISSION_TOOLS: readonly PermissionTool[] = [
  { name: 'email.list', integration: 'email', access: 'read', risk: 'low', description: 'List recent email notifications.', connected: true },
  { name: 'email.get', integration: 'email', access: 'read', risk: 'low', description: 'Read one email notification.', connected: true },
  { name: 'email.draft', integration: 'email', access: 'write', risk: 'low', description: 'Create an email draft.', connected: false },
  { name: 'email.send', integration: 'email', access: 'write', risk: 'high', description: 'Send an email.', connected: false },
  { name: 'whatsapp.list_chats', integration: 'whatsapp', access: 'read', risk: 'low', description: 'List recent WhatsApp chats.', connected: false },
  { name: 'whatsapp.get_messages', integration: 'whatsapp', access: 'read', risk: 'low', description: 'Read messages in one chat.', connected: false },
  { name: 'whatsapp.send', integration: 'whatsapp', access: 'write', risk: 'high', description: 'Send a WhatsApp message.', connected: false },
  { name: 'jira.search', integration: 'jira', access: 'read', risk: 'low', description: 'Search Jira issues.', connected: false },
  { name: 'jira.get_issue', integration: 'jira', access: 'read', risk: 'low', description: 'Read one Jira issue.', connected: false },
  { name: 'jira.create_issue', integration: 'jira', access: 'write', risk: 'medium', description: 'Create a Jira issue.', connected: false },
  { name: 'jira.comment', integration: 'jira', access: 'write', risk: 'medium', description: 'Comment on a Jira issue.', connected: false },
  { name: 'jira.transition', integration: 'jira', access: 'write', risk: 'medium', description: 'Transition a Jira issue.', connected: false },
  { name: 'github.read_file', integration: 'github', access: 'read', risk: 'low', description: 'Read a file from a repository.', connected: false },
  { name: 'github.list_prs', integration: 'github', access: 'read', risk: 'low', description: 'List pull requests.', connected: false },
  { name: 'github.get_pr', integration: 'github', access: 'read', risk: 'low', description: 'Read one pull request.', connected: false },
  {
    name: 'github.create_branch_commit_pr',
    integration: 'github',
    access: 'write',
    risk: 'high',
    description: 'Create a branch, commit, and pull request.',
    connected: false,
  },
  { name: 'push.send', integration: 'push', access: 'write', risk: 'low', description: 'Send a push notification to yourself.', connected: true },
  {
    name: 'schedule.create_job',
    integration: 'schedule',
    access: 'write',
    risk: 'medium',
    description: 'Schedule a future agent run.',
    connected: false,
  },
];

export const INTEGRATION_ORDER: readonly PermissionIntegration[] = [
  'email',
  'whatsapp',
  'jira',
  'github',
  'push',
  'schedule',
];
