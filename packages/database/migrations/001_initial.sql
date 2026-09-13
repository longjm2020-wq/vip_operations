CREATE TABLE users (id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
username VARCHAR(100) NOT NULL UNIQUE, display_name VARCHAR(100) NOT NULL, password_hash TEXT NOT NULL, status VARCHAR(32) NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE','INACTIVE')),
created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now());

CREATE TABLE roles (id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
code VARCHAR(50) NOT NULL UNIQUE,name VARCHAR(100) NOT NULL,
created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now());

CREATE TABLE permissions (id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
code VARCHAR(100) NOT NULL UNIQUE,name VARCHAR(100) NOT NULL,
created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now());

CREATE TABLE user_roles(user_id BIGINT REFERENCES users(id),role_id BIGINT REFERENCES roles(id),PRIMARY KEY(user_id,role_id));

CREATE TABLE role_permissions(role_id BIGINT REFERENCES roles(id),permission_id BIGINT REFERENCES permissions(id),PRIMARY KEY(role_id,permission_id));

CREATE TABLE sessions (id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
user_id BIGINT NOT NULL REFERENCES users(id),token_hash VARCHAR(128) NOT NULL UNIQUE,csrf_token VARCHAR(128) NOT NULL,expires_at TIMESTAMPTZ NOT NULL,revoked_at TIMESTAMPTZ,
created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now());

CREATE TABLE suppliers (id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
supplier_code VARCHAR(50) NOT NULL UNIQUE,name VARCHAR(255) NOT NULL,contact_name VARCHAR(100),phone VARCHAR(50),address TEXT,default_lead_time_days INTEGER CHECK(default_lead_time_days>=0),moq INTEGER CHECK(moq>0),status VARCHAR(32) NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE','INACTIVE')),
created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now());

CREATE TABLE warehouses (id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
code VARCHAR(50) NOT NULL UNIQUE,name VARCHAR(100) NOT NULL,address TEXT,status VARCHAR(32) NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE','INACTIVE')),
created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now());

CREATE TABLE brands (id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
code VARCHAR(50) NOT NULL UNIQUE,name VARCHAR(100) NOT NULL,status VARCHAR(32) NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE','INACTIVE')),
created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now());

CREATE TABLE categories (id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
code VARCHAR(50) NOT NULL UNIQUE,name VARCHAR(100) NOT NULL,parent_id BIGINT REFERENCES categories(id),status VARCHAR(32) NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE','INACTIVE')),
created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),CHECK(parent_id IS NULL OR parent_id<>id));

CREATE TABLE products (id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
style_no VARCHAR(64) NOT NULL UNIQUE,name VARCHAR(255) NOT NULL,brand_id BIGINT REFERENCES brands(id),category_id BIGINT NOT NULL REFERENCES categories(id),default_supplier_id BIGINT REFERENCES suppliers(id),year SMALLINT,season VARCHAR(32),tag_price NUMERIC(14,2) CHECK(tag_price>=0),main_image_url TEXT,remark TEXT,status VARCHAR(32) NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE','STOPPED','ARCHIVED')),
created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now());

CREATE TABLE skus (id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
product_id BIGINT NOT NULL REFERENCES products(id),sku_code VARCHAR(100) NOT NULL UNIQUE,barcode VARCHAR(100),color_code VARCHAR(50) NOT NULL,color_name VARCHAR(100) NOT NULL,size_code VARCHAR(50) NOT NULL,size_name VARCHAR(100) NOT NULL,cost_price NUMERIC(14,2) CHECK(cost_price>=0),status VARCHAR(32) NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE','INACTIVE')),
created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now());

CREATE TABLE inventory_balances (id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
warehouse_id BIGINT NOT NULL REFERENCES warehouses(id),sku_id BIGINT NOT NULL REFERENCES skus(id),physical_qty INTEGER NOT NULL DEFAULT 0,reserved_qty INTEGER NOT NULL DEFAULT 0,damaged_qty INTEGER NOT NULL DEFAULT 0,version INTEGER NOT NULL DEFAULT 0,
created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),UNIQUE(warehouse_id,sku_id),CHECK(physical_qty>=0 AND reserved_qty>=0 AND damaged_qty>=0 AND reserved_qty+damaged_qty<=physical_qty),CHECK(version>=0));

CREATE TABLE inventory_adjustments (id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
adjustment_no VARCHAR(50) NOT NULL UNIQUE,warehouse_id BIGINT NOT NULL REFERENCES warehouses(id),sku_id BIGINT NOT NULL REFERENCES skus(id),quantity INTEGER NOT NULL CHECK(quantity<>0),reason VARCHAR(50) NOT NULL CHECK(reason IN ('OPENING','STOCKTAKE','MANUAL')),remark TEXT NOT NULL CHECK(length(trim(remark))>0),operator_id BIGINT NOT NULL REFERENCES users(id),
created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now());

CREATE TABLE purchase_suggestions (id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
sku_id BIGINT NOT NULL REFERENCES skus(id),supplier_id BIGINT REFERENCES suppliers(id),generated_at TIMESTAMPTZ NOT NULL DEFAULT now(),available_qty_snapshot INTEGER NOT NULL CHECK(available_qty_snapshot>=0),in_transit_qty_snapshot INTEGER NOT NULL CHECK(in_transit_qty_snapshot>=0),sales_7d_snapshot INTEGER NOT NULL CHECK(sales_7d_snapshot>=0),sales_30d_snapshot INTEGER,avg_daily_sales NUMERIC(12,4) NOT NULL CHECK(avg_daily_sales>=0),target_stock_days INTEGER NOT NULL CHECK(target_stock_days>0),suggested_qty INTEGER NOT NULL CHECK(suggested_qty>=0),risk_level VARCHAR(32),status VARCHAR(32) NOT NULL DEFAULT 'PENDING',actual_purchase_qty INTEGER,decision_reason TEXT,ignored_reason VARCHAR(100),ignored_remark TEXT,source_kind VARCHAR(32) NOT NULL,algorithm_version VARCHAR(50) NOT NULL,input_snapshot JSONB NOT NULL,
created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),CHECK(status IN ('PENDING','ACCEPTED','MODIFIED','IGNORED','CONVERTED')),CHECK(status NOT IN ('ACCEPTED','MODIFIED','CONVERTED') OR actual_purchase_qty>0),CHECK(status<>'IGNORED' OR ignored_reason IS NOT NULL));

CREATE UNIQUE INDEX suggestion_active ON purchase_suggestions(sku_id) WHERE status IN ('PENDING','ACCEPTED','MODIFIED');

CREATE TABLE purchase_orders (id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
po_no VARCHAR(50) NOT NULL UNIQUE,supplier_id BIGINT NOT NULL REFERENCES suppliers(id),warehouse_id BIGINT NOT NULL REFERENCES warehouses(id),buyer_id BIGINT NOT NULL REFERENCES users(id),ordered_at TIMESTAMPTZ,expected_delivery_at TIMESTAMPTZ,status VARCHAR(32) NOT NULL DEFAULT 'DRAFT',total_qty INTEGER NOT NULL DEFAULT 0 CHECK(total_qty>=0),total_amount NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK(total_amount>=0),version INTEGER NOT NULL DEFAULT 0,remark TEXT,
created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),CHECK(status IN ('DRAFT','PENDING_CONFIRMATION','CONFIRMED','IN_PRODUCTION','SHIPPED','PARTIALLY_RECEIVED','COMPLETED','CANCELLED')));

CREATE TABLE purchase_order_items (id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
purchase_order_id BIGINT NOT NULL REFERENCES purchase_orders(id),sku_id BIGINT NOT NULL REFERENCES skus(id),purchase_suggestion_id BIGINT UNIQUE REFERENCES purchase_suggestions(id),ordered_qty INTEGER NOT NULL CHECK(ordered_qty>0),unit_cost NUMERIC(14,2) NOT NULL CHECK(unit_cost>=0),received_qty INTEGER NOT NULL DEFAULT 0,cancelled_qty INTEGER NOT NULL DEFAULT 0,
created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),CHECK(received_qty>=0 AND cancelled_qty>=0 AND received_qty+cancelled_qty<=ordered_qty));

CREATE TABLE receipts (id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
receipt_no VARCHAR(50) NOT NULL UNIQUE,purchase_order_id BIGINT NOT NULL REFERENCES purchase_orders(id),warehouse_id BIGINT NOT NULL REFERENCES warehouses(id),received_at TIMESTAMPTZ,posted_at TIMESTAMPTZ,status VARCHAR(32) NOT NULL DEFAULT 'DRAFT',operator_id BIGINT NOT NULL REFERENCES users(id),version INTEGER NOT NULL DEFAULT 0,remark TEXT,
created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),CHECK(status IN ('DRAFT','RECEIVED','POSTED','CANCELLED')),CHECK(status<>'POSTED' OR posted_at IS NOT NULL));

CREATE TABLE receipt_items (id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
receipt_id BIGINT NOT NULL REFERENCES receipts(id),purchase_order_item_id BIGINT NOT NULL REFERENCES purchase_order_items(id),sku_id BIGINT NOT NULL REFERENCES skus(id),received_qty INTEGER NOT NULL CHECK(received_qty>=0),qualified_qty INTEGER NOT NULL DEFAULT 0,damaged_qty INTEGER NOT NULL DEFAULT 0,shortage_qty INTEGER NOT NULL DEFAULT 0,
created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),UNIQUE(receipt_id,purchase_order_item_id),CHECK(qualified_qty>=0 AND qualified_qty<=received_qty AND damaged_qty>=0 AND damaged_qty<=received_qty AND shortage_qty>=0));

CREATE TABLE inventory_transactions (id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
warehouse_id BIGINT NOT NULL REFERENCES warehouses(id),sku_id BIGINT NOT NULL REFERENCES skus(id),transaction_type VARCHAR(50) NOT NULL,physical_delta INTEGER NOT NULL,reserved_delta INTEGER NOT NULL DEFAULT 0,damaged_delta INTEGER NOT NULL DEFAULT 0,before_physical INTEGER NOT NULL,after_physical INTEGER NOT NULL,before_reserved INTEGER NOT NULL,after_reserved INTEGER NOT NULL,before_damaged INTEGER NOT NULL,after_damaged INTEGER NOT NULL,source_type VARCHAR(50) NOT NULL,source_id BIGINT NOT NULL,source_no VARCHAR(100) NOT NULL,receipt_item_id BIGINT UNIQUE REFERENCES receipt_items(id),adjustment_id BIGINT UNIQUE REFERENCES inventory_adjustments(id),occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),operator_id BIGINT NOT NULL REFERENCES users(id),remark TEXT,
created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),CHECK(after_physical=before_physical+physical_delta AND after_reserved=before_reserved+reserved_delta AND after_damaged=before_damaged+damaged_delta),CHECK(before_physical>=before_reserved+before_damaged AND after_physical>=after_reserved+after_damaged AND before_reserved>=0 AND before_damaged>=0 AND after_reserved>=0 AND after_damaged>=0),CHECK(physical_delta<>0 OR reserved_delta<>0 OR damaged_delta<>0),CHECK((transaction_type='PURCHASE_RECEIPT' AND receipt_item_id IS NOT NULL AND adjustment_id IS NULL AND physical_delta>0) OR (transaction_type IN ('STOCK_ADJUSTMENT','STOCKTAKE') AND adjustment_id IS NOT NULL AND receipt_item_id IS NULL)));

CREATE TABLE audit_logs (id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
actor_id BIGINT REFERENCES users(id),actor_label VARCHAR(100) NOT NULL,action VARCHAR(100) NOT NULL,entity_type VARCHAR(100) NOT NULL,entity_id BIGINT,request_id VARCHAR(100) NOT NULL,before_data JSONB,after_data JSONB,reason TEXT,occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now());

CREATE TABLE idempotency_records (id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
actor_id BIGINT NOT NULL REFERENCES users(id),operation VARCHAR(150) NOT NULL,idempotency_key VARCHAR(128) NOT NULL,request_hash VARCHAR(128) NOT NULL,response_status INTEGER NOT NULL,response_body JSONB NOT NULL,
created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),UNIQUE(actor_id,operation,idempotency_key));

CREATE INDEX ON sessions(user_id);

CREATE INDEX ON sessions(expires_at);

CREATE INDEX ON skus(product_id,color_code,size_code);

CREATE INDEX ON skus(barcode);

CREATE INDEX ON products(category_id);

CREATE INDEX ON products(default_supplier_id);

CREATE INDEX ON inventory_balances(sku_id);

CREATE INDEX ON inventory_transactions(warehouse_id,sku_id,occurred_at,id);

CREATE INDEX ON inventory_transactions(source_type,source_id);

CREATE INDEX ON purchase_suggestions(status,generated_at);

CREATE INDEX ON purchase_order_items(purchase_order_id);

CREATE INDEX ON purchase_order_items(sku_id);

CREATE INDEX ON purchase_orders(warehouse_id,status);

CREATE INDEX ON purchase_orders(supplier_id,created_at);

CREATE INDEX ON receipts(purchase_order_id,status);

CREATE INDEX ON receipt_items(purchase_order_item_id);

CREATE INDEX ON audit_logs(entity_type,entity_id,occurred_at);

CREATE INDEX ON audit_logs(actor_id,occurred_at);

CREATE FUNCTION reject_history_mutation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'History is immutable'; END $$;
CREATE TRIGGER inventory_history_immutable BEFORE UPDATE OR DELETE ON inventory_transactions FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE TRIGGER audit_history_immutable BEFORE UPDATE OR DELETE ON audit_logs FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();