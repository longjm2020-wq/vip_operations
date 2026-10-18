CREATE TABLE public.inventory_replenishment_policies (
  user_id bigint PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  policy jsonb NOT NULL,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);
