const { createJiraClient, JiraError, browseUrl } = require('../integrations/jiraClient');

/**
 * Update a Jira issue: optional status, comment, and/or description (markdown).
 * @param {{ issue: string, status?: string, comment?: string, description?: string }} payload
 */
async function jiraUpdateTask(payload) {
  const issue = payload?.issue?.trim();
  const status = payload?.status?.trim() || undefined;
  const comment = payload?.comment?.trim() || undefined;
  const description =
    payload?.description !== undefined && payload?.description !== null
      ? String(payload.description)
      : undefined;

  if (!issue) {
    throw new Error('Missing required field: issue');
  }
  if (!status && !comment && description === undefined) {
    throw new Error('Provide at least one of: status, comment, description');
  }

  const jira = createJiraClient();

  let issueKey;
  try {
    const issueData = await jira.getIssue(issue);
    issueKey = issueData.key || issue;
  } catch (err) {
    if (err instanceof JiraError && err.status === 404) {
      throw new Error(`Issue not found: ${issue}`);
    }
    throw err;
  }

  const result = {
    issueKey,
    browseUrl: browseUrl(jira.baseUrl, issueKey),
    transitionedTo: null,
    commentAdded: false,
    descriptionUpdated: false,
  };

  if (status) {
    const transitions = await jira.getTransitions(issueKey);
    const match = transitions.find(
      (t) => t.name?.toLowerCase() === status.toLowerCase()
    );

    if (!match) {
      const available = transitions.map((t) => t.name).filter(Boolean);
      const list = available.length ? available.join(', ') : '(none available)';
      throw new Error(
        `No transition named "${status}" for ${issueKey}. Available: ${list}`
      );
    }

    await jira.transitionIssue(issueKey, match.id);
    result.transitionedTo = match.name;
  }

  if (description !== undefined) {
    await jira.updateIssue(issueKey, { description });
    result.descriptionUpdated = true;
  }

  if (comment) {
    await jira.addComment(issueKey, comment);
    result.commentAdded = true;
  }

  return result;
}

function formatResult(result) {
  const parts = [`Updated ${result.issueKey}`];
  if (result.transitionedTo) {
    parts.push(`status → ${result.transitionedTo}`);
  }
  if (result.descriptionUpdated) {
    parts.push('description updated');
  }
  if (result.commentAdded) {
    parts.push('comment added');
  }
  if (result.browseUrl) {
    parts.push(`URL: ${result.browseUrl}`);
  }
  return parts.join('; ');
}

module.exports = jiraUpdateTask;
module.exports.formatResult = formatResult;
