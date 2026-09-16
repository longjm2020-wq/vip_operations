CREATE TABLE supply_aftersales (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 case_no text NOT NULL UNIQUE,
 order_id bigint NOT NULL REFERENCES supply_orders(id),
 kind text NOT NULL CHECK(kind IN ('REFUND','EXCHANGE')),
 status text NOT NULL DEFAULT 'REQUESTED' CHECK(status IN ('REQUESTED','ACCEPTED','RETURNING','RECEIVED','REPLACEMENT_SHIPPED','DONE','REJECTED','CANCELLED')),
 reason text NOT NULL,
 requested_by bigint NOT NULL REFERENCES users(id),
 total_quantity integer NOT NULL CHECK(total_quantity>0),
 amount numeric(20,2) NOT NULL CHECK(amount>=0),
 return_recipient jsonb,
 return_shipment jsonb,
 replacement_shipment jsonb,
 completed_at timestamptz,
 version integer NOT NULL DEFAULT 1,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX supply_aftersales_order ON supply_aftersales(order_id,id);
CREATE TABLE supply_aftersale_items (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 aftersale_id bigint NOT NULL REFERENCES supply_aftersales(id),
 order_item_id bigint NOT NULL REFERENCES supply_order_items(id),
 quantity integer NOT NULL CHECK(quantity>0),
 unit_price numeric(14,2) NOT NULL CHECK(unit_price>=0),
 UNIQUE(aftersale_id,order_item_id)
);
CREATE INDEX supply_aftersale_items_original ON supply_aftersale_items(order_item_id,aftersale_id);
CREATE TABLE supply_statement_entries (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 source_key text NOT NULL UNIQUE,
 order_id bigint NOT NULL REFERENCES supply_orders(id),
 account_id bigint NOT NULL REFERENCES supply_accounts(id),
 aftersale_id bigint REFERENCES supply_aftersales(id),
 kind text NOT NULL CHECK(kind IN ('SALE','REFUND','EXCHANGE')),
 amount numeric(20,2) NOT NULL,
 quantity integer NOT NULL CHECK(quantity>0),
 occurred_at timestamptz NOT NULL,
 CHECK((kind='SALE' AND amount>=0 AND aftersale_id IS NULL) OR (kind='REFUND' AND amount<=0 AND aftersale_id IS NOT NULL) OR (kind='EXCHANGE' AND amount=0 AND aftersale_id IS NOT NULL))
);
CREATE INDEX supply_statement_period ON supply_statement_entries(account_id,occurred_at,id);
CREATE INDEX supply_statement_order ON supply_statement_entries(order_id,id);
-- A database trigger covers door delivery, courier workers, and the old API during rollout.
CREATE FUNCTION record_supply_sale() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.status='DELIVERED' THEN
  INSERT INTO supply_statement_entries(source_key,order_id,account_id,kind,amount,quantity,occurred_at)
  VALUES('SALE:'||NEW.id,NEW.id,NEW.account_id,'SALE',NEW.total_amount,NEW.total_quantity,coalesce(NEW.delivered_at,now()))
  ON CONFLICT(source_key) DO NOTHING;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER supply_sale_completed AFTER INSERT OR UPDATE OF status ON supply_orders FOR EACH ROW EXECUTE FUNCTION record_supply_sale();
INSERT INTO supply_statement_entries(source_key,order_id,account_id,kind,amount,quantity,occurred_at)
SELECT 'SALE:'||id,id,account_id,'SALE',total_amount,total_quantity,coalesce(delivered_at,updated_at) FROM supply_orders WHERE status='DELIVERED' ON CONFLICT(source_key) DO NOTHING;
CREATE FUNCTION preserve_supply_statement() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Statement entries are append-only'; END $$;
CREATE TRIGGER supply_statement_immutable BEFORE UPDATE OR DELETE ON supply_statement_entries FOR EACH ROW EXECUTE FUNCTION preserve_supply_statement();
INSERT INTO permissions(code,name) VALUES('supply.reconcile','供应链对账与账单导出') ON CONFLICT(code) DO NOTHING;
INSERT INTO role_permissions(role_id,permission_id) SELECT r.id,p.id FROM roles r CROSS JOIN permissions p WHERE r.code IN ('ADMIN','SUPER_ADMIN','SUPPLY_MANAGER') AND p.code='supply.reconcile' ON CONFLICT DO NOTHING;
