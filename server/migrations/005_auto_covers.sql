ALTER TABLE assets ADD COLUMN revision integer NOT NULL DEFAULT 1;
ALTER TABLE assets ADD COLUMN managed boolean NOT NULL DEFAULT false;
CREATE TABLE generated_covers (
 html_id uuid PRIMARY KEY REFERENCES assets(id),
 cover_id uuid NOT NULL UNIQUE REFERENCES assets(id),
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','rendering','ready','fallback')),
 failures integer NOT NULL DEFAULT 0, retries integer NOT NULL DEFAULT 0,
 next_attempt_at timestamptz NOT NULL DEFAULT now(),
 lease_token uuid, lease_until timestamptz,
 last_error text NOT NULL DEFAULT '', updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX generated_covers_queue ON generated_covers(next_attempt_at) WHERE status IN ('pending','rendering','fallback');
