INSERT INTO permissions(code,name) VALUES ('analytics.read','经营分析查看'),('analytics.manage','经营分析导入与邮件配置') ON CONFLICT DO NOTHING;
INSERT INTO role_permissions(role_id,permission_id) SELECT r.id,p.id FROM roles r CROSS JOIN permissions p WHERE
 (r.code IN ('ADMIN','SUPER_ADMIN') AND p.code IN ('analytics.read','analytics.manage')) OR
 (r.code='ANALYST' AND p.code='analytics.read') ON CONFLICT DO NOTHING;
CREATE TABLE compass_imports (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, dimension text NOT NULL CHECK(dimension IN ('style','article','barcode')),
 file_name text NOT NULL, file_hash text NOT NULL CHECK(file_hash ~ '^[a-f0-9]{64}$'),
 start_date date NOT NULL, end_date date NOT NULL, expected_rows integer NOT NULL CHECK(expected_rows BETWEEN 1 AND 200000),
 status text NOT NULL DEFAULT 'STAGING' CHECK(status IN ('STAGING','COMPLETE')),
 imported_by bigint NOT NULL REFERENCES users(id), completed_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(), CHECK(start_date<=end_date), UNIQUE(dimension,file_hash)
);
CREATE TABLE compass_records (
 import_id bigint NOT NULL REFERENCES compass_imports(id) ON DELETE CASCADE,
 business_date date NOT NULL, entity_key text NOT NULL, style_no text NOT NULL, article_no text NOT NULL, barcode text NOT NULL,
 payload jsonb NOT NULL, PRIMARY KEY(import_id,business_date,entity_key)
);
CREATE INDEX compass_records_dates ON compass_records(import_id,business_date);
CREATE TABLE compass_active_imports (
 dimension text PRIMARY KEY CHECK(dimension IN ('style','article','barcode')),
 import_id bigint NOT NULL UNIQUE REFERENCES compass_imports(id)
);
CREATE TABLE compass_mail_settings (
 id integer PRIMARY KEY CHECK(id=1), enabled boolean NOT NULL DEFAULT false,
 smtp_host text NOT NULL DEFAULT 'smtp.qq.com', smtp_port integer NOT NULL DEFAULT 465 CHECK(smtp_port IN (465,587)),
 smtp_user text NOT NULL DEFAULT '', from_email text NOT NULL DEFAULT '', password_encrypted text,
 recipients jsonb NOT NULL DEFAULT '[]', verified_at timestamptz,
 updated_by bigint REFERENCES users(id), version integer NOT NULL DEFAULT 1, updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO compass_mail_settings(id) VALUES(1);
CREATE TABLE compass_mail_runs (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, report_date date NOT NULL, recipient text NOT NULL,
 status text NOT NULL CHECK(status IN ('SENDING','ACCEPTED','FAILED','UNKNOWN')),
 attempt integer NOT NULL DEFAULT 1, error_note text NOT NULL DEFAULT '', message_id text,
 imported_ids jsonb NOT NULL, summary jsonb NOT NULL, sent_at timestamptz,
 started_at timestamptz NOT NULL DEFAULT now(), UNIQUE(report_date,recipient)
);
