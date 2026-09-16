CREATE TABLE supply_invites (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, code text NOT NULL UNIQUE, owner_id bigint NOT NULL REFERENCES users(id),active boolean NOT NULL DEFAULT true,expires_at timestamptz NOT NULL, max_uses integer NOT NULL DEFAULT 100,uses integer NOT NULL DEFAULT 0,created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE supply_accounts (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, user_id bigint NOT NULL UNIQUE REFERENCES users(id),
 invite_id bigint REFERENCES supply_invites(id),state text NOT NULL DEFAULT 'DRAFT' CHECK(state IN ('DRAFT','PENDING','APPROVED','REJECTED')),
 draft jsonb NOT NULL DEFAULT '{}', effective jsonb, reason text NOT NULL DEFAULT '', version integer NOT NULL DEFAULT 1,
 submitted_at timestamptz, reviewed_at timestamptz, reviewer_id bigint REFERENCES users(id),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX supply_company_unique ON supply_accounts ((effective->>'creditCode')) WHERE effective IS NOT NULL;
CREATE TABLE supply_revisions (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, account_id bigint NOT NULL REFERENCES supply_accounts(id),
 document jsonb NOT NULL, decision text NOT NULL, reason text NOT NULL DEFAULT '', reviewer_id bigint REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE supply_files (
 id uuid PRIMARY KEY, account_id bigint NOT NULL REFERENCES supply_accounts(id), purpose text NOT NULL CHECK(purpose IN ('QUALIFICATION','PRODUCT')),
 metadata jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE supply_products (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, account_id bigint NOT NULL REFERENCES supply_accounts(id),
 supplier_style text NOT NULL, xuti_style text NOT NULL DEFAULT '', document jsonb NOT NULL,
 status text NOT NULL DEFAULT 'OFF' CHECK(status IN ('ON','OFF')), off_reasons jsonb NOT NULL DEFAULT '[]',
 version integer NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(account_id,supplier_style)
);
CREATE INDEX supply_products_account ON supply_products(account_id,id);
CREATE TABLE supply_registration_limits (key text PRIMARY KEY, count integer NOT NULL, expires_at timestamptz NOT NULL);
INSERT INTO permissions(code,name) VALUES ('supply.portal','供应商后台'),('supply.review','供应链入驻与资质审核'),('supply.manage','供应链产品管理') ON CONFLICT(code) DO NOTHING;
INSERT INTO roles(code,name) VALUES ('SUPPLIER','供应商'),('SUPPLY_MANAGER','供应链负责人') ON CONFLICT(code) DO NOTHING;
INSERT INTO role_permissions(role_id,permission_id) SELECT r.id,p.id FROM roles r CROSS JOIN permissions p WHERE
 (r.code='SUPPLIER' AND p.code='supply.portal') OR (r.code='SUPPLY_MANAGER' AND p.code IN ('supply.review','supply.manage')) OR (r.code='SUPER_ADMIN' AND p.code IN ('supply.portal','supply.review','supply.manage')) OR (r.code='ADMIN' AND p.code IN ('supply.review','supply.manage')) ON CONFLICT DO NOTHING;
