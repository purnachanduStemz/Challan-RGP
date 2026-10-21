ALTER TABLE delivery_challans
  ADD COLUMN IF NOT EXISTS mode_of_transport VARCHAR(50);
