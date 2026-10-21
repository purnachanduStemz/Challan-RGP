/**
 * Transition table for the Returnable Gate Pass (RGP) workflow.
 * Any transition not covered here must be rejected with 422 INVALID_TRANSITION.
 *
 *   DRAFT --submit--> SUBMITTED (pending Center Manager)
 *   SUBMITTED --cm-approve--> CM_APPROVED (pending GSOC)
 *   SUBMITTED --cm-reject--> CHANGES_REQUESTED (applicant may resubmit; max 3 versions in total)
 *   CM_APPROVED --send-back--> SUBMITTED (GSOC reject / need info -> back to CM)
 *   CM_APPROVED --approve-and-issue--> ISSUED (GSOC final approval)
 *   ISSUED --gate-out--> GATE_OUT --return--> RETURNED / PARTIALLY_RETURNED
 */
const TRANSITIONS = {
  submit: {
    from: ['DRAFT', 'CHANGES_REQUESTED'], // at most 3 submissions in total: V1, then V2 and V3 as resubmissions
    to: 'SUBMITTED',
    roles: ['PREPARER']
  },
  'cm-approve': {
    from: ['SUBMITTED'],
    to: 'CM_APPROVED',
    roles: ['CENTER_MANAGER']
  },
  'cm-reject': {
    from: ['SUBMITTED'],
    to: 'CHANGES_REQUESTED',
    roles: ['CENTER_MANAGER'],
    requiresReason: true
  },
  'send-back': {
    from: ['CM_APPROVED'],
    to: 'SUBMITTED',
    roles: ['AUTHORIZER'],
    requiresReason: true
  },
  'approve-and-issue': {
    from: ['CM_APPROVED'], // GSOC can only act after the CM has approved
    to: 'ISSUED',
    roles: ['AUTHORIZER']
  },
  cancel: {
    // ISSUED has an extra precondition (no gate-out / return yet), checked in the route.
    // CENTER_MANAGER may only cancel before GSOC approval (checked in the route).
    from: ['DRAFT', 'SUBMITTED', 'CM_APPROVED', 'ISSUED'],
    to: 'CANCELLED',
    roles: ['AUTHORIZER', 'CENTER_MANAGER'],
    requiresReason: true
  },
  'gate-out': {
    from: ['ISSUED'],
    to: 'GATE_OUT',
    roles: ['SECURITY']
  },
  // 'return' has two possible outcomes depending on is_full_return; handled specially in the route.
  'return-full': {
    from: ['ISSUED', 'GATE_OUT', 'PARTIALLY_RETURNED'],
    to: 'RETURNED',
    roles: ['PREPARER', 'CENTER_MANAGER', 'AUTHORIZER']
  },
  'return-partial': {
    from: ['ISSUED', 'GATE_OUT'],
    to: 'PARTIALLY_RETURNED',
    roles: ['PREPARER', 'CENTER_MANAGER', 'AUTHORIZER']
  },
  // Creates a NEW draft from an existing challan (any status); the source is unchanged.
  clone: {
    from: ['DRAFT', 'SUBMITTED', 'CM_APPROVED', 'CHANGES_REQUESTED', 'ISSUED', 'GATE_OUT', 'PARTIALLY_RETURNED', 'RETURNED', 'CANCELLED'],
    to: 'DRAFT',
    roles: ['PREPARER']
  }
};

function getTransition(action) {
  return TRANSITIONS[action];
}

function isRoleAllowed(action, role) {
  const t = getTransition(action);
  return !!t && t.roles.includes(role);
}

function isFromStatusAllowed(action, currentStatus) {
  const t = getTransition(action);
  return !!t && t.from.includes(currentStatus);
}

// The applicant may submit a challan at most 3 times: V1 (original), V2 (resubmission 1),
// V3 (resubmission 2, final). submission_version = how many times it has been submitted.
const MAX_SUBMISSION_VERSIONS = 3;
const VERSION_NAMES = { 1: 'Original Submission', 2: 'Resubmission 1', 3: 'Resubmission 2 (Final)' };
function versionLabel(n) {
  return `V${n} \u00b7 ${VERSION_NAMES[n] || 'Resubmission'}`;
}

module.exports = { TRANSITIONS, getTransition, isRoleAllowed, isFromStatusAllowed, MAX_SUBMISSION_VERSIONS, versionLabel };
