ALTER TABLE accounts ADD COLUMN email_verified_at timestamptz;

CREATE TABLE email_registrations (
  token_digest text PRIMARY KEY,
  email text NOT NULL,
  expires_at timestamptz NOT NULL
);
CREATE INDEX email_registrations_expiry ON email_registrations (expires_at);

CREATE TABLE web_sessions (
  token_digest text PRIMARY KEY,
  account_id text NOT NULL REFERENCES accounts (id),
  account_epoch integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE INDEX web_sessions_account ON web_sessions (account_id);
CREATE INDEX web_sessions_expiry ON web_sessions (expires_at);

CREATE TABLE acceptance_account_operators (
  operator_id text NOT NULL REFERENCES accounts (id),
  account_id text NOT NULL REFERENCES accounts (id),
  PRIMARY KEY (operator_id, account_id),
  CHECK (operator_id <> account_id)
);
