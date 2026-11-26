CREATE TABLE disable_2fa_codes (
  account_id text PRIMARY KEY REFERENCES accounts (id) ON DELETE CASCADE,
  token_digest text NOT NULL,
  email text NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  expires_at timestamptz NOT NULL,
  next_resend_at timestamptz NOT NULL
);
CREATE INDEX disable_2fa_codes_expiry ON disable_2fa_codes (expires_at);
