# Workflow State Machine

The Release Workflow is implemented as a deterministic state machine that owns the
`ReleaseContext`.

The LLM is responsible for:
- reasoning
- summarisation
- asking questions
- proposing actions

The workflow engine is responsible for:
- state transitions
- persistence
- approvals
- execution
- recovery

The workflow may be paused after any state and resumed later.

---

## ReleaseContext

```yaml
workflow:
  id:
  state:
  started_at:
  updated_at:

release:
  repository:
  component:

  source_pr:
  source_branch:
  merge_commit:

  developer:

  development_ticket:
  qa_ticket:
  deployment_ticket:

  previous_version:
  next_version:

  github_tag_created: false

  release_summary:
  technical_summary:

  rollback_plan:
  risk:
  security:
  customer_impact:
  monitoring_owner:

  checklist_complete: false

pending_action:
  type:
  payload:

unknown_fields: []

warnings: []

audit_log: []
```

---

# State Diagram

```text
START

↓

IDENTIFY_SOURCE

↓

READ_GITHUB

↓

READ_JIRA

↓

DETERMINE_VERSION

↓

CREATE_TAG

↓

CREATE_QA_TICKET

↓

CREATE_DEPLOYMENT_TICKET

↓

LINK_JIRA

↓

GENERATE_RELEASE_CONTEXT

↓

RESOLVE_UNKNOWN_FIELDS

↓

REVIEW_RELEASE

↓

VALIDATE

↓

EXPORT

↓

COMPLETE
```

At any point

```text
↓

WAITING_FOR_CONFIRMATION

↓

(previous state resumes)
```

or

```text
↓

FAILED

↓

RECOVER

↓

(previous state)
```

---

# States

---

## START

Entry

Workflow created.

Input

- PR
- Jira
- Branch
- Repository

Transition

↓

IDENTIFY_SOURCE

---

## IDENTIFY_SOURCE

Goal

Determine the release source.

Actions

Read-only

Examples

Input

```
Release PR #184
```

Result

```
Repository

fcms-vhcl-allocation-optn-generator-func-app

PR

184
```

Updates

```
repository

source_pr
```

Transition

↓

READ_GITHUB

---

## READ_GITHUB

Goal

Collect all GitHub metadata.

Actions

- Read PR
- Read commits
- Read changed files
- Read author
- Read reviewers
- Read merge commit
- Read repository
- Read releases
- Read tags

Updates

```
developer

merge_commit

component
```

If Jira key found

↓

READ_JIRA

Else

Search commits

↓

READ_JIRA

---

## READ_JIRA

Goal

Populate development information.

Actions

Read

- Jira issue
- description
- assignee
- linked issues
- comments

Updates

```
development_ticket

developer
```

Transition

↓

DETERMINE_VERSION

---

## DETERMINE_VERSION

Goal

Determine next release version.

Actions

Read

- existing tags

Infer

```
major

minor

patch
```

Produce proposal

```
Current

v2.0.0

Suggested

v2.0.1
```

Set

```
pending_action

type=create_tag
```

Transition

↓

WAITING_FOR_CONFIRMATION

---

## CREATE_TAG

Entry

After approval.

Actions

Create Git tag.

Updates

```
next_version

github_tag_created=true
```

Transition

↓

CREATE_QA_TICKET

---

## CREATE_QA_TICKET

Search

Existing QA ticket.

If found

Reuse.

Else

Preview

```
Create QA ticket?
```

Set

```
pending_action=create_jira
```

Transition

↓

WAITING_FOR_CONFIRMATION

---

## CREATE_DEPLOYMENT_TICKET

Same behaviour.

Search first.

Reuse.

Otherwise

Create after approval.

Transition

↓

LINK_JIRA

---

## LINK_JIRA

Preview

```
Development

↓

QA

↓

Deployment
```

Approval required.

Execute.

Transition

↓

GENERATE_RELEASE_CONTEXT

---

## GENERATE_RELEASE_CONTEXT

Generate

- release summary
- technical summary
- rollback
- risk
- customer impact
- monitoring owner

Populate every field possible.

Unknown values become

```
unknown_fields[]
```

Transition

↓

RESOLVE_UNKNOWN_FIELDS

---

## RESOLVE_UNKNOWN_FIELDS

For every unknown field

Attempt inference.

If impossible

Ask user.

Example

```
Customer communication

Unknown.

Required?

[y/N]
```

If skipped

Store

```
Skipped by user
```

Continue.

Never block.

Transition

↓

REVIEW_RELEASE

---

## REVIEW_RELEASE

Present

Entire ReleaseContext.

Every field includes

- value
- confidence
- source

Example

```
Previous Version

v2.0.0

Source

GitHub

Confidence

100%
```

Allow edits.

Transition

↓

VALIDATE

---

## VALIDATE

Run validation rules.

Examples

✓ PR merged

✓ CI passed

✓ Tag exists

✓ QA ticket

✓ Deployment ticket

✓ Jira resolved

✓ Checklist complete

Warnings added to

```
warnings[]
```

Transition

↓

EXPORT

---

## EXPORT

Generate

- release checklist
- release notes
- deployment summary

Mark

```
checklist_complete=true
```

Transition

↓

COMPLETE

---

## COMPLETE

Workflow ends.

Persist ReleaseContext.

Audit log complete.

---

## WAITING_FOR_CONFIRMATION

Triggered whenever a mutating action is proposed.

Examples

- Create Git tag
- Create Jira
- Link Jira
- Update Jira
- Push release

Workflow pauses.

Stores

```yaml
pending_action:
  type:
  payload:
```

On approval

Execute action.

Return to originating state.

On rejection

Cancel action.

Continue where possible.

---

## FAILED

Entered whenever

- tool error
- network failure
- API failure

Record

```
reason

stack

tool
```

Transition

↓

RECOVER

---

## RECOVER

Retry policy.

1.

Retry transient failures.

2.

If still failing

Ask user.

3.

If action optional

Skip.

4.

Resume previous state.

---

# State Transition Table

| Current | Event | Next |
|----------|------|------|
| START | initialized | IDENTIFY_SOURCE |
| IDENTIFY_SOURCE | source identified | READ_GITHUB |
| READ_GITHUB | completed | READ_JIRA |
| READ_JIRA | completed | DETERMINE_VERSION |
| DETERMINE_VERSION | approval required | WAITING_FOR_CONFIRMATION |
| WAITING_FOR_CONFIRMATION | approved | CREATE_TAG |
| CREATE_TAG | completed | CREATE_QA_TICKET |
| CREATE_QA_TICKET | exists/created | CREATE_DEPLOYMENT_TICKET |
| CREATE_DEPLOYMENT_TICKET | exists/created | LINK_JIRA |
| LINK_JIRA | completed | GENERATE_RELEASE_CONTEXT |
| GENERATE_RELEASE_CONTEXT | completed | RESOLVE_UNKNOWN_FIELDS |
| RESOLVE_UNKNOWN_FIELDS | completed | REVIEW_RELEASE |
| REVIEW_RELEASE | approved | VALIDATE |
| VALIDATE | passed | EXPORT |
| EXPORT | completed | COMPLETE |
| ANY | API failure | FAILED |
| FAILED | recoverable | RECOVER |
| RECOVER | resumed | Previous State |
| ANY mutating state | confirmation required | WAITING_FOR_CONFIRMATION |

---

# Design Principles

- The **workflow engine** owns the state machine and `ReleaseContext`.
- The **LLM** is stateless and is used only to infer, summarize, and interact with the user.
- All **read operations** execute automatically.
- All **write operations** are staged through `WAITING_FOR_CONFIRMATION`.
- Every state is **idempotent**, allowing the workflow to be resumed after interruptions without repeating completed actions.
- Every state appends to the `audit_log`, providing a complete history of decisions, user approvals, and executed actions.




# Release Context Workflow

## Goal

Given a Pull Request, GitHub branch, Jira issue, or repository, guide the user through creating a production release.

The AI should:

- gather release information from GitHub and Jira
- determine the next release version
- create required Jira tickets
- create the Git tag
- infer as much of the release checklist as possible
- ask the user only for information it cannot determine
- require confirmation before every mutating action
- maintain a single evolving Release Context object throughout the interaction

---

# Principles

## Human in the loop

Every write operation follows:

Preview
↓
User approval
↓
Execute
↓
Update Release Context

Never perform mutating actions automatically.

---

## Read first

The AI should exhaust every available source before asking the user.

Priority:

1. GitHub
2. Jira
3. Existing release tags
4. PR description
5. Commit history
6. Repository metadata
7. User

The user should only be asked when information cannot be inferred.

---

## Context Driven

Maintain a Release Context throughout the session.

Example:

```yaml
release:
  repository:
  component:

  source_pr:
  source_branch:

  developer:

  development_ticket:

  qa_ticket:

  deployment_ticket:

  previous_version:

  next_version:

  release_summary:

  rollback_plan:

  risk:

  security:

  monitoring_owner:

  customer_impact:

  github_tag_created: false

  checklist_complete: false
```

Every successful step updates this object.

---

# Workflow

## Stage 1 — Identify Release Source

Input may be:

- PR
- Jira
- branch
- repository
- commit

Examples

> Release PR #184

> Prepare release for P25-3522

> Release feature/string-vehicle-id

AI should normalize this into a Release Context.

---

## Stage 2 — Read GitHub

Without asking the user:

Collect

- repository
- merged PR
- title
- description
- commits
- changed files
- reviewers
- merge commit
- branch
- author

Update context.

---

## Stage 3 — Read Jira

Locate linked Jira.

If missing:

Search

- PR title
- branch name
- commit messages

If still missing:

Ask user.

Retrieve

- summary
- description
- assignee
- status
- linked issues

Update context.

---

## Stage 4 — Determine Version

Inspect repository tags.

Find

Latest stable tag

Example

v2.0.0

Determine next version.

Rules

Breaking change

→ major

New feature

→ minor

Bug fix

→ patch

Present proposal.

Example

Current

v2.0.0

Suggested

v2.0.1

Reason

Bug fix

Wait for approval.

After approval

Create Git tag.

Update context.

---

## Stage 5 — Generate Release Summary

Read

- Jira
- PR
- commits

Generate

- Release Summary
- Technical Summary
- User Impact

Ask user if they wish to edit.

Update context.

---

## Stage 6 — QA Ticket

Search Jira.

If QA ticket already exists

Reuse.

Else

Preview creation.

After approval

Create.

Store issue key.

---

## Stage 7 — Deployment Ticket

Same flow.

Search first.

Reuse if present.

Otherwise create.

---

## Stage 8 — Link Issues

Preview

Development

↓

QA

↓

Deployment

After approval

Create links.

---

## Stage 9 — Populate Checklist Fields

Attempt to infer every field.

Examples

Developer

← Jira assignee

Component

← repository metadata

Repository

← GitHub

Previous Release

← latest tag

Current Release

← new tag

Development Jira

← linked issue

QA Jira

← created issue

Deployment Jira

← created issue

Monitoring Owner

← assignee

Release Summary

← generated

Risk

← inferred

Rollback

← inferred

Security

← dependency scan

Only ask about fields that remain unknown.

---

## Stage 10 — Unknown Field Resolution

For every missing field

AI should display

Unknown

Reason

Possible sources

Example

Customer communication

Unable to determine.

Is customer communication required?

[y/N]

If user skips

Mark

Unknown (User skipped)

Never block workflow.

---

## Stage 11 — Checklist Review

Display completed checklist.

Every field includes confidence.

Example

Developer

Karan

Confidence

100%

Risk

Low

Confidence

70%

Customer communication

Unknown

Confidence

0%

Allow editing.

---

## Stage 12 — Final Validation

Run validations.

Examples

✓ PR merged

✓ Tag exists

✓ Deployment ticket exists

✓ QA ticket exists

✓ Development Jira resolved

✓ CI passing

✓ Reviewer approval

Warn if incomplete.

---

## Stage 13 — Export

Generate

- Release Checklist
- Release Notes
- Deployment Summary

Ready for production.

---

# Question Strategy

Never ask

"What is the rollback plan?"

Instead

Attempt

"No DB changes detected.

Suggested rollback:

Redeploy v2.0.0

Accept?"

---

Never ask

"What is the release summary?"

Instead

Generate one.

---

Never ask

"What is the risk?"

Instead

Infer one.

---

Only ask questions when:

- GitHub cannot answer
- Jira cannot answer
- Repository cannot answer
- User judgement is required

---

# Mutating Actions

Require confirmation.

- Create tag
- Create Jira
- Link Jira
- Update Jira
- Close Jira
- Push Git tag
- Update release checklist

---

# Read Actions

No confirmation required.

- Read PR
- Read commits
- Read Jira
- Read repository
- Read tags
- Read releases
- Read CI
- Read dependency scans

---

# Completion Criteria

The workflow completes when:

- every required checklist field is either

  - populated

  OR

  - explicitly skipped by the user

AND

- release artifacts exist

  - Git tag

  - QA Jira

  - Deployment Jira

AND

- final review has been approved.

The resulting Release Context should contain all information necessary to populate the release checklist and serve as the single source of truth for the release.
