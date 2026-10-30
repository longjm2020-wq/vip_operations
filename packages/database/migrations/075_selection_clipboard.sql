-- Short-lived, image-only capabilities for desktop spreadsheet clipboard imports.
-- No session token, image bytes or public permanent image URL is stored here.
CREATE TABLE public.selection_clipboard_batches (
  token_hash text PRIMARY KEY,
  session_hash text NOT NULL,
  workspace_key text NOT NULL,
  images jsonb NOT NULL,
  expires_at timestamptz NOT NULL
);
CREATE INDEX selection_clipboard_expiry ON public.selection_clipboard_batches(expires_at);
