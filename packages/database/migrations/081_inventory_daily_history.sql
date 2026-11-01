-- Daily history survives the five-run retention of raw exports. Only complete
-- snapshots can publish; replacing a day replaces its whole SKU set atomically.
CREATE TABLE jushuitan_inventory_history_days (
 business_date date NOT NULL,
 warehouse_name text NOT NULL,
 run_id uuid NOT NULL,
 captured_at timestamptz NOT NULL,
 record_count integer NOT NULL,
 PRIMARY KEY(business_date,warehouse_name)
);
CREATE TABLE jushuitan_inventory_history_records (
 business_date date NOT NULL,
 warehouse_name text NOT NULL,
 sku_code text NOT NULL,
 sku_id bigint,
 physical_qty bigint,
 reserved_qty bigint,
 in_transit_qty bigint,
 transfer_transit_qty bigint,
 incoming_qty bigint,
 return_qty bigint,
 PRIMARY KEY(business_date,warehouse_name,sku_code),
 FOREIGN KEY(business_date,warehouse_name) REFERENCES jushuitan_inventory_history_days ON DELETE CASCADE
);
CREATE INDEX jushuitan_history_sku_date ON jushuitan_inventory_history_records(sku_id,business_date);

CREATE FUNCTION publish_jushuitan_inventory_history(target_run uuid) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
 source jushuitan_inventory_runs%ROWTYPE;
 day_date date;
 accepted integer;
BEGIN
 SELECT * INTO source FROM jushuitan_inventory_runs WHERE id=target_run AND status='COMPLETE' AND finished_at IS NOT NULL;
 IF NOT FOUND OR source.received_count=0 THEN RETURN; END IF;
 IF (SELECT count(*) FROM jushuitan_inventory_snapshots WHERE run_id=target_run)<>source.received_count THEN RETURN; END IF;
 day_date := (source.finished_at AT TIME ZONE 'Asia/Shanghai')::date;
 INSERT INTO jushuitan_inventory_history_days(business_date,warehouse_name,run_id,captured_at,record_count)
 VALUES(day_date,source.warehouse_name,source.id,source.finished_at,source.received_count)
 ON CONFLICT(business_date,warehouse_name) DO UPDATE SET
  run_id=excluded.run_id,captured_at=excluded.captured_at,record_count=excluded.record_count
 WHERE (excluded.captured_at,excluded.run_id)>(jushuitan_inventory_history_days.captured_at,jushuitan_inventory_history_days.run_id);
 GET DIAGNOSTICS accepted=ROW_COUNT;
 IF accepted=0 THEN RETURN; END IF;
 DELETE FROM jushuitan_inventory_history_records WHERE business_date=day_date AND warehouse_name=source.warehouse_name;
 INSERT INTO jushuitan_inventory_history_records(business_date,warehouse_name,sku_code,sku_id,
  physical_qty,reserved_qty,in_transit_qty,transfer_transit_qty,incoming_qty,return_qty)
 SELECT day_date,source.warehouse_name,r.sku_code,s.id,r.physical_qty,r.reserved_qty,
  r.in_transit_qty,r.transfer_transit_qty,r.incoming_qty,r.return_qty
 FROM jushuitan_inventory_snapshots r LEFT JOIN skus s ON s.sku_code=r.sku_code WHERE r.run_id=source.id;
END $$;

CREATE FUNCTION capture_jushuitan_inventory_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 PERFORM publish_jushuitan_inventory_history(NEW.id);
 RETURN NEW;
END $$;
CREATE TRIGGER jushuitan_capture_daily_history AFTER INSERT OR UPDATE OF status,finished_at ON jushuitan_inventory_runs
 FOR EACH ROW WHEN (NEW.status='COMPLETE') EXECUTE FUNCTION capture_jushuitan_inventory_history();

-- Only recover each day's actual last complete run when its raw snapshot still
-- exists. Never substitute an earlier run or today's quantity for missing days.
DO $$ DECLARE source record; BEGIN
 FOR source IN SELECT DISTINCT ON (warehouse_name,(finished_at AT TIME ZONE 'Asia/Shanghai')::date) id
  FROM jushuitan_inventory_runs WHERE status='COMPLETE' AND finished_at IS NOT NULL
  ORDER BY warehouse_name,(finished_at AT TIME ZONE 'Asia/Shanghai')::date,finished_at DESC,id DESC
 LOOP PERFORM publish_jushuitan_inventory_history(source.id); END LOOP;
END $$;
