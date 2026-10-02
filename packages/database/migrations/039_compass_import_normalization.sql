-- Preserve completed snapshots while allowing the same original workbook to be
-- normalized again when new non-additive product attributes are supported.
ALTER TABLE compass_imports ADD COLUMN normalization_version SMALLINT NOT NULL DEFAULT 1 CHECK(normalization_version IN (1,2));
ALTER TABLE compass_imports DROP CONSTRAINT compass_imports_dimension_file_hash_key;
ALTER TABLE compass_imports ADD CONSTRAINT compass_imports_file_normalization_unique UNIQUE(dimension,file_hash,normalization_version);
