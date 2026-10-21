ALTER TABLE challan_sequences
  ADD COLUMN IF NOT EXISTS location_code VARCHAR(3);

UPDATE challan_sequences
SET location_code = 'LEG'
WHERE location_code IS NULL;

ALTER TABLE challan_sequences
  ALTER COLUMN location_code SET NOT NULL;

ALTER TABLE challan_sequences
  DROP CONSTRAINT IF EXISTS challan_sequences_pkey;

ALTER TABLE challan_sequences
  ADD CONSTRAINT challan_sequences_pkey PRIMARY KEY (fiscal_year, location_code);