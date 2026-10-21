-- Migration 013: submission_version now counts SUBMISSIONS by the applicant.
--   0 = draft, never submitted
--   1 = V1 (original submission)
--   2 = V2 (Resubmission 1)
--   3 = V3 (Resubmission 2 - final; no further resubmission allowed)
-- Previously it counted Changes-Requested cycles (migration 012).
UPDATE delivery_challans
SET submission_version = LEAST(3, CASE
  WHEN status = 'DRAFT' THEN 0
  WHEN status = 'CHANGES_REQUESTED' OR (status = 'SUBMITTED' AND gsoc_remarks IS NOT NULL)
    THEN GREATEST(COALESCE(rework_count, 0), 1)   -- currently waiting for the applicant to resubmit
  ELSE COALESCE(rework_count, 0) + 1              -- has been (re)submitted rework_count times already + this one
END);
