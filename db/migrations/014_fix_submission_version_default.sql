-- Migration 014: new challans must start at submission_version 0 (Draft) so the first submit is V1.
-- Migration 011 had set DEFAULT 1; databases that never ran 012 kept it, so a new challan showed V2 after submit.
ALTER TABLE delivery_challans ALTER COLUMN submission_version SET DEFAULT 0;

-- Re-normalise existing rows: drafts = 0, otherwise (times resubmitted after a send-back) + 1, capped at 3.
UPDATE delivery_challans
SET submission_version = LEAST(3, CASE
  WHEN status = 'DRAFT' THEN 0
  WHEN status = 'CHANGES_REQUESTED' OR (status = 'SUBMITTED' AND gsoc_remarks IS NOT NULL)
    THEN GREATEST(COALESCE(rework_count, 0), 1)
  ELSE COALESCE(rework_count, 0) + 1
END);
