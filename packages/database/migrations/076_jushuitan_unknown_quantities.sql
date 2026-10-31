-- Products without a warehouse quantity record have a blank quantity block in
-- the official export. Preserve it as unknown rather than manufacturing zero.
ALTER TABLE jushuitan_inventory_snapshots ALTER COLUMN physical_qty DROP NOT NULL;
