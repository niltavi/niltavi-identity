-- A password sign-in on an account with two-step verification waits here for the second step.
CREATE TABLE login_challenges (
  token_digest text PRIMARY KEY,
  account_id text NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  account_epoch integer NOT NULL,
  interaction_uid text,
  attempts integer NOT NULL DEFAULT 0,
  expires_at timestamptz NOT NULL
);
CREATE INDEX login_challenges_expiry ON login_challenges (expires_at);

-- One-time codes that stand in for the authenticator. They are issued only when two-step verification is turned on.
CREATE TABLE recovery_codes (
  account_id text NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  code_digest text NOT NULL,
  used_at timestamptz,
  PRIMARY KEY (account_id, code_digest)
);
