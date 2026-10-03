-- The original daily return percentage is distinct from the analytics ratio
-- recomputed from cumulative counts. Keep existing report snapshots unchanged.
ALTER TABLE compass_imports DROP CONSTRAINT compass_imports_normalization_version_check;
ALTER TABLE compass_imports ADD CONSTRAINT compass_imports_normalization_version_check
  CHECK(normalization_version IN (1,2,3));
CREATE INDEX compass_records_barcode_date ON compass_records(import_id,barcode,business_date);
