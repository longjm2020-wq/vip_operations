CREATE TABLE compass_ai_settings (
 id integer PRIMARY KEY CHECK(id=1), enabled boolean NOT NULL DEFAULT false,
 api_key_encrypted text, verified_at timestamptz, last_test_at timestamptz, error_note text NOT NULL DEFAULT '',
 version integer NOT NULL DEFAULT 1, updated_by bigint REFERENCES users(id), updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO compass_ai_settings(id) VALUES(1);
CREATE TABLE compass_ai_reports (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, report_date date NOT NULL,
 input_hash text NOT NULL UNIQUE CHECK(input_hash ~ '^[a-f0-9]{64}$'), imported_ids jsonb NOT NULL,
 model text NOT NULL, prompt_version text NOT NULL,
 status text NOT NULL CHECK(status IN ('GENERATING','READY','FAILED')),
 attempt integer NOT NULL DEFAULT 1, claim_token text NOT NULL,
 content jsonb, response_model text, provider text, response_id text, usage jsonb,
 error_note text NOT NULL DEFAULT '', started_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz
);
CREATE INDEX compass_ai_reports_sources ON compass_ai_reports(report_date,model,prompt_version);
