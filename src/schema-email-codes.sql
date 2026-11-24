-- Email verification codes for existing accounts (inline OTP, not the link-based flow).
CREATE TABLE email_verification_codes (
  account_id text PRIMARY KEY REFERENCES accounts (id) ON DELETE CASCADE,
  token_digest text NOT NULL,
  email text NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  expires_at timestamptz NOT NULL,
  next_resend_at timestamptz NOT NULL
);
CREATE INDEX email_verification_codes_expiry ON email_verification_codes (expires_at);

-- Login codes for passwordless sign-in.
CREATE TABLE login_codes (
  token_digest text PRIMARY KEY,
  email text NOT NULL,
  enrollment_digest text NOT NULL UNIQUE,
  attempts integer NOT NULL DEFAULT 0,
  expires_at timestamptz NOT NULL,
  next_resend_at timestamptz NOT NULL
);
CREATE INDEX login_codes_email ON login_codes (email);
CREATE INDEX login_codes_expiry ON login_codes (expires_at);

-- Allow passwordless accounts (registered via email + verification code only).
ALTER TABLE accounts ALTER COLUMN password_hash DROP NOT NULL;
