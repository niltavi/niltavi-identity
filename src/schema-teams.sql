ALTER TABLE accounts ADD COLUMN display_name text;
ALTER TABLE accounts ADD COLUMN locale text CHECK (locale IN ('en', 'zh-CN'));
ALTER TABLE accounts ADD COLUMN instance_role text CHECK (instance_role IN ('owner', 'admin'));
ALTER TABLE accounts ADD COLUMN totp_secret text;
ALTER TABLE accounts ADD COLUMN totp_confirmed_at timestamptz;
ALTER TABLE accounts ADD COLUMN totp_last_step bigint;
ALTER TABLE accounts ADD COLUMN deletion_requested_at timestamptz;
ALTER TABLE accounts ADD COLUMN deleted_at timestamptz;

ALTER TABLE applications ADD COLUMN name text;
ALTER TABLE applications ADD COLUMN home_url text;
ALTER TABLE applications ADD COLUMN enabled boolean NOT NULL DEFAULT true;
ALTER TABLE applications ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();
UPDATE applications SET name = id, home_url = substring(callback from '^https://[^/]+') || '/';
ALTER TABLE applications ALTER COLUMN name SET NOT NULL;
ALTER TABLE applications ALTER COLUMN home_url SET NOT NULL;

ALTER TABLE web_sessions ADD COLUMN id text NOT NULL DEFAULT gen_random_uuid()::text;
ALTER TABLE web_sessions ADD COLUMN user_agent text;
ALTER TABLE web_sessions ADD COLUMN second_factor_at timestamptz;
CREATE UNIQUE INDEX web_sessions_id ON web_sessions (id);

ALTER TABLE audit_events ADD COLUMN detail text;
ALTER TABLE email_registrations ADD COLUMN attempts integer NOT NULL DEFAULT 0;

CREATE TABLE instance_settings (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
-- An instance that already has accounts keeps serving them without the first-run setup.
INSERT INTO instance_settings (key, value) SELECT 'initialized', 'true'::jsonb WHERE EXISTS (SELECT 1 FROM accounts);

CREATE TABLE orgs (
  id text PRIMARY KEY,
  name text NOT NULL,
  personal_account_id text UNIQUE REFERENCES accounts (id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE memberships (
  org_id text NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
  account_id text NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, account_id)
);
CREATE INDEX memberships_account ON memberships (account_id);

INSERT INTO orgs (id, name, personal_account_id) SELECT gen_random_uuid()::text, 'Personal', id FROM accounts;
INSERT INTO memberships (org_id, account_id, role) SELECT id, personal_account_id, 'owner' FROM orgs;

CREATE TABLE invitations (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
  email text NOT NULL,
  role text NOT NULL CHECK (role IN ('admin', 'member')),
  token_digest text NOT NULL UNIQUE,
  invited_by text NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  accepted_at timestamptz,
  revoked_at timestamptz
);
CREATE INDEX invitations_org ON invitations (org_id);
CREATE INDEX invitations_email ON invitations (email);

-- Single-use links for password recovery and for confirming an existing account's address.
CREATE TABLE account_links (
  token_digest text PRIMARY KEY,
  account_id text NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  purpose text NOT NULL CHECK (purpose IN ('reset', 'verify')),
  email text NOT NULL,
  expires_at timestamptz NOT NULL
);
CREATE INDEX account_links_account ON account_links (account_id, purpose);

CREATE TABLE agent_tokens (
  id text PRIMARY KEY,
  token_digest text NOT NULL UNIQUE,
  account_id text NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  app_id text NOT NULL REFERENCES applications (id) ON DELETE CASCADE,
  org_id text NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
  name text NOT NULL,
  hint text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  revoked_at timestamptz,
  last_used_at timestamptz
);
CREATE INDEX agent_tokens_account ON agent_tokens (account_id);
