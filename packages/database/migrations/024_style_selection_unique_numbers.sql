-- Preserve historical duplicates while preventing any new duplicate assignment.
CREATE TABLE style_selection_number_claims (
  style_no TEXT CONSTRAINT style_selection_number_unique PRIMARY KEY,
  row_count INTEGER NOT NULL CHECK (row_count >= 0)
);
INSERT INTO style_selection_number_claims(style_no,row_count)
SELECT btrim(xuti_style_no),count(*)::integer FROM style_selections
WHERE nullif(btrim(xuti_style_no),'') IS NOT NULL GROUP BY btrim(xuti_style_no);

CREATE FUNCTION enforce_style_selection_number() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE old_key TEXT; new_key TEXT;
BEGIN
  IF TG_OP <> 'INSERT' THEN old_key := nullif(btrim(OLD.xuti_style_no),''); END IF;
  IF TG_OP <> 'DELETE' THEN new_key := nullif(btrim(NEW.xuti_style_no),''); END IF;
  IF old_key IS NOT DISTINCT FROM new_key THEN RETURN NULL; END IF;
  IF new_key IS NOT NULL THEN
    INSERT INTO style_selection_number_claims(style_no,row_count) VALUES(new_key,1);
  END IF;
  IF old_key IS NOT NULL THEN
    UPDATE style_selection_number_claims SET row_count=row_count-1 WHERE style_no=old_key;
    DELETE FROM style_selection_number_claims WHERE style_no=old_key AND row_count=0;
  END IF;
  RETURN NULL;
END;
$$;
CREATE TRIGGER style_selection_number_guard
AFTER INSERT OR DELETE OR UPDATE OF xuti_style_no ON style_selections
FOR EACH ROW EXECUTE FUNCTION enforce_style_selection_number();
