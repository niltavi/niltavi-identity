-- An application belongs to the instance (org_id IS NULL) or to the team that registered it.
ALTER TABLE applications ADD COLUMN org_id text REFERENCES orgs (id) ON DELETE CASCADE;
CREATE INDEX applications_org ON applications (org_id);

ALTER TABLE orgs ADD COLUMN require_second_factor boolean NOT NULL DEFAULT false;

-- A team token has no account: it acts as the team itself, with the role chosen when it was issued.
ALTER TABLE agent_tokens ALTER COLUMN account_id DROP NOT NULL;
ALTER TABLE agent_tokens ADD COLUMN role text CHECK (role IN ('admin', 'member'));
ALTER TABLE agent_tokens ADD COLUMN issued_by text REFERENCES accounts (id) ON DELETE SET NULL;
ALTER TABLE agent_tokens ADD CONSTRAINT agent_tokens_kind CHECK ((account_id IS NULL) = (role IS NOT NULL));
CREATE INDEX agent_tokens_org ON agent_tokens (org_id);

-- Team administrators read the events of their own team. The column has no foreign key,
-- so the record outlives the team.
ALTER TABLE audit_events ADD COLUMN org_id text;
CREATE INDEX audit_events_org ON audit_events (org_id, event_id);
UPDATE audit_events e SET org_id = e.target FROM orgs o WHERE o.id = e.target AND e.action LIKE 'team.%';

-- Which applications an account has signed in to. A grant expires within hours. This row stays.
CREATE TABLE application_accounts (
  app_id text NOT NULL REFERENCES applications (id) ON DELETE CASCADE,
  account_id text NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (app_id, account_id)
);
CREATE INDEX application_accounts_account ON application_accounts (account_id);
INSERT INTO application_accounts (app_id, account_id)
  SELECT DISTINCT p.id, r.account_id FROM oidc_records r JOIN applications p ON p.id = r.payload ->> 'clientId'
  WHERE (r.model = 'Grant' OR r.model LIKE '%:Grant') AND r.account_id IS NOT NULL AND r.consumed_at IS NULL
  ON CONFLICT DO NOTHING;

-- A pending change of address. The code goes to the new address and one row exists per account.
CREATE TABLE email_changes (
  account_id text PRIMARY KEY REFERENCES accounts (id) ON DELETE CASCADE,
  email text NOT NULL,
  token_digest text NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  expires_at timestamptz NOT NULL,
  next_resend_at timestamptz NOT NULL
);
