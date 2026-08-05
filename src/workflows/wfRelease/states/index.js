const { STATES } = require('../context');
const readAndVersion = require('./readAndVersion');
const mutating = require('./mutating');
const checklist = require('./checklist');

const handlers = {
  [STATES.START]: async (ctx) => {
    const { setState } = require('../context');
    setState(ctx, STATES.IDENTIFY_SOURCE);
    return { continue: true };
  },
  [STATES.IDENTIFY_SOURCE]: readAndVersion.identifySource,
  [STATES.READ_GITHUB]: readAndVersion.readGithub,
  [STATES.READ_JIRA]: readAndVersion.readJira,
  [STATES.DETERMINE_VERSION]: readAndVersion.determineVersion,
  [STATES.CREATE_TAG]: mutating.createTag,
  [STATES.CREATE_QA_TICKET]: mutating.createQaTicket,
  [STATES.CREATE_DEPLOYMENT_TICKET]: mutating.createDeploymentTicket,
  [STATES.LINK_JIRA]: mutating.linkJira,
  [STATES.GENERATE_RELEASE_CONTEXT]: checklist.generateReleaseContext,
  [STATES.RESOLVE_UNKNOWN_FIELDS]: checklist.resolveUnknownFields,
  [STATES.REVIEW_RELEASE]: checklist.reviewRelease,
  [STATES.DRAFT_REVIEW]: checklist.draftReview,
  [STATES.VALIDATE]: checklist.validate,
  [STATES.EXPORT]: checklist.exportArtifacts,
  [STATES.COMPLETE]: async (ctx) => ({
    pause: 'complete',
    done: true,
    message: `Workflow ${ctx.workflow.id} already complete.`,
  }),
  [STATES.WAITING_FOR_CONFIRMATION]: async (ctx) => ({
    pause: 'confirmation',
    pendingArgs: ctx.pending_action
      ? {
          workflowId: ctx.workflow.id,
          type: ctx.pending_action.type,
          payload: ctx.pending_action.payload,
        }
      : null,
    message: 'Waiting for confirmation of the pending release action.',
  }),
  [STATES.FAILED]: async (ctx) => {
    const { setState } = require('../context');
    setState(ctx, STATES.RECOVER);
    return { continue: true };
  },
  [STATES.RECOVER]: checklist.recover,
};

module.exports = {
  handlers,
  executeCreateTag: mutating.executeCreateTag,
  executeCreateQa: mutating.executeCreateQa,
  executeCreateDeploy: mutating.executeCreateDeploy,
};
