CREATE TABLE style_selection_shared_view (
 id integer PRIMARY KEY CHECK (id=1),
 view jsonb NOT NULL DEFAULT '{"filters":{},"sort":null}',
 revision integer NOT NULL DEFAULT 0,
 updated_by bigint REFERENCES users(id),
 updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO style_selection_shared_view(id) VALUES(1);
