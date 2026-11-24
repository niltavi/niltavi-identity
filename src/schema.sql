CREATE TABLE accounts (
  id text PRIMARY KEY,
  email text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  security_epoch integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE applications (
  id text PRIMARY KEY,
  callback text NOT NULL UNIQUE,
  post_logout text NOT NULL,
  backchannel_logout text NOT NULL UNIQUE,
  resource text NOT NULL UNIQUE,
  secret_ciphertext text NOT NULL
);

CREATE TABLE oidc_records (
  model text NOT NULL,
  storage_key text NOT NULL,
  payload jsonb NOT NULL,
  account_id text REFERENCES accounts (id),
  account_epoch integer,
  expires_at timestamptz,
  consumed_at timestamptz,
  PRIMARY KEY (model, storage_key),
  CHECK ((account_id IS NULL) = (account_epoch IS NULL))
);

CREATE INDEX oidc_records_grant ON oidc_records (model, (payload ->> 'grantId'));
CREATE INDEX oidc_records_uid ON oidc_records (model, (payload ->> 'uid'));
CREATE INDEX oidc_records_user_code ON oidc_records (model, (payload ->> 'userCode'));
CREATE INDEX oidc_records_account ON oidc_records (account_id);
CREATE INDEX oidc_records_expiration ON oidc_records (expires_at);

CREATE TABLE login_attempts (
  fingerprint text PRIMARY KEY,
  count integer NOT NULL,
  expires_at timestamptz NOT NULL
);

CREATE TABLE audit_events (
  event_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  action text NOT NULL,
  target text NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  actor text NOT NULL DEFAULT current_user
);
