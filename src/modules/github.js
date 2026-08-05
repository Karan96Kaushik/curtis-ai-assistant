const registry = require('../core/moduleRegistry');
const githubSearchReposTask = require('../tasks/githubSearchRepos');
const githubListReposTask = require('../tasks/githubListRepos');
const githubListTagsTask = require('../tasks/githubListTags');
const githubCreateTagTask = require('../tasks/githubCreateTag');
const githubSearchPrsTask = require('../tasks/githubSearchPrs');
const githubGetPrTask = require('../tasks/githubGetPr');
const { stageOrExecute } = require('../util/mutatingGate');
const { envelopeFromRaw } = require('../util/taskResult');
const { startTimer } = require('../util/timing');

async function runLocalTask(name, execute, format, payload = {}) {
  const timer = startTimer(`task.${name}`);
  try {
    const raw = await execute(payload);
    const text =
      typeof format === 'function'
        ? format(raw)
        : typeof raw === 'object'
          ? JSON.stringify(raw, null, 2)
          : String(raw);
    const envelope = envelopeFromRaw(name, raw);
    timer.end();
    return { text, envelope, raw };
  } catch (err) {
    timer.end('FAILED');
    throw err;
  }
}

function looksLikeGithub(text) {
  const t = String(text || '');
  return (
    /\b(github|gh\b)\b/i.test(t) ||
    /\b(repos?|repositories)\b/i.test(t) ||
    /\b(pull requests?|\bPRs?\b)\b/i.test(t) ||
    /\b(git\s+)?tags?\b/i.test(t) ||
    /\b[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+#\d+\b/.test(t)
  );
}

registry.register({
  id: 'github',

  intent: (text) => {
    const t = String(text || '').trim();
    if (!looksLikeGithub(t)) return null;

    // Prefer explicit github / PR / tag / repo language over generic "repo"
    const strong =
      /\b(github|gh\b|pull requests?|\bPRs?\b|git\s+tags?|create\s+tag|list\s+repos?|search\s+repos?)\b/i.test(
        t
      ) || /\b[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+#\d+\b/.test(t);

    if (!strong && !/\b(github|gh\b)\b/i.test(t)) {
      // "repos" alone is weak — only claim github if paired with search/list/tag
      if (!/\b(search|list|find|show|check|create).{0,40}\b(repos?|tags?)\b/i.test(t)) {
        return null;
      }
    }

    const mutate = /\b(create|make|add|push)\b.{0,40}\btag\b/i.test(t);
    return {
      domain: 'github',
      mode: mutate ? 'mutate' : 'lookup',
      needsConfirm: mutate,
      budget: 'fast',
      confidence: strong ? 'high' : 'medium',
      reason: mutate ? 'github-mutate' : 'github-lookup',
    };
  },

  tools: [
    {
      type: 'function',
      function: {
        name: 'github_search_repos',
        description: 'Search GitHub repositories by query (name, topic, language, user:, org:, etc.).',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'GitHub search query' },
            max: { type: 'integer', description: 'Max results (default 10, max 50)' },
            sort: { type: 'string', description: 'stars | forks | help-wanted-issues | updated' },
            order: { type: 'string', enum: ['asc', 'desc'] },
          },
          required: ['query'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'github_list_repos',
        description:
          'List repositories for the authenticated user, or for an organization if org is set.',
        parameters: {
          type: 'object',
          properties: {
            org: { type: 'string', description: 'Optional org login to list org repos' },
            type: {
              type: 'string',
              description: 'all | owner | public | private | member (user) / all|public|private|forks|sources|member (org)',
            },
            max: { type: 'integer', description: 'Max repos (default 30)' },
            sort: { type: 'string', description: 'created | updated | pushed | full_name' },
          },
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'github_list_tags',
        description:
          'List tags on a repo. Optionally check whether a specific tag exists (tag=).',
        parameters: {
          type: 'object',
          properties: {
            repo: { type: 'string', description: 'owner/repo' },
            owner: { type: 'string' },
            tag: { type: 'string', description: 'Optional tag name to check existence' },
            max: { type: 'integer', description: 'Max tags to list (default 30)' },
          },
          required: ['repo'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'github_create_tag',
        description:
          'Create a git tag on a repo at a commit SHA or branch (default HEAD/default branch). Annotated if message is set. Mutating — requires confirmation when gate is on.',
        parameters: {
          type: 'object',
          properties: {
            repo: { type: 'string', description: 'owner/repo' },
            tag: { type: 'string', description: 'Tag name (e. for example v1.2.0)' },
            sha: { type: 'string', description: 'Commit SHA (optional if branch/ref given)' },
            branch: { type: 'string', description: 'Branch or ref to tag (default HEAD)' },
            message: { type: 'string', description: 'Optional annotation message' },
          },
          required: ['repo', 'tag'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'github_search_prs',
        description:
          'Search pull requests, or list PRs for a repo when only repo is given. Use GitHub search syntax (repo:, is:open, author:, etc.).',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'PR search query (type:pr added automatically)' },
            repo: { type: 'string', description: 'owner/repo — list or scope search' },
            state: { type: 'string', description: 'open | closed | merged | all' },
            max: { type: 'integer', description: 'Max results (default 10)' },
          },
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'github_get_pr',
        description: 'Read a single pull request by repo and number (title, body, state, diff stats).',
        parameters: {
          type: 'object',
          properties: {
            repo: { type: 'string', description: 'owner/repo' },
            number: { type: 'integer', description: 'PR number' },
          },
          required: ['repo', 'number'],
        },
      },
    },
  ],

  tasks: {
    'github-search-repos': {
      execute: githubSearchReposTask,
      format: githubSearchReposTask.formatResult,
    },
    'github-list-repos': {
      execute: githubListReposTask,
      format: githubListReposTask.formatResult,
    },
    'github-list-tags': {
      execute: githubListTagsTask,
      format: githubListTagsTask.formatResult,
    },
    'github-create-tag': {
      execute: githubCreateTagTask,
      format: githubCreateTagTask.formatResult,
    },
    'github-search-prs': {
      execute: githubSearchPrsTask,
      format: githubSearchPrsTask.formatResult,
    },
    'github-get-pr': {
      execute: githubGetPrTask,
      format: githubGetPrTask.formatResult,
    },
  },

  toolHandlers: {
    github_search_repos: async (args) =>
      runLocalTask('github-search-repos', githubSearchReposTask, githubSearchReposTask.formatResult, {
        query: args.query,
        max: args.max,
        sort: args.sort,
        order: args.order,
      }),
    github_list_repos: async (args) =>
      runLocalTask('github-list-repos', githubListReposTask, githubListReposTask.formatResult, {
        org: args.org,
        type: args.type,
        max: args.max,
        sort: args.sort,
      }),
    github_list_tags: async (args) =>
      runLocalTask('github-list-tags', githubListTagsTask, githubListTagsTask.formatResult, {
        repo: args.repo,
        owner: args.owner,
        tag: args.tag,
        max: args.max,
      }),
    github_create_tag: async (args, discordCtx) =>
      stageOrExecute(
        'github_create_tag',
        args,
        discordCtx,
        () =>
          runLocalTask('github-create-tag', githubCreateTagTask, githubCreateTagTask.formatResult, {
            repo: args.repo,
            owner: args.owner,
            tag: args.tag,
            sha: args.sha,
            branch: args.branch || args.ref,
            message: args.message,
          }),
        { domainLabel: 'GitHub' }
      ),
    github_search_prs: async (args) =>
      runLocalTask('github-search-prs', githubSearchPrsTask, githubSearchPrsTask.formatResult, {
        query: args.query,
        repo: args.repo,
        state: args.state,
        max: args.max,
        sort: args.sort,
        order: args.order,
      }),
    github_get_pr: async (args) =>
      runLocalTask('github-get-pr', githubGetPrTask, githubGetPrTask.formatResult, {
        repo: args.repo,
        owner: args.owner,
        number: args.number,
      }),
  },

  promptPack: () =>
    [
      'GitHub mode:',
      '- Use github_* tools for repos, tags, and PRs. Do not invent repo/PR data.',
      '- Repo args are owner/repo (e.g. octocat/Hello-World).',
      '- List my repos → github_list_repos. Search the catalog → github_search_repos.',
      '- Check/list tags → github_list_tags (set tag= to check existence).',
      '- Create tag → github_create_tag (gated when confirmation is on).',
      '- Search/list PRs → github_search_prs; read one PR → github_get_pr.',
      '- Cite html_url from tool results.',
    ].join('\n'),

  buildPlan: (intent, userText, opts, pushTool) => {
    if (intent.domain !== 'github' && intent.domain !== 'mixed') return;
    const t = String(userText || '');

    if (/\b(create|make|add|push)\b.{0,40}\btag\b/i.test(t)) {
      pushTool('github_create_tag', 'Create the requested git tag (propose if gated)');
      return;
    }
    if (/\btags?\b/i.test(t) && /\b(list|check|show|get|what)\b/i.test(t)) {
      pushTool('github_list_tags', 'List or check tags on the repo');
      return;
    }
    const prMatch = t.match(/\b([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#(\d+)\b/);
    if (prMatch || (/\b(pr|pull)\b/i.test(t) && /#?\d+/.test(t) && /\bread|show|get|details?\b/i.test(t))) {
      pushTool('github_get_pr', 'Fetch the pull request details');
      return;
    }
    if (/\b(pull requests?|\bPRs?\b)\b/i.test(t)) {
      pushTool('github_search_prs', 'Search or list pull requests');
      return;
    }
    if (/\b(list|show|my)\b.{0,30}\brepos?\b/i.test(t) && !/\bsearch\b/i.test(t)) {
      pushTool('github_list_repos', 'List repositories for the auth user or org');
      return;
    }
    if (/\b(search|find)\b.{0,40}\brepos?\b/i.test(t) || /\bgithub\b.*\bsearch\b/i.test(t)) {
      pushTool('github_search_repos', 'Search GitHub repositories');
      return;
    }
    pushTool('github_list_repos', 'List accessible repositories');
  },

  evidenceExtractor: (tool, envelope, text, out) => {
    const d = envelope.data || {};
    if (tool === 'github_search_repos' || tool === 'github_list_repos') {
      const repos = d.repos || [];
      for (const r of repos.slice(0, 30)) {
        out.push({
          type: 'repo',
          full_name: r.full_name,
          url: r.html_url,
          private: r.private,
          stars: r.stars,
        });
      }
    }
    if (tool === 'github_list_tags') {
      if (d.check) {
        out.push({ type: 'tag_check', tag: d.check.tag, exists: d.check.exists, sha: d.check.sha });
      }
      for (const t of (d.tags || []).slice(0, 40)) {
        out.push({ type: 'tag', name: t.name, sha: t.sha });
      }
    }
    if (tool === 'github_create_tag' && d.tag) {
      out.push({ type: 'side_effect', value: `Created tag ${d.tag} on ${d.full_name}` });
    }
    if (tool === 'github_search_prs') {
      for (const p of (d.pulls || []).slice(0, 30)) {
        out.push({
          type: 'pr',
          repo: p.repo,
          number: p.number,
          title: p.title,
          state: p.state,
          url: p.html_url,
        });
      }
    }
    if (tool === 'github_get_pr' && d.number != null) {
      out.push({
        type: 'pr',
        repo: d.full_name,
        number: d.number,
        title: d.title,
        state: d.state,
        url: d.html_url,
      });
    }
    if (/Created tag /i.test(text)) {
      out.push({ type: 'side_effect', value: text.split('\n')[0].slice(0, 160) });
    }
  },
});
