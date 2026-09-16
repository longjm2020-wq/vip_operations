CREATE TABLE supply_order_settings (id integer PRIMARY KEY CHECK(id=1), recipient jsonb NOT NULL, updated_by bigint NOT NULL REFERENCES users(id), updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE supply_orders (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 order_no text NOT NULL UNIQUE,
 account_id bigint NOT NULL REFERENCES supply_accounts(id),
 buyer_id bigint NOT NULL REFERENCES users(id),
 supplier_name text NOT NULL,
 status text NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','PICKING','SHIPPED','DELIVERED','CANCELLED')),
 recipient jsonb NOT NULL,
 requirement text NOT NULL DEFAULT '',
 required_date date NOT NULL,
 total_quantity integer NOT NULL CHECK(total_quantity>0),
 total_amount numeric(20,2) NOT NULL CHECK(total_amount>=0),
 shipping_method text CHECK(shipping_method IN ('DELIVERY','COURIER')),
 carrier text, tracking_no text, shipping_note text NOT NULL DEFAULT '',
 tracking jsonb NOT NULL DEFAULT '{}', tracking_error text NOT NULL DEFAULT '',
 tracking_checked_at timestamptz, next_poll_at timestamptz, poll_token uuid,
 supplier_read_at timestamptz, buyer_read_at timestamptz,
 shipped_at timestamptz, delivered_at timestamptz,
 version integer NOT NULL DEFAULT 1,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX supply_orders_supplier ON supply_orders(account_id,id DESC);
CREATE INDEX supply_orders_status ON supply_orders(status,id DESC);
CREATE INDEX supply_orders_poll ON supply_orders(next_poll_at) WHERE status='SHIPPED' AND shipping_method='COURIER';
CREATE UNIQUE INDEX supply_orders_tracking ON supply_orders(carrier,tracking_no) WHERE shipping_method='COURIER';
CREATE TABLE supply_order_items (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 order_id bigint NOT NULL REFERENCES supply_orders(id),
 product_id bigint NOT NULL REFERENCES supply_products(id),
 color text NOT NULL, size text NOT NULL,
 quantity integer NOT NULL CHECK(quantity>0),
 unit_price numeric(14,2) NOT NULL CHECK(unit_price>=0),
 snapshot jsonb NOT NULL,
 UNIQUE(order_id,product_id,color,size)
);
CREATE INDEX supply_order_items_product ON supply_order_items(product_id,order_id);
CREATE TABLE supply_order_events (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 order_id bigint NOT NULL REFERENCES supply_orders(id),
 actor_id bigint REFERENCES users(id),
 body text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX supply_order_events_order ON supply_order_events(order_id,id);
INSERT INTO permissions(code,name) VALUES('supply.purchase','供应链采买与订单管理') ON CONFLICT(code) DO NOTHING;
INSERT INTO role_permissions(role_id,permission_id) SELECT r.id,p.id FROM roles r CROSS JOIN permissions p WHERE r.code IN ('ADMIN','SUPER_ADMIN','SUPPLY_MANAGER') AND p.code='supply.purchase' ON CONFLICT DO NOTHING;
