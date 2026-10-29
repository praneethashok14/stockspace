-- StockSpace D1 schema. Idempotent; safe to re-run.
--
-- `accounts` holds the login identity for each user (name + salted PBKDF2
-- PIN hash). `inventories` holds the appliance/group/item data as a single
-- JSON blob per account, which mirrors the atomic-rewrite semantics of the
-- original filesystem backend and keeps queries dead simple for a tiny app.

CREATE TABLE IF NOT EXISTS accounts (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  name_lower  TEXT NOT NULL UNIQUE,
  pin_hash    TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS inventories (
  account_id  TEXT PRIMARY KEY,
  data        TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
);

-- One compressed JPEG per item, stored as BLOB so we don't need R2.
-- Frontend resizes to ~800px / q=0.75 before upload (~40-80 KB each),
-- well under D1's per-row response size.
CREATE TABLE IF NOT EXISTS item_photos (
  account_id  TEXT NOT NULL,
  item_id     TEXT NOT NULL,
  data        BLOB NOT NULL,
  updated_at  TEXT NOT NULL,
  PRIMARY KEY (account_id, item_id),
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
);

-- Families: a group of accounts that share full appliance/group/item
-- visibility. An account is in at most one family at a time (enforced by
-- UNIQUE on family_memberships.account_id).
--   Owners can create/edit/delete appliances, invite members,
--     promote/demote/remove members, and manage all groups/items/photos.
--   Members can view all shared data, create/edit/delete groups, items,
--     and photos, adjust quantities, and open/close packs. They CANNOT
--     create/edit/delete appliances or manage the roster.
-- An invite that is accepted creates a family_memberships row. The invitee
-- may leave their current family in the same request (?leave_current=1).
CREATE TABLE IF NOT EXISTS families (
  id          TEXT PRIMARY KEY,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS family_memberships (
  family_id   TEXT NOT NULL,
  account_id  TEXT NOT NULL UNIQUE,
  role        TEXT NOT NULL CHECK (role IN ('owner','member')),
  joined_at   TEXT NOT NULL,
  PRIMARY KEY (family_id, account_id),
  FOREIGN KEY (family_id) REFERENCES families(id) ON DELETE CASCADE,
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS family_invitations (
  id                   TEXT PRIMARY KEY,
  family_id            TEXT NOT NULL,
  inviter_account_id   TEXT NOT NULL,
  invitee_account_id   TEXT NOT NULL,
  created_at           TEXT NOT NULL,
  status               TEXT NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending','accepted','declined','cancelled')),
  FOREIGN KEY (family_id) REFERENCES families(id) ON DELETE CASCADE,
  FOREIGN KEY (inviter_account_id) REFERENCES accounts(id) ON DELETE CASCADE,
  FOREIGN KEY (invitee_account_id) REFERENCES accounts(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_family_invitations_invitee
  ON family_invitations(invitee_account_id, status);
CREATE INDEX IF NOT EXISTS idx_family_invitations_family
  ON family_invitations(family_id, status);

-- API tokens: long-lived bearer tokens for programmatic access from
-- integrations (e.g. the Home Assistant integration). The plaintext
-- token is shown once at creation; only sha-256(token) is stored.
-- CSRF is skipped on token-authenticated requests — the token itself
-- is the secret, and no cookie is set.
CREATE TABLE IF NOT EXISTS api_tokens (
  id            TEXT PRIMARY KEY,
  account_id    TEXT NOT NULL,
  label         TEXT NOT NULL,
  token_hash    TEXT NOT NULL UNIQUE,
  token_prefix  TEXT NOT NULL,  -- first 8 chars of plaintext, for UI
  created_at    TEXT NOT NULL,
  last_used_at  TEXT,
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_api_tokens_account
  ON api_tokens(account_id);
