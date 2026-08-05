const { createJiraClient, JiraError, adfToPlainText } = require('../integrations/jiraClient');

/**
 * List comments on a Jira issue (newest last by default).
 * @param {{ issue: string, max?: number }} payload
 */
async function jiraListCommentsTask(payload = {}) {
  const issue = payload?.issue?.trim();
  if (!issue) throw new Error('Missing required field: issue');

  const max = Math.min(Math.max(Number(payload.max) || 20, 1), 50);
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

  const { comments, total } = await jira.getComments(issueKey, { maxResults: max });

  const mapped = comments.map((c, index) => {
    const bodyText = adfToPlainText(c.body).trim().slice(0, 500);
    return {
      id: String(c.id),
      index: index + 1,
      author: c.author?.displayName || c.author?.emailAddress || 'unknown',
      created: c.created,
      updated: c.updated,
      body: bodyText,
    };
  });

  return {
    issueKey,
    browseUrl: `${jira.baseUrl}/browse/${issueKey}`,
    total,
    comments: mapped,
  };
}

function formatListResult(result) {
  if (!result.comments.length) {
    return `No comments on ${result.issueKey}`;
  }
  const lines = [
    `${result.issueKey}: ${result.comments.length} comment(s) shown (total ${result.total})`,
    `URL: ${result.browseUrl}`,
  ];
  for (const c of result.comments) {
    lines.push(
      `#${c.index} id=${c.id} | ${c.author} | ${c.created}`,
      `  ${c.body || '(empty)'}`
    );
  }
  return lines.join('\n');
}

/**
 * Delete a comment by id, or the last comment when deleteLast is true.
 * @param {{ issue: string, commentId?: string, deleteLast?: boolean }} payload
 */
async function jiraDeleteCommentTask(payload = {}) {
  const issue = payload?.issue?.trim();
  if (!issue) throw new Error('Missing required field: issue');

  const commentId = payload.commentId != null ? String(payload.commentId).trim() : '';
  const deleteLast = Boolean(payload.deleteLast);

  if (!commentId && !deleteLast) {
    throw new Error('Provide commentId or set deleteLast=true');
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

  let targetId = commentId;
  let preview = null;

  if (deleteLast || !targetId) {
    const { comments } = await jira.getComments(issueKey, { maxResults: 50 });
    if (!comments.length) {
      throw new Error(`No comments to delete on ${issueKey}`);
    }
    const last = comments[comments.length - 1];
    targetId = String(last.id);
    preview = adfToPlainText(last.body).trim().slice(0, 200);
  }

  await jira.deleteComment(issueKey, targetId);

  return {
    issueKey,
    browseUrl: `${jira.baseUrl}/browse/${issueKey}`,
    deletedCommentId: targetId,
    preview,
  };
}

function formatDeleteResult(result) {
  const parts = [
    `Deleted comment ${result.deletedCommentId} on ${result.issueKey}`,
    `URL: ${result.browseUrl}`,
  ];
  if (result.preview) {
    parts.push(`Was: ${result.preview}`);
  }
  return parts.join('\n');
}

module.exports = {
  list: jiraListCommentsTask,
  delete: jiraDeleteCommentTask,
  formatListResult,
  formatDeleteResult,
};
