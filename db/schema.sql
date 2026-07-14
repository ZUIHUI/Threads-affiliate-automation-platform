-- PostgreSQL production schema for Threads Affiliate Ops.
-- Development mode uses data/store.json; deploy this schema for managed Postgres.

create extension if not exists pgcrypto;

create table if not exists app_settings (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);

create table if not exists admin_users (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  display_name text not null,
  role text not null default 'operator',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists threads_accounts (
  id uuid primary key default gen_random_uuid(),
  display_name text not null,
  threads_user_id text unique,
  token_secret_ref text,
  status text not null default 'needs_credentials',
  quota_usage integer not null default 0,
  quota_total integer not null default 250,
  last_quota_checked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table if exists threads_accounts
  alter column threads_user_id drop not null;

create table if not exists campaigns (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  status text not null default 'draft',
  niche text not null,
  target_persona text not null,
  daily_budget_posts integer not null default 3,
  disclosure_required boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists affiliate_programs (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  network text not null,
  default_currency text not null default 'USD',
  webhook_secret_ref text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists products (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references campaigns(id),
  affiliate_program_id uuid references affiliate_programs(id),
  name text not null,
  offer text not null,
  commission_model text not null,
  commission_value numeric(12, 2) not null default 0,
  currency text not null default 'USD',
  landing_url text not null,
  status text not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists affiliate_links (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references campaigns(id),
  product_id uuid not null references products(id),
  slug text not null unique,
  network text not null,
  target_url text not null,
  utm_source text not null default 'threads',
  utm_medium text not null default 'affiliate_social',
  utm_campaign text not null,
  utm_content text,
  sub_id_param text not null default 'subid',
  append_utm boolean not null default false,
  source text not null default 'affiliate',
  is_demo boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table if exists affiliate_links add column if not exists sub_id_param text not null default 'subid';
alter table if exists affiliate_links add column if not exists append_utm boolean not null default false;
alter table if exists affiliate_links add column if not exists source text not null default 'affiliate';
alter table if exists affiliate_links add column if not exists is_demo boolean not null default false;

create table if not exists posts (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references threads_accounts(id),
  campaign_id uuid not null references campaigns(id),
  product_id uuid references products(id),
  affiliate_link_id uuid references affiliate_links(id),
  topic_tag text,
  text text not null,
  status text not null default 'draft',
  approved boolean not null default false,
  scheduled_at timestamptz not null,
  link_attachment text,
  threads_container_id text,
  publish_after timestamptz,
  threads_media_id text,
  published_at timestamptz,
  error text,
  created_by uuid references admin_users(id),
  reviewed_at timestamptz,
  reviewed_by uuid references admin_users(id),
  rejected_at timestamptz,
  rejected_by uuid references admin_users(id),
  rejection_reason text,
  review_reset_at timestamptz,
  review_reset_reason text,
  validation_result jsonb,
  risk_level text,
  disclosure_status text,
  claim_warnings jsonb not null default '[]'::jsonb,
  testimonial_risk boolean not null default false,
  fatigue_status text,
  fatigue_reasons jsonb not null default '[]'::jsonb,
  similarity_score numeric(5, 3),
  similar_to_post_id text,
  commercial_intensity text,
  last_fatigue_checked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint posts_status_check check (
    status in (
      'generated',
      'needs_review',
      'approved',
      'scheduled',
      'container_created',
      'published',
      'simulated',
      'failed',
      'rejected',
      'blocked_credentials',
      'draft'
    )
  )
);

alter table if exists posts add column if not exists reviewed_at timestamptz;
alter table if exists posts add column if not exists reviewed_by uuid references admin_users(id);
alter table if exists posts add column if not exists rejected_at timestamptz;
alter table if exists posts add column if not exists rejected_by uuid references admin_users(id);
alter table if exists posts add column if not exists rejection_reason text;
alter table if exists posts add column if not exists review_reset_at timestamptz;
alter table if exists posts add column if not exists review_reset_reason text;
alter table if exists posts add column if not exists validation_result jsonb;
alter table if exists posts add column if not exists risk_level text;
alter table if exists posts add column if not exists disclosure_status text;
alter table if exists posts add column if not exists claim_warnings jsonb not null default '[]'::jsonb;
alter table if exists posts add column if not exists testimonial_risk boolean not null default false;
alter table if exists posts add column if not exists fatigue_status text;
alter table if exists posts add column if not exists fatigue_reasons jsonb not null default '[]'::jsonb;
alter table if exists posts add column if not exists similarity_score numeric(5, 3);
alter table if exists posts add column if not exists similar_to_post_id text;
alter table if exists posts add column if not exists commercial_intensity text;
alter table if exists posts add column if not exists last_fatigue_checked_at timestamptz;
alter table if exists posts drop constraint if exists posts_status_check;
alter table if exists posts add constraint posts_status_check check (
  status in (
    'generated',
    'needs_review',
    'approved',
    'scheduled',
    'container_created',
    'published',
    'simulated',
    'failed',
    'rejected',
    'blocked_credentials',
    'draft'
  )
);

create table if not exists post_assets (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references posts(id) on delete cascade,
  media_type text not null,
  public_url text not null,
  sort_order integer not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists automation_runs (
  id uuid primary key default gen_random_uuid(),
  source text not null,
  status text not null,
  processed integer not null default 0,
  published integer not null default 0,
  simulated integer not null default 0,
  failed integer not null default 0,
  messages jsonb not null default '[]'::jsonb,
  started_at timestamptz not null default now(),
  finished_at timestamptz
);

create table if not exists profit_engine_runs (
  id uuid primary key default gen_random_uuid(),
  source text not null,
  selected_model_id text not null,
  selected_model_name text not null,
  score integer not null default 0,
  created_post_ids jsonb not null default '[]'::jsonb,
  status text not null default 'completed',
  created_at timestamptz not null default now()
);

create table if not exists ad_intelligence_insights (
  id uuid primary key default gen_random_uuid(),
  model_id text not null,
  source text not null,
  angle text not null,
  natural_rewrite text not null,
  target_campaign_id uuid references campaigns(id),
  target_product_id uuid references products(id),
  created_at timestamptz not null default now()
);

create table if not exists click_events (
  id uuid primary key default gen_random_uuid(),
  affiliate_link_id uuid not null references affiliate_links(id),
  post_id uuid references posts(id),
  campaign_id uuid references campaigns(id),
  product_id uuid references products(id),
  model_id text,
  tracking_code text,
  user_agent text,
  referer text,
  ip_hash text,
  created_at timestamptz not null default now()
);

create table if not exists conversion_events (
  id uuid primary key default gen_random_uuid(),
  affiliate_link_id uuid not null references affiliate_links(id),
  click_event_id uuid references click_events(id),
  post_id uuid references posts(id),
  campaign_id uuid references campaigns(id),
  product_id uuid references products(id),
  model_id text,
  tracking_code text,
  network_event_id text,
  order_value numeric(12, 2),
  commission_value numeric(12, 2) not null default 0,
  currency text not null default 'USD',
  status text not null default 'pending',
  occurred_at timestamptz not null,
  created_at timestamptz not null default now()
);

create table if not exists payouts (
  id uuid primary key default gen_random_uuid(),
  affiliate_program_id uuid references affiliate_programs(id),
  amount numeric(12, 2) not null,
  currency text not null default 'USD',
  status text not null default 'pending',
  expected_at date,
  paid_at date,
  created_at timestamptz not null default now()
);

create table if not exists audit_logs (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid references admin_users(id),
  action text not null,
  entity_type text not null,
  entity_id text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_posts_queue on posts(status, approved, scheduled_at);
create index if not exists idx_posts_campaign on posts(campaign_id, scheduled_at desc);
create index if not exists idx_click_events_link_time on click_events(affiliate_link_id, created_at desc);
create index if not exists idx_click_events_post_time on click_events(post_id, created_at desc);
create index if not exists idx_conversion_events_link_time on conversion_events(affiliate_link_id, occurred_at desc);
create index if not exists idx_conversion_events_post_time on conversion_events(post_id, occurred_at desc);
create index if not exists idx_conversion_events_model_time on conversion_events(model_id, occurred_at desc);
create index if not exists idx_affiliate_links_slug on affiliate_links(slug);
create index if not exists idx_profit_engine_runs_created_at on profit_engine_runs(created_at desc);
create index if not exists idx_ad_intelligence_insights_model_time on ad_intelligence_insights(model_id, created_at desc);
