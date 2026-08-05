#!/usr/bin/env node
require('dotenv').config();

const APP_ID = process.env.DISCORD_APP_ID || process.env.DISCORD_CLIENT_ID;
const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;

if (!APP_ID) {
  console.error('Missing DISCORD_APP_ID in .env');
  process.exit(1);
}
if (!BOT_TOKEN) {
  console.error('Missing DISCORD_BOT_TOKEN in .env');
  process.exit(1);
}

const commands = [
  {
    name: 'jira-update',
    description: 'Update a Jira issue (status, description, and/or comment)',
    options: [
      {
        name: 'issue',
        description: 'Jira issue key (e.g. PROJ-123)',
        type: 3,
        required: true,
      },
      {
        name: 'status',
        description: 'Target status / transition name',
        type: 3,
        required: false,
      },
      {
        name: 'description',
        description: 'Replace description (markdown)',
        type: 3,
        required: false,
      },
      {
        name: 'comment',
        description: 'Comment to add on the issue',
        type: 3,
        required: false,
      },
    ],
  },
  {
    name: 'jira-my-issues',
    description: 'List Jira issues assigned to you (default: unresolved)',
    options: [
      {
        name: 'max',
        description: 'Max issues to return (default 25, max 50)',
        type: 4,
        required: false,
        min_value: 1,
        max_value: 50,
      },
      {
        name: 'status',
        description: 'Filter by status name',
        type: 3,
        required: false,
      },
      {
        name: 'query',
        description: 'Topic/keyword filter (summary or body)',
        type: 3,
        required: false,
      },
      {
        name: 'types',
        description: 'Comma-separated issue types, e.g. Story,Epic',
        type: 3,
        required: false,
      },
      {
        name: 'resolution',
        description: 'unresolved (default), resolved, or all',
        type: 3,
        required: false,
        choices: [
          { name: 'unresolved', value: 'unresolved' },
          { name: 'resolved', value: 'resolved' },
          { name: 'all', value: 'all' },
        ],
      },
    ],
  },
  {
    name: 'jira-create',
    description: 'Create a Jira issue',
    options: [
      {
        name: 'project',
        description: 'Project key (e.g. AATP)',
        type: 3,
        required: true,
      },
      {
        name: 'summary',
        description: 'Issue summary',
        type: 3,
        required: true,
      },
      {
        name: 'type',
        description: 'Issue type name (default Task)',
        type: 3,
        required: false,
      },
      {
        name: 'description',
        description: 'Optional description',
        type: 3,
        required: false,
      },
      {
        name: 'assign_me',
        description: 'Assign to auth user (default true if omitted)',
        type: 5,
        required: false,
      },
    ],
  },
  {
    name: 'jira-list-comments',
    description: 'List comments on a Jira issue',
    options: [
      {
        name: 'issue',
        description: 'Jira issue key',
        type: 3,
        required: true,
      },
      {
        name: 'max',
        description: 'Max comments (default 20)',
        type: 4,
        required: false,
        min_value: 1,
        max_value: 50,
      },
    ],
  },
  {
    name: 'jira-delete-comment',
    description: 'Delete a comment by id, or the last comment',
    options: [
      {
        name: 'issue',
        description: 'Jira issue key',
        type: 3,
        required: true,
      },
      {
        name: 'comment_id',
        description: 'Comment id to delete',
        type: 3,
        required: false,
      },
      {
        name: 'last',
        description: 'Delete the most recent comment',
        type: 5,
        required: false,
      },
    ],
  },
  {
    name: 'jira-whoami',
    description: 'Verify Jira API auth / show connected profile',
    options: [],
  },
];

async function main() {
  const url = `https://discord.com/api/v10/applications/${APP_ID}/commands`;
  const response = await fetch(url, {
    method: 'PUT',
    headers: {
      Authorization: `Bot ${BOT_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(commands),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = data.message || JSON.stringify(data) || response.statusText;
    console.error(`Failed to register commands: ${detail}`);
    process.exit(1);
  }

  const names = Array.isArray(data) ? data.map((c) => `/${c.name}`).join(', ') : '(ok)';
  console.log(`Registered global commands: ${names}`);
  console.log('Note: global commands can take up to ~1 hour to appear in Discord.');
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
