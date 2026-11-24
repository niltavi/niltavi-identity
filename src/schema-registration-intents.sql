CREATE TABLE registration_intents (
  token_digest text PRIMARY KEY,
  interaction_uid text NOT NULL,
  expires_at timestamptz NOT NULL,
  account_id text REFERENCES accounts (id) ON DELETE CASCADE,
  account_epoch integer,
  CHECK ((account_id IS NULL) = (account_epoch IS NULL))
);
CREATE INDEX registration_intents_expiry ON registration_intents (expires_at);

ALTER TABLE email_registrations ADD COLUMN next_resend_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE email_registrations ADD COLUMN intent_digest text REFERENCES registration_intents (token_digest) ON DELETE SET NULL;
CREATE UNIQUE INDEX email_registrations_enrollment_digest
  ON email_registrations (enrollment_digest) WHERE enrollment_digest IS NOT NULL;
