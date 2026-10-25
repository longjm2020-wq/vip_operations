INSERT INTO permissions(code,name) VALUES
 ('aigc.use','使用 AIGC 创作'), ('aigc.manage','管理 AIGC 服务')
ON CONFLICT (code) DO NOTHING;
INSERT INTO role_permissions(role_id,permission_id)
SELECT r.id,p.id FROM roles r CROSS JOIN permissions p
WHERE r.code='SUPER_ADMIN' AND p.code IN ('aigc.use','aigc.manage')
ON CONFLICT DO NOTHING;

CREATE TABLE aigc_state (
 id integer PRIMARY KEY CHECK (id=1),
 document jsonb NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE aigc_blobs (
 id uuid PRIMARY KEY,
 object_key text,
 content bytea,
 size bigint NOT NULL CHECK (size>=0),
 created_at timestamptz NOT NULL DEFAULT now(),
 CHECK ((object_key IS NOT NULL) <> (content IS NOT NULL))
);
CREATE TABLE aigc_settings (
 id integer PRIMARY KEY CHECK(id=1),
 config jsonb NOT NULL DEFAULT '{}',
 secrets_encrypted text,
 revision integer NOT NULL DEFAULT 1,
 updated_by bigint REFERENCES users(id),
 updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO aigc_settings(id) VALUES (1);
