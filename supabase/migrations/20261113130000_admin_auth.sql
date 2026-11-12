-- Admin web app sign-in. Service role only. Tokens and session ids are stored as HMAC-SHA256 hashes, never in plain text.

alter table users
  add column if not exists role text not null default 'user';

alter table users drop constraint if exists users_role_check;
alter table users
  add constraint users_role_check check (role in ('owner', 'admin', 'user'));

-- One-time sign-in links sent by the /admin bot command.
create table if not exists admin_login_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  token_hash text not null unique,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at timestamptz
);

create index if not exists admin_login_tokens_user_idx on admin_login_tokens (user_id, created_at desc);

create table if not exists admin_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  session_hash text not null unique,
  user_agent text,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz
);

create index if not exists admin_sessions_user_idx on admin_sessions (user_id, created_at desc);

alter table admin_login_tokens enable row level security;
alter table admin_sessions enable row level security;
revoke all on table admin_login_tokens from anon, authenticated;
revoke all on table admin_sessions from anon, authenticated;
