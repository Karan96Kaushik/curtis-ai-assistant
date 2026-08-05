const { createGithubClient, parseRepo } = require('../../../integrations/githubClient');
const { createJiraClient, adfToPlainText, browseUrl } = require('../../../integrations/jiraClient');
const { proposeNextVersion } = require('../semver');
const { setField, markUnknown } = require('../fields');
const { audit, setState, STATES } = require('../context');
const { parseStartInput, warn, componentFromRepo, ticketSummary, JIRA_KEY_RE } = require('../helpers');
const { isDraftMode, upsertDraftStep } = require('../draft');

async function identifySource(ctx) {
  const r = ctx.release;
  if (!r.repository && !r.source_pr && !r.development_ticket && !r.source_branch) {
    return {
      pause: 'user_input',
      message:
        'Need a release source. Provide a PR (repo + number), Jira key, or branch + repository.',
      question: { field: 'source', prompt: 'What should we release? (PR, Jira key, or branch)' },
    };
  }

  if (r.repository) {
    setField(ctx, 'repository', r.repository, { confidence: 'high', source: 'user' });
    r.component = r.component || componentFromRepo(r.repository);
    if (r.component) {
      setField(ctx, 'component', r.component, { confidence: 'high', source: 'repository' });
    }
  }
  if (r.source_pr) {
    setField(ctx, 'source_pr', r.source_pr, { confidence: 'high', source: 'user' });
  }
  if (r.source_branch) {
    setField(ctx, 'source_branch', r.source_branch, { confidence: 'high', source: 'user' });
  }
  if (r.development_ticket) {
    setField(ctx, 'development_ticket', r.development_ticket, {
      confidence: 'high',
      source: 'user',
    });
  }

  audit(ctx, 'source_identified', {
    repository: r.repository,
    source_pr: r.source_pr,
    development_ticket: r.development_ticket,
  });
  setState(ctx, STATES.READ_GITHUB);
  return { continue: true };
}

async function readGithub(ctx) {
  const r = ctx.release;
  if (!r.repository && !r.source_pr) {
    warn(ctx, 'No GitHub repository/PR — skipping READ_GITHUB');
    setState(ctx, STATES.READ_JIRA);
    return { continue: true };
  }

  let owner;
  let repo;

  try {
    const gh = createGithubClient();
    if (r.repository) {
      ({ owner, repo } = parseRepo(r.repository));
    }

    if (r.source_pr && owner && repo) {
      const pr = await gh.getPull({ owner, repo, number: r.source_pr });
      r.pr_title = pr.title || null;
      r.pr_body = pr.body || null;
      r.source_branch = r.source_branch || pr.head?.ref || null;
      r.merge_commit = pr.merge_commit_sha || pr.head?.sha || null;
      r.pr_merged = Boolean(pr.merged);
      r.developer = r.developer || pr.user?.login || null;
      r.reviewers = (pr.requested_reviewers || []).map((u) => u.login).filter(Boolean);

      try {
        const commits = await gh.listPullCommits({ owner, repo, number: r.source_pr });
        r.commits = (commits || []).slice(0, 50).map((c) => ({
          sha: c.sha,
          message: c.commit?.message || '',
          author: c.commit?.author?.name || c.author?.login || null,
        }));
      } catch (err) {
        warn(ctx, `Could not list PR commits: ${err.message}`);
      }

      try {
        const files = await gh.listPullFiles({ owner, repo, number: r.source_pr });
        r.changed_files = (files || []).slice(0, 100).map((f) => f.filename);
      } catch (err) {
        warn(ctx, `Could not list PR files: ${err.message}`);
      }

      if (r.merge_commit) {
        try {
          const status = await gh.getCombinedStatus({ owner, repo, ref: r.merge_commit });
          r.ci_status = status?.state || null;
        } catch {
          try {
            const checks = await gh.listCheckRuns({ owner, repo, ref: r.merge_commit });
            const runs = checks?.check_runs || [];
            if (runs.length) {
              const failed = runs.some((c) => c.conclusion === 'failure');
              const pending = runs.some((c) => c.status !== 'completed');
              r.ci_status = failed ? 'failure' : pending ? 'pending' : 'success';
            }
          } catch (err) {
            warn(ctx, `CI status unavailable: ${err.message}`);
            r.ci_status = null;
          }
        }
      }

      setField(ctx, 'source_branch', r.source_branch, { confidence: 'high', source: 'github_pr' });
      setField(ctx, 'merge_commit', r.merge_commit, { confidence: 'high', source: 'github_pr' });
      if (r.developer) {
        setField(ctx, 'developer', r.developer, { confidence: 'high', source: 'github_pr' });
      }
    } else if (r.source_branch && owner && repo) {
      const sha = await gh.resolveSha({ owner, repo, shaOrRef: r.source_branch });
      r.merge_commit = sha;
      setField(ctx, 'merge_commit', sha, { confidence: 'high', source: 'github_branch' });
      setField(ctx, 'source_branch', r.source_branch, { confidence: 'high', source: 'user' });
    }

    if (owner && repo) {
      const tags = await gh.listTags({ owner, repo, per_page: 50 });
      ctx._tags = (tags || []).map((t) => t.name);
      r.component = r.component || componentFromRepo(`${owner}/${repo}`);
      setField(ctx, 'component', r.component, { confidence: 'high', source: 'repository' });
      setField(ctx, 'repository', `${owner}/${repo}`, { confidence: 'high', source: 'github' });
      r.repository = `${owner}/${repo}`;
    }

    // Extract Jira key from PR title/body/commits if missing
    if (!r.development_ticket) {
      const blob = [r.pr_title, r.pr_body, ...(r.commits || []).map((c) => c.message)]
        .filter(Boolean)
        .join('\n');
      const m = blob.match(JIRA_KEY_RE);
      if (m) {
        r.development_ticket = m[1].toUpperCase();
        setField(ctx, 'development_ticket', r.development_ticket, {
          confidence: 'medium',
          source: 'github_text',
        });
      }
    }

    audit(ctx, 'read_github_complete', {
      pr: r.source_pr,
      merge_commit: r.merge_commit,
      tags: (ctx._tags || []).length,
    });
  } catch (err) {
    return fail(ctx, err, 'read_github');
  }

  setState(ctx, STATES.READ_JIRA);
  return { continue: true };
}

async function readJira(ctx) {
  const r = ctx.release;

  try {
    const jira = createJiraClient();

    if (!r.development_ticket && (r.pr_title || r.source_branch || r.source_pr)) {
      const parts = [];
      if (r.source_pr) parts.push(`"PR #${r.source_pr}"`);
      if (r.source_branch) parts.push(`"${r.source_branch}"`);
      if (r.pr_title) parts.push(`"${String(r.pr_title).replace(/"/g, '\\"').slice(0, 80)}"`);
      if (parts.length) {
        const jql = `text ~ ${parts[0]} ORDER BY updated DESC`;
        try {
          const { issues } = await jira.searchIssues({
            jql,
            maxResults: 5,
            fields: ['summary', 'status', 'issuetype', 'project', 'assignee', 'description', 'issuelinks'],
          });
          if (issues?.length) {
            r.development_ticket = issues[0].key;
            setField(ctx, 'development_ticket', r.development_ticket, {
              confidence: 'medium',
              source: 'jira_search',
            });
          }
        } catch (err) {
          warn(ctx, `Jira search failed: ${err.message}`);
        }
      }
    }

    if (!r.development_ticket) {
      warn(ctx, 'No development Jira ticket found');
      markUnknown(ctx, 'development_ticket');
      setState(ctx, STATES.DETERMINE_VERSION);
      return { continue: true };
    }

    const data = await jira.getIssue(r.development_ticket, {
      fields: [
        'summary',
        'status',
        'issuetype',
        'project',
        'assignee',
        'description',
        'issuelinks',
        'resolution',
        'parent',
      ],
    });
    const f = data.fields || {};
    r.development_project = f.project?.key || null;
    r.development_issue_type = f.issuetype?.name || 'Task';
    r.development_parent_key = f.parent?.key || null;
    r.developer =
      r.developer || f.assignee?.displayName || f.assignee?.emailAddress || r.developer;

    setField(ctx, 'development_ticket', r.development_ticket, {
      confidence: 'high',
      source: 'jira',
    });
    if (r.developer) {
      setField(ctx, 'developer', r.developer, { confidence: 'high', source: 'jira_assignee' });
    }

    // Reuse linked QA / Deploy tickets if present
    const links = f.issuelinks || [];
    for (const link of links) {
      const other = link.outwardIssue || link.inwardIssue;
      if (!other?.key) continue;
      const summary = String(other.fields?.summary || other.key).toLowerCase();
      if (!r.qa_ticket && (/\[qa\]/.test(summary) || /\bqa\b/.test(summary))) {
        r.qa_ticket = other.key;
        setField(ctx, 'qa_ticket', other.key, { confidence: 'high', source: 'jira_link' });
      }
      if (
        !r.deployment_ticket &&
        (/\[deploy/.test(summary) || /\bdeploy/.test(summary))
      ) {
        r.deployment_ticket = other.key;
        setField(ctx, 'deployment_ticket', other.key, {
          confidence: 'high',
          source: 'jira_link',
        });
      }
    }

    ctx._jira_dev_summary = f.summary || null;
    ctx._jira_dev_description = adfToPlainText(f.description).trim() || null;
    ctx._jira_dev_status = f.status?.name || null;
    ctx._jira_dev_browse = browseUrl(jira.baseUrl, r.development_ticket);

    audit(ctx, 'read_jira_complete', {
      development_ticket: r.development_ticket,
      project: r.development_project,
      type: r.development_issue_type,
    });
  } catch (err) {
    return fail(ctx, err, 'read_jira');
  }

  setState(ctx, STATES.DETERMINE_VERSION);
  return { continue: true };
}

async function determineVersion(ctx) {
  const r = ctx.release;
  if (r.github_tag_created && r.next_version) {
    setState(ctx, STATES.CREATE_QA_TICKET);
    return { continue: true };
  }

  let tags = ctx._tags;
  if (!tags && r.repository) {
    try {
      const gh = createGithubClient();
      const { owner, repo } = parseRepo(r.repository);
      const list = await gh.listTags({ owner, repo, per_page: 50 });
      tags = (list || []).map((t) => t.name);
      ctx._tags = tags;
    } catch (err) {
      warn(ctx, `Could not list tags: ${err.message}`);
      tags = [];
    }
  }

  const proposal = proposeNextVersion(tags || [], {
    title: r.pr_title,
    body: r.pr_body,
    commits: r.commits,
  });

  r.previous_version = proposal.previous_version;
  r.next_version = proposal.next_version;
  r.version_bump = proposal.bump;
  r.version_reason = proposal.reason;

  setField(ctx, 'previous_version', r.previous_version, {
    confidence: r.previous_version ? 'high' : 'low',
    source: 'github_tags',
  });
  setField(ctx, 'next_version', r.next_version, {
    confidence: 'medium',
    source: 'semver_infer',
  });

  if (!r.merge_commit) {
    warn(ctx, 'No merge commit SHA — tag creation will need a SHA');
  }

  // Start args / user text asked to skip tagging
  if (r.tag_skipped || ctx._skip_tag) {
    r.tag_skipped = true;
    warn(ctx, 'Tag creation skipped by user request');
    audit(ctx, 'skip_tag', { next_version: r.next_version });
    if (isDraftMode(ctx)) {
      upsertDraftStep(ctx, {
        type: 'create_tag',
        title: 'Create Git tag',
        description: `Skip creating a Git tag. Version ${r.next_version} is still used for ticket titles.`,
        skip: true,
        payload: null,
      });
    }
    setState(ctx, STATES.CREATE_QA_TICKET);
    return {
      continue: true,
      message: `Skipping Git tag (proposed ${r.next_version}). Continuing to QA ticket…`,
    };
  }

  const payload = {
    repo: r.repository,
    tag: r.next_version,
    sha: r.merge_commit,
    message: `Release ${r.next_version}`,
    bump: r.version_bump,
    reason: r.version_reason,
    previous_version: r.previous_version,
  };

  if (isDraftMode(ctx)) {
    upsertDraftStep(ctx, {
      type: 'create_tag',
      title: 'Create Git tag',
      description: [
        `Create annotated tag \`${payload.tag}\` on \`${payload.repo}\` at commit \`${payload.sha || '?'}\`.`,
        `Bump: ${payload.bump} (${payload.reason}).`,
        payload.previous_version ? `Previous tag: ${payload.previous_version}.` : 'No previous stable tag found.',
      ].join(' '),
      payload,
    });
    audit(ctx, 'draft_plan_tag', payload);
    setState(ctx, STATES.CREATE_QA_TICKET);
    return { continue: true, message: `Draft: plan tag ${payload.tag}` };
  }

  ctx.pending_action = { type: 'create_tag', payload };
  setState(ctx, STATES.WAITING_FOR_CONFIRMATION, { resume: STATES.CREATE_TAG });
  audit(ctx, 'propose_tag', payload);

  return {
    pause: 'confirmation',
    pendingArgs: {
      workflowId: ctx.workflow.id,
      type: 'create_tag',
      payload,
    },
    message: [
      `Version proposal for ${r.repository || 'repo'}:`,
      `- Previous: ${r.previous_version || '(none)'}`,
      `- Suggested: ${r.next_version} (${r.version_bump})`,
      `- Reason: ${r.version_reason}`,
      `- SHA: ${r.merge_commit || '(missing)'}`,
      '',
      'Confirm to create the Git tag, skip to continue without tagging, or cancel.',
    ].join('\n'),
  };
}

function fail(ctx, err, tool) {
  ctx._last_error = {
    reason: err.message || String(err),
    stack: err.stack || null,
    tool,
  };
  setState(ctx, STATES.FAILED);
  audit(ctx, 'failed', ctx._last_error);
  return { pause: 'failed', message: `Failed in ${tool}: ${err.message}`, continue: false };
}

module.exports = {
  identifySource,
  readGithub,
  readJira,
  determineVersion,
  fail,
  parseStartInput,
  ticketSummary,
};
