CREATE TABLE accounts (
  id text PRIMARY KEY,
  enabled boolean NOT NULL DEFAULT true,
  security_epoch integer NOT NULL DEFAULT 0
);

CREATE TABLE oidc_records (
  model text NOT NULL,
  storage_key text NOT NULL,
  payload jsonb NOT NULL,
  account_id text REFERENCES accounts (id),
  account_epoch integer,
  expires_at timestamptz,
  consumed_at timestamptz,
  PRIMARY KEY (model, storage_key)
);

CREATE INDEX oidc_records_grant ON oidc_records (model, (payload ->> 'grantId'));
CREATE INDEX oidc_records_uid ON oidc_records (model, (payload ->> 'uid'));
CREATE INDEX oidc_records_user_code ON oidc_records (model, (payload ->> 'userCode'));
CREATE INDEX oidc_records_account ON oidc_records (account_id);
