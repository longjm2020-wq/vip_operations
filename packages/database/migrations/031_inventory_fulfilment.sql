ALTER TABLE purchase_orders ADD COLUMN dispatch_account_id bigint REFERENCES supply_accounts(id);
ALTER TABLE purchase_orders ADD COLUMN tracked_receiving boolean NOT NULL DEFAULT false;
CREATE INDEX purchase_orders_dispatch_account ON purchase_orders(dispatch_account_id,id DESC);
ALTER TABLE supply_orders ADD COLUMN inventory_purchase_order_id bigint UNIQUE REFERENCES purchase_orders(id);
ALTER TABLE supply_order_items ADD COLUMN inventory_item_id bigint UNIQUE REFERENCES purchase_order_items(id);

CREATE TABLE inventory_sku_references (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 sku_id bigint NOT NULL UNIQUE REFERENCES skus(id), article_no text NOT NULL DEFAULT '',
 daily_sales numeric(12,4) CHECK(daily_sales>=0), return_rate numeric(8,6) CHECK(return_rate BETWEEN 0 AND 1),
 estimated_returns integer CHECK(estimated_returns>=0), target_days integer NOT NULL DEFAULT 14 CHECK(target_days BETWEEN 1 AND 365),
 source_note text NOT NULL, reference_date date NOT NULL, updated_by bigint NOT NULL REFERENCES users(id),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE inventory_transfers (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, transfer_no text NOT NULL UNIQUE,
 from_warehouse_id bigint NOT NULL REFERENCES warehouses(id), to_warehouse_id bigint NOT NULL REFERENCES warehouses(id),
 status text NOT NULL DEFAULT 'DRAFT' CHECK(status IN ('DRAFT','SHIPPED','COMPLETED','CANCELLED')),
 remark text NOT NULL, operator_id bigint NOT NULL REFERENCES users(id), version integer NOT NULL DEFAULT 1,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK(from_warehouse_id<>to_warehouse_id)
);
CREATE TABLE inventory_transfer_items (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, transfer_id bigint NOT NULL REFERENCES inventory_transfers(id),
 sku_id bigint NOT NULL REFERENCES skus(id), quantity integer NOT NULL CHECK(quantity>0),
 received_qty integer NOT NULL DEFAULT 0 CHECK(received_qty>=0 AND received_qty<=quantity),
 UNIQUE(transfer_id,sku_id)
);
CREATE TABLE inventory_shipments (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, shipment_no text NOT NULL UNIQUE,
 purchase_order_id bigint REFERENCES purchase_orders(id), transfer_id bigint REFERENCES inventory_transfers(id),
 warehouse_id bigint NOT NULL REFERENCES warehouses(id), method text NOT NULL CHECK(method IN ('DELIVERY','COURIER')),
 carrier text, tracking_no text, verification_code text,
 status text NOT NULL DEFAULT 'SHIPPED' CHECK(status IN ('SHIPPED','DELIVERED','INSPECTED')),
 note text NOT NULL DEFAULT '', tracking jsonb NOT NULL DEFAULT '{}', tracking_error text NOT NULL DEFAULT '',
 tracking_checked_at timestamptz, next_poll_at timestamptz, poll_token uuid,
 shipped_at timestamptz NOT NULL DEFAULT now(), delivered_at timestamptz, inspected_at timestamptz,
 operator_id bigint NOT NULL REFERENCES users(id), version integer NOT NULL DEFAULT 1,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK(num_nonnulls(purchase_order_id,transfer_id)=1),
 CHECK((method='DELIVERY' AND verification_code ~ '^[0-9]{4}$' AND carrier IS NULL AND tracking_no IS NULL) OR (method='COURIER' AND verification_code IS NULL AND carrier IS NOT NULL AND tracking_no IS NOT NULL))
);
CREATE INDEX inventory_shipments_po ON inventory_shipments(purchase_order_id);
CREATE INDEX inventory_shipments_transfer ON inventory_shipments(transfer_id);
CREATE INDEX inventory_shipments_poll ON inventory_shipments(next_poll_at) WHERE status='SHIPPED' AND method='COURIER';
CREATE TABLE inventory_verification_attempts (
 shipment_id bigint NOT NULL REFERENCES inventory_shipments(id), actor_id bigint NOT NULL REFERENCES users(id),
 attempts integer NOT NULL DEFAULT 0, started_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(shipment_id,actor_id)
);
CREATE TABLE inventory_shipment_items (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, shipment_id bigint NOT NULL REFERENCES inventory_shipments(id),
 sku_id bigint NOT NULL REFERENCES skus(id), purchase_order_item_id bigint REFERENCES purchase_order_items(id),
 transfer_item_id bigint REFERENCES inventory_transfer_items(id), quantity integer NOT NULL CHECK(quantity>0),
 qualified_qty integer CHECK(qualified_qty>=0), issues jsonb NOT NULL DEFAULT '[]', issue_note text NOT NULL DEFAULT '',
 putaway_qty integer NOT NULL DEFAULT 0 CHECK(putaway_qty>=0 AND putaway_qty<=coalesce(qualified_qty,0)),
 CHECK(num_nonnulls(purchase_order_item_id,transfer_item_id)=1), CHECK(qualified_qty IS NULL OR qualified_qty<=quantity),
 UNIQUE(shipment_id,sku_id)
);
CREATE INDEX inventory_shipment_items_purchase ON inventory_shipment_items(purchase_order_item_id);
CREATE INDEX inventory_shipment_items_sku ON inventory_shipment_items(sku_id);
CREATE TABLE inventory_putaways (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, shipment_item_id bigint NOT NULL REFERENCES inventory_shipment_items(id),
 warehouse_id bigint NOT NULL REFERENCES warehouses(id), quantity integer NOT NULL CHECK(quantity>0),
 operator_id bigint NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE inventory_transactions ADD COLUMN putaway_id bigint UNIQUE REFERENCES inventory_putaways(id);
ALTER TABLE inventory_transactions ADD COLUMN transfer_item_id bigint UNIQUE REFERENCES inventory_transfer_items(id);
-- Keep all immutable history and replace only the source-kind constraint.
DO $$ DECLARE c record; BEGIN
 FOR c IN SELECT conname FROM pg_constraint WHERE conrelid='inventory_transactions'::regclass AND contype='c' AND pg_get_constraintdef(oid) LIKE '%transaction_type%' LOOP
 EXECUTE format('ALTER TABLE inventory_transactions DROP CONSTRAINT %I',c.conname); END LOOP;
END $$;
ALTER TABLE inventory_transactions ADD CONSTRAINT inventory_transaction_sources CHECK(
 (transaction_type='PURCHASE_RECEIPT' AND receipt_item_id IS NOT NULL AND adjustment_id IS NULL AND putaway_id IS NULL AND transfer_item_id IS NULL AND physical_delta>0) OR
 (transaction_type IN ('STOCK_ADJUSTMENT','STOCKTAKE') AND adjustment_id IS NOT NULL AND receipt_item_id IS NULL AND putaway_id IS NULL AND transfer_item_id IS NULL) OR
 (transaction_type IN ('PROCUREMENT_PUTAWAY','TRANSFER_IN') AND putaway_id IS NOT NULL AND receipt_item_id IS NULL AND adjustment_id IS NULL AND transfer_item_id IS NULL AND physical_delta>0) OR
 (transaction_type='TRANSFER_OUT' AND transfer_item_id IS NOT NULL AND receipt_item_id IS NULL AND adjustment_id IS NULL AND putaway_id IS NULL AND physical_delta<0)
);
-- The supply manager can match orders to internal SKUs and perform receiving; warehouse posting remains explicit.
INSERT INTO role_permissions(role_id,permission_id) SELECT r.id,p.id FROM roles r CROSS JOIN permissions p
 WHERE r.code='SUPPLY_MANAGER' AND p.code IN ('inventory.read','product.read','warehouse.read','supplier.read','purchase.read','purchase.create','receipt.update','receipt.post') ON CONFLICT DO NOTHING;
