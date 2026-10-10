-- Existing enabled policies must not expose previously protected content.
-- Convert the old implicit whole-sheet rule to an explicit, editable area.
-- Disabled legacy policies start with no area; managers choose a scope first.
DO $$ DECLARE namespace TEXT; BEGIN
  FOR namespace IN
    SELECT 'public' UNION ALL
    SELECT nspname FROM pg_namespace WHERE nspname ~ '^selection_table_[0-9]+$'
  LOOP
    EXECUTE format($sql$
      UPDATE %I.style_selection_protection
      SET settings=jsonb_set(settings,'{autoHideRegions}',
        CASE WHEN settings->>'autoHide'='true' THEN
          '[{"id":"00000000-0000-4000-8000-000000000001","name":"原整表自动隐藏","scope":"sheet","rowIds":[],"columnKeys":[]}]'::jsonb
        ELSE '[]'::jsonb END),
        revision=revision+1,updated_at=now()
      WHERE NOT settings ? 'autoHideRegions'
    $sql$,namespace);
    -- Future project workspaces copy this updated public-table default.
    EXECUTE format($sql$
      ALTER TABLE %I.style_selection_protection ALTER COLUMN settings SET DEFAULT
        '{"enabled":false,"claimsEnabled":false,"autoHide":false,"autoHideRegions":[],"hiddenReaders":[],"regions":[]}'::jsonb
    $sql$,namespace);
  END LOOP;
END $$;
