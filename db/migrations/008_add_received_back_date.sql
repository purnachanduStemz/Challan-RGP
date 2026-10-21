ALTER TABLE delivery_challans
  ADD COLUMN IF NOT EXISTS received_back_date DATE;

UPDATE delivery_challans
SET received_back_date = received_back_by::date
WHERE received_back_date IS NULL
  AND received_back_by ~ '^\\d{4}-\\d{2}-\\d{2}$';
