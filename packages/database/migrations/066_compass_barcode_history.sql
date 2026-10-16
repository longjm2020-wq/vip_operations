-- Daily normalized history is independent of disposable report imports. A later
-- complete report replaces the whole day, including absent barcodes and nulls.
CREATE TABLE compass_barcode_history_files (
 file_hash text PRIMARY KEY,
 normalization_version smallint NOT NULL
);
CREATE TABLE compass_barcode_history_days (
 business_date date PRIMARY KEY,
 source_import_id bigint NOT NULL,
 file_name text NOT NULL,
 file_hash text NOT NULL,
 source_start_date date NOT NULL,
 source_end_date date NOT NULL,
 normalization_version smallint NOT NULL,
 completed_at timestamptz NOT NULL
);
CREATE TABLE compass_barcode_history_records (
 business_date date NOT NULL REFERENCES compass_barcode_history_days(business_date) ON DELETE CASCADE,
 entity_key text NOT NULL,
 barcode text NOT NULL,
 payload jsonb NOT NULL,
 PRIMARY KEY(business_date,entity_key)
);
CREATE INDEX compass_barcode_history_code_date ON compass_barcode_history_records(barcode,business_date);

CREATE FUNCTION publish_compass_barcode_history(target_import_id bigint) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
 source compass_imports%ROWTYPE;
 accepted_dates date[];
BEGIN
 SELECT * INTO source FROM compass_imports WHERE id=target_import_id AND dimension='barcode' AND status='COMPLETE';
 IF NOT FOUND THEN RETURN; END IF;
 -- Callers publishing snapshots and changing the active import use the same lock.
 PERFORM pg_advisory_xact_lock(hashtextextended('compass-active:barcode',0));
 IF NOT EXISTS (
   SELECT 1 FROM compass_records WHERE import_id=source.id
   HAVING count(*)=source.expected_rows
      AND count(DISTINCT business_date)=source.end_date-source.start_date+1
      AND min(business_date)=source.start_date AND max(business_date)=source.end_date
 ) THEN RETURN; END IF;
 IF EXISTS(SELECT 1 FROM compass_barcode_history_files
   WHERE file_hash=source.file_hash AND normalization_version>source.normalization_version) THEN RETURN; END IF;
 INSERT INTO compass_barcode_history_files(file_hash,normalization_version) VALUES(source.file_hash,source.normalization_version)
 ON CONFLICT(file_hash) DO UPDATE SET normalization_version=GREATEST(compass_barcode_history_files.normalization_version,excluded.normalization_version);
 WITH accepted AS (
   INSERT INTO compass_barcode_history_days(
     business_date,source_import_id,file_name,file_hash,source_start_date,source_end_date,normalization_version,completed_at)
   SELECT day::date,source.id,source.file_name,source.file_hash,source.start_date,source.end_date,source.normalization_version,
     COALESCE(source.completed_at,source.created_at)
   FROM generate_series(source.start_date::timestamp,source.end_date::timestamp,interval '1 day') day
   ON CONFLICT(business_date) DO UPDATE SET
     source_import_id=excluded.source_import_id,file_name=excluded.file_name,file_hash=excluded.file_hash,
     source_start_date=excluded.source_start_date,source_end_date=excluded.source_end_date,
     normalization_version=excluded.normalization_version,completed_at=excluded.completed_at
   WHERE (excluded.completed_at,excluded.source_import_id)>
     (compass_barcode_history_days.completed_at,compass_barcode_history_days.source_import_id)
     AND NOT (excluded.file_hash=compass_barcode_history_days.file_hash
       AND excluded.normalization_version<compass_barcode_history_days.normalization_version)
   RETURNING business_date
 ) SELECT array_agg(business_date) INTO accepted_dates FROM accepted;
 IF accepted_dates IS NULL THEN RETURN; END IF;
 DELETE FROM compass_barcode_history_records WHERE business_date=ANY(accepted_dates);
 INSERT INTO compass_barcode_history_records(business_date,entity_key,barcode,payload)
 SELECT business_date,entity_key,barcode,
   jsonb_build_object('metrics',jsonb_build_object('salesQty',payload->'metrics'->'salesQty')) ||
   CASE WHEN payload ? 'reportedReturnRate' THEN jsonb_build_object('reportedReturnRate',payload->'reportedReturnRate') ELSE '{}'::jsonb END
 FROM compass_records
 WHERE import_id=source.id AND business_date=ANY(accepted_dates);
END $$;

CREATE FUNCTION compass_barcode_history_on_complete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 PERFORM publish_compass_barcode_history(NEW.id);
 RETURN NEW;
END $$;
CREATE TRIGGER compass_barcode_history_on_complete AFTER UPDATE OF status ON compass_imports
FOR EACH ROW WHEN (NEW.status='COMPLETE' AND NEW.dimension='barcode') EXECUTE FUNCTION compass_barcode_history_on_complete();

-- Recover each final daily winner once rather than rewriting every overlapping
-- retained report. Deleted old files are not recreated.
WITH complete AS (
 SELECT i.* FROM compass_imports i JOIN (
   SELECT r.import_id,count(*) AS n,count(DISTINCT r.business_date) AS days,
     min(r.business_date) AS first_date,max(r.business_date) AS last_date
   FROM compass_records r JOIN compass_imports i ON i.id=r.import_id
   WHERE i.dimension='barcode' AND i.status='COMPLETE' GROUP BY r.import_id
 ) stats ON stats.import_id=i.id
 WHERE stats.n=i.expected_rows AND stats.days=i.end_date-i.start_date+1
   AND stats.first_date=i.start_date AND stats.last_date=i.end_date
), versions AS (
 INSERT INTO compass_barcode_history_files(file_hash,normalization_version)
 SELECT file_hash,max(normalization_version) FROM complete GROUP BY file_hash RETURNING file_hash
), preferred AS (
 SELECT i.* FROM complete i WHERE NOT EXISTS(
   SELECT 1 FROM complete newer WHERE newer.file_hash=i.file_hash AND newer.normalization_version>i.normalization_version)
)
INSERT INTO compass_barcode_history_days(business_date,source_import_id,file_name,file_hash,source_start_date,source_end_date,normalization_version,completed_at)
SELECT DISTINCT ON (day::date) day::date,i.id,i.file_name,i.file_hash,i.start_date,i.end_date,i.normalization_version,COALESCE(i.completed_at,i.created_at)
FROM preferred i CROSS JOIN LATERAL generate_series(i.start_date::timestamp,i.end_date::timestamp,interval '1 day') day
ORDER BY day::date,COALESCE(i.completed_at,i.created_at) DESC,i.normalization_version DESC,i.id DESC;
INSERT INTO compass_barcode_history_records(business_date,entity_key,barcode,payload)
SELECT r.business_date,r.entity_key,r.barcode,
 jsonb_build_object('metrics',jsonb_build_object('salesQty',r.payload->'metrics'->'salesQty')) ||
 CASE WHEN r.payload ? 'reportedReturnRate' THEN jsonb_build_object('reportedReturnRate',r.payload->'reportedReturnRate') ELSE '{}'::jsonb END
FROM compass_barcode_history_days d JOIN compass_records r
 ON r.import_id=d.source_import_id AND r.business_date=d.business_date;
