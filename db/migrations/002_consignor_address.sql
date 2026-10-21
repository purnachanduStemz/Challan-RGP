ALTER TABLE delivery_challans
  ALTER COLUMN challan_number TYPE VARCHAR(64),
  ADD COLUMN IF NOT EXISTS consignor_address TEXT,
  ADD COLUMN IF NOT EXISTS qmc_number VARCHAR(100);