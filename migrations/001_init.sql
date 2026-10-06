-- Petits Héros — schéma initial

CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text NOT NULL,
  name          text NOT NULL,
  password_hash text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_uq ON users (lower(email));

CREATE TABLE sessions (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen  timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE INDEX sessions_user_idx ON sessions (user_id);

CREATE TABLE families (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  -- compteur de révision : incrémenté à chaque écriture, sert à la synchronisation
  rev         bigint NOT NULL DEFAULT 1,
  quick_plus  int[] NOT NULL DEFAULT '{1,2,5,10}',
  quick_minus int[] NOT NULL DEFAULT '{1,2,3}',
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE members (
  family_id  uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role       text NOT NULL CHECK (role IN ('owner','parent')),
  status     text NOT NULL CHECK (status IN ('pending','active')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (family_id, user_id)
);
-- un compte appartient à une seule famille
CREATE UNIQUE INDEX members_one_family_per_user ON members (user_id);

CREATE TABLE invites (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id  uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  code_hash  text NOT NULL UNIQUE,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  used_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  used_at    timestamptz,
  revoked_at timestamptz
);

CREATE TABLE password_resets (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  used_at    timestamptz
);

CREATE TABLE children (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id   uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  name        text NOT NULL,
  avatar      text NOT NULL,
  color       text NOT NULL,
  age         smallint CHECK (age BETWEEN 0 AND 18),
  balance     integer NOT NULL DEFAULT 0 CHECK (balance >= 0),   -- jamais négatif
  archived_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX children_family_idx ON children (family_id);

CREATE TABLE actions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id   uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  theme       text NOT NULL,
  title       text NOT NULL,
  icon        text NOT NULL,
  value       integer NOT NULL CHECK (value <> 0),
  favorite    boolean NOT NULL DEFAULT false,
  child_ids   uuid[] NOT NULL DEFAULT '{}',          -- vide = tous les enfants
  sort        integer NOT NULL DEFAULT 0,
  archived_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX actions_family_idx ON actions (family_id);

CREATE TABLE challenges (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id    uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  title        text NOT NULL,
  icon         text NOT NULL,
  action_id    uuid REFERENCES actions(id),
  collective   boolean NOT NULL DEFAULT false,
  child_ids    uuid[] NOT NULL,
  starts_on    date NOT NULL,
  ends_on      date NOT NULL,
  target       integer NOT NULL CHECK (target BETWEEN 1 AND 100),
  frequency    text NOT NULL CHECK (frequency IN ('daily','any')),
  bonus        integer NOT NULL DEFAULT 0 CHECK (bonus >= 0),
  completed_at timestamptz,
  archived_at  timestamptz,
  created_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_on >= starts_on)
);
CREATE INDEX challenges_family_idx ON challenges (family_id);

CREATE TABLE rewards (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id   uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  title       text NOT NULL,
  icon        text NOT NULL,
  cost        integer NOT NULL CHECK (cost > 0),
  child_ids   uuid[] NOT NULL DEFAULT '{}',
  archived_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX rewards_family_idx ON rewards (family_id);

CREATE TABLE redemptions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id    uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  reward_id    uuid REFERENCES rewards(id) ON DELETE SET NULL,
  child_id     uuid NOT NULL REFERENCES children(id),
  title        text NOT NULL,
  icon         text NOT NULL,
  cost         integer NOT NULL,
  status       text NOT NULL DEFAULT 'todo' CHECK (status IN ('todo','done','cancelled')),
  tx_id        uuid,
  created_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  done_at      timestamptz,
  cancelled_at timestamptz
);
CREATE INDEX redemptions_family_idx ON redemptions (family_id, status);

CREATE TABLE transactions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id     uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  child_id      uuid NOT NULL REFERENCES children(id),
  value         integer NOT NULL CHECK (value <> 0),
  type          text NOT NULL CHECK (type IN ('gain','malus','bonus','reward','cancel')),
  reason        text NOT NULL DEFAULT '',
  author_id     uuid REFERENCES users(id) ON DELETE SET NULL,
  balance_after integer NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  action_id     uuid REFERENCES actions(id) ON DELETE SET NULL,
  challenge_id  uuid REFERENCES challenges(id) ON DELETE SET NULL,
  redemption_id uuid REFERENCES redemptions(id) ON DELETE SET NULL,
  reverses_id   uuid REFERENCES transactions(id)
);
CREATE INDEX transactions_child_idx ON transactions (child_id, created_at DESC);
CREATE INDEX transactions_family_idx ON transactions (family_id, created_at DESC);
-- un mouvement ne peut être compensé qu'une seule fois (pas de double remboursement)
CREATE UNIQUE INDEX transactions_reverses_uq ON transactions (reverses_id) WHERE reverses_id IS NOT NULL;

CREATE TABLE challenge_completions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id    uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  challenge_id uuid NOT NULL REFERENCES challenges(id) ON DELETE CASCADE,
  event_id     uuid NOT NULL,           -- une validation = un événement (N lignes si défi collectif)
  child_id     uuid NOT NULL REFERENCES children(id),
  day          date NOT NULL,
  tx_id        uuid REFERENCES transactions(id),
  author_id    uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  cancelled_at timestamptz
);
CREATE INDEX completions_challenge_idx ON challenge_completions (challenge_id);
CREATE INDEX completions_tx_idx ON challenge_completions (tx_id);

CREATE TABLE challenge_bonuses (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  challenge_id uuid NOT NULL REFERENCES challenges(id) ON DELETE CASCADE,
  child_id     uuid NOT NULL REFERENCES children(id),
  tx_id        uuid NOT NULL REFERENCES transactions(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  cancelled_at timestamptz
);
-- le bonus final n'existe qu'une fois (actif) par enfant et par défi
CREATE UNIQUE INDEX challenge_bonus_once ON challenge_bonuses (challenge_id, child_id) WHERE cancelled_at IS NULL;

-- Idempotence : une opération (identifiant fourni par le client) n'est exécutée qu'une fois
CREATE TABLE operations (
  family_id  uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  op_id      text NOT NULL,
  response   jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (family_id, op_id)
);
