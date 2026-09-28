
ALTER TABLE style_selections ADD COLUMN selling_points TEXT NOT NULL DEFAULT '';
ALTER TABLE style_selections ADD COLUMN reorder_days INTEGER CHECK(reorder_days BETWEEN 0 AND 36500);
ALTER TABLE style_selections ADD COLUMN collection_inventory JSONB NOT NULL DEFAULT '[]'::jsonb;
CREATE TABLE selection_collections (
 id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 title VARCHAR(100) NOT NULL,
 token_hash TEXT UNIQUE NOT NULL,
 expires_at TIMESTAMPTZ,
 closed BOOLEAN NOT NULL DEFAULT false,
 status TEXT NOT NULL DEFAULT 'DRAFT' CHECK(status IN ('DRAFT','SUBMITTED','APPROVED','REJECTED')),
 revision INTEGER NOT NULL DEFAULT 0,
 feedback TEXT NOT NULL DEFAULT '',
 created_by BIGINT NOT NULL REFERENCES users(id),
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE selection_collection_items (
 collection_id BIGINT NOT NULL REFERENCES selection_collections(id) ON DELETE CASCADE,
 selection_id BIGINT NOT NULL, -- retain collection history if the original style is removed
 position INTEGER NOT NULL,
 source_version INTEGER NOT NULL,
 xuti_style_no TEXT NOT NULL DEFAULT '',
 original JSONB NOT NULL,
 draft JSONB NOT NULL,
 PRIMARY KEY(collection_id,selection_id)
);
CREATE TABLE selection_collection_requests (
 collection_id BIGINT NOT NULL REFERENCES selection_collections(id) ON DELETE CASCADE,
 request_key TEXT NOT NULL,
 fingerprint TEXT NOT NULL,
 result JSONB NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 PRIMARY KEY(collection_id,request_key)
);
CREATE TABLE selection_collection_events (
 id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 collection_id BIGINT NOT NULL REFERENCES selection_collections(id),
 actor_id BIGINT REFERENCES users(id),
 action TEXT NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
