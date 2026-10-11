-- =====================================================================
-- Физиотера: аккаунты, промокоды, реферальная программа, бонусы, журнал.
--
-- Принципы безопасности:
--   * Все таблицы лежат в схеме app, которая НЕ открыта через REST API.
--     RLS включён на каждой таблице без разрешающих политик (deny-all) —
--     вторая линия защиты, если схему когда-нибудь откроют.
--   * Клиент работает только через функции public.* (security definer),
--     каждая из которых сама проверяет auth.uid(), статус аккаунта и права.
--   * Размер скидки, владелец кода, статусы — меняются только серверными
--     функциями; из браузера их передать нельзя.
--   * Гонки (двойной клик, параллельные запросы) закрыты блокировками
--     FOR UPDATE и уникальными индексами.
-- =====================================================================

create extension if not exists pgcrypto with schema extensions;

create schema if not exists app;
revoke all on schema app from public;
grant usage on schema app to service_role;

-- ---------------------------------------------------------------------
-- Справочники и настройки
-- ---------------------------------------------------------------------

create table app.settings (
  id               boolean primary key default true check (id),
  referral_enabled boolean not null default false,  -- главный выключатель программы
  diagnostics      boolean not null default false,  -- расширенные уведомления в Telegram
  site_url         text    not null default 'https://www.fiziotera.online',
  bot_username     text,
  updated_at       timestamptz not null default now(),
  updated_by       uuid
);
insert into app.settings default values;

create table app.services (
  id     text primary key,
  title  text not null,
  active boolean not null default true,
  sort   int not null default 0
);

insert into app.services (id, title, sort) values
  ('spina3', 'Здоровая спина 3.0', 1),
  ('spina57', 'Здоровая спина 5.0 / 7.0', 2),
  ('sustavy', 'Здоровые суставы', 3),
  ('gryzha', 'Резорбция грыжи', 4),
  ('uvt', 'Ударно-волновая терапия', 5),
  ('magnit', 'Магнит высокой интенсивности', 6),
  ('vakuum', 'Вакуумно-градиентная терапия', 7),
  ('hijama', 'Хиджама', 8),
  ('iglo', 'Иглоукалывание', 9),
  ('laser', 'Лазер высокой интенсивности', 10),
  ('manual', 'Мануальная терапия', 11),
  ('uzi', 'Ультразвук', 12),
  ('perkussia', 'Перкуссионная терапия', 13),
  ('teip', 'Тейпирование', 14),
  ('massage_body', 'Массаж всего тела', 15),
  ('massage_back', 'Массаж спины', 16),
  ('massage_neck', 'Массаж шейно-воротниковой зоны', 17),
  ('massage_legs', 'Массаж ног', 18),
  ('massage_pregnant', 'Массаж для беременных', 19),
  ('massage_cellulite', 'Антицеллюлитный массаж', 20),
  ('massage_kids', 'Детский массаж', 21),
  ('massage_sport', 'Спортивный массаж', 22);

-- Правила скидок. Значения НЕ задаются по умолчанию: администратор
-- сам указывает размер, услуги, срок, число использований и совмещение.
create table app.discount_rules (
  kind          text primary key check (kind in ('welcome', 'referral_invitee', 'referrer_reward')),
  enabled       boolean not null default false,
  title         text not null,
  description   text not null default '',
  discount_type text check (discount_type in ('percent', 'fixed')),
  amount        numeric(12, 2) check (amount > 0),
  all_services  boolean not null default true,
  service_ids   text[] not null default '{}',
  valid_days    int check (valid_days between 1 and 3650),
  max_uses      int not null default 1 check (max_uses between 1 and 100),
  stackable     boolean not null default false,
  updated_at    timestamptz not null default now(),
  updated_by    uuid,
  -- включить правило можно только с заполненными условиями
  constraint rule_complete check (
    not enabled or (discount_type is not null and amount is not null and valid_days is not null
                    and (all_services or cardinality(service_ids) > 0))
  ),
  constraint percent_range check (discount_type is distinct from 'percent' or amount <= 100)
);

insert into app.discount_rules (kind, title, description) values
  ('welcome', 'Подарок за регистрацию', 'Персональная скидка на первую услугу для новых клиентов.'),
  ('referral_invitee', 'Скидка по приглашению', 'Скидка на первую услугу для клиента, пришедшего по промокоду друга.'),
  ('referrer_reward', 'Бонус за приглашённого друга', 'Начисляется, когда приглашённый вами клиент получил услугу.');

-- Telegram ID администраторов (доступ к боту и к админ-панели сайта)
create table app.admin_telegram_ids (
  telegram_id bigint primary key,
  note        text,
  added_at    timestamptz not null default now()
);
insert into app.admin_telegram_ids (telegram_id, note) values
  (963921711, 'админ 1'), (694713592, 'админ 2'), (944732927, 'админ 3');

-- ---------------------------------------------------------------------
-- Пользователи
-- ---------------------------------------------------------------------

create table app.profiles (
  id                 uuid primary key references auth.users (id) on delete restrict,
  client_no          bigint generated always as identity (start with 1001) unique, -- короткий номер для людей
  display_name       text check (char_length(display_name) <= 60),
  phone              text,
  phone_norm         text check (phone_norm ~ '^[0-9]{10,15}$'),
  email              text,
  ref_code           text not null unique check (ref_code ~ '^GIFT-[A-Z0-9]{5}$'),
  role               text not null default 'user' check (role in ('user', 'admin')),
  status             text not null default 'active' check (status in ('active', 'blocked', 'deleted')),
  status_reason      text,
  signup_method      text check (signup_method in ('email', 'telegram')),
  signup_ip_hash     text,
  onboarded_at       timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create index profiles_phone_idx on app.profiles (phone_norm);
create index profiles_ip_idx on app.profiles (signup_ip_hash, created_at);
create index profiles_created_idx on app.profiles (created_at desc);

create table app.telegram_identities (
  telegram_id  bigint primary key,
  user_id      uuid not null unique references app.profiles (id) on delete restrict,
  username     text,
  first_name   text,
  linked_at    timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- Реферальная программа и бонусы
-- ---------------------------------------------------------------------

create table app.referrals (
  id           uuid primary key default gen_random_uuid(),
  referrer_id  uuid not null references app.profiles (id) on delete restrict,
  invitee_id   uuid not null unique references app.profiles (id) on delete restrict, -- один пригласивший на всю жизнь
  code         text not null,
  status       text not null default 'registered' check (status in ('registered', 'qualified', 'cancelled')),
  same_network boolean not null default false,
  created_at   timestamptz not null default now(),
  qualified_at timestamptz,
  constraint no_self_referral check (referrer_id <> invitee_id)
);
create index referrals_referrer_idx on app.referrals (referrer_id, created_at desc);

create table app.bonuses (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null references app.profiles (id) on delete restrict,
  kind               text not null check (kind in ('welcome', 'referral_invitee', 'referrer_reward')),
  -- условия фиксируются в момент выдачи и потом не меняются
  title              text not null,
  discount_type      text not null check (discount_type in ('percent', 'fixed')),
  amount             numeric(12, 2) not null check (amount > 0),
  all_services       boolean not null,
  service_ids        text[] not null,
  max_uses           int not null check (max_uses >= 1),
  uses_confirmed     int not null default 0 check (uses_confirmed >= 0),
  stackable          boolean not null,
  status             text not null default 'available'
                     check (status in ('available', 'pending', 'used', 'expired', 'cancelled')),
  expires_at         timestamptz not null,
  source_referral_id uuid references app.referrals (id),
  cancel_reason      text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint uses_le_max check (uses_confirmed <= max_uses)
);
-- Приветственный бонус и скидка приглашённого — максимум один на аккаунт
create unique index bonuses_one_welcome on app.bonuses (user_id) where kind = 'welcome';
create unique index bonuses_one_invitee on app.bonuses (user_id) where kind = 'referral_invitee';
-- Награда пригласившему — максимум одна за каждого приглашённого
create unique index bonuses_one_reward on app.bonuses (source_referral_id) where kind = 'referrer_reward';
create index bonuses_user_idx on app.bonuses (user_id, created_at desc);
create index bonuses_status_idx on app.bonuses (status, expires_at);

create table app.redemptions (
  id           uuid primary key default gen_random_uuid(),
  bonus_id     uuid not null references app.bonuses (id) on delete restrict,
  user_id      uuid not null references app.profiles (id) on delete restrict,
  service_id   text not null references app.services (id),
  phone_norm   text not null,
  status       text not null default 'pending' check (status in ('pending', 'confirmed', 'cancelled', 'refunded')),
  note         text,
  requested_at timestamptz not null default now(),
  decided_at   timestamptz,
  decided_by   uuid,
  decided_by_tg bigint
);
-- не больше одного ожидающего запроса на бонус (защита от двойного клика)
create unique index redemptions_one_pending on app.redemptions (bonus_id) where status = 'pending';
create index redemptions_status_idx on app.redemptions (status, requested_at desc);

-- «Один реальный клиент — один подарок»: телефон, на который уже
-- оформлен/использован приветственный или реферальный бонус.
-- Строки НЕ удаляются при удалении аккаунта.
create table app.bonus_claims (
  id            bigint generated always as identity primary key,
  kind          text not null check (kind in ('welcome', 'referral_invitee')),
  phone_norm    text not null,
  user_id       uuid not null,
  redemption_id uuid not null,
  created_at    timestamptz not null default now(),
  released_at   timestamptz
);
create unique index bonus_claims_active on app.bonus_claims (kind, phone_norm) where released_at is null;

-- ---------------------------------------------------------------------
-- Журнал событий (аудит + безопасность + очередь уведомлений в Telegram)
-- ---------------------------------------------------------------------

create table app.events (
  id               bigint generated always as identity primary key,
  type             text not null,
  severity         text not null default 'info' check (severity in ('info', 'warn', 'alert', 'error')),
  user_id          uuid,
  actor_id         uuid,
  actor_tg         bigint,
  ip_hash          text,
  data             jsonb not null default '{}',
  notify           boolean not null default false,
  notified_at      timestamptz,
  notify_attempts  int not null default 0,
  notify_error     text,
  created_at       timestamptz not null default now()
);
create index events_created_idx on app.events (created_at desc);
create index events_type_idx on app.events (type, created_at desc);
create index events_user_idx on app.events (user_id, created_at desc);
create index events_outbox_idx on app.events (id) where notify and notified_at is null;

-- Ограничение частоты запросов (скользящее окно по ключу)
create table app.rate_limits (
  key          text not null,
  window_start timestamptz not null,
  hits         int not null default 0,
  primary key (key, window_start)
);

-- Счётчики лимитов: одна строка на ключ, окно перезаписывается (таблица не растёт)
create table app.rate_counters (
  key          text primary key,
  window_start timestamptz not null,
  hits         int not null default 0
);

-- Вход через Telegram-бота (одноразовые запросы)
create table app.tg_login_requests (
  id            uuid primary key default gen_random_uuid(),
  nonce         text not null unique,
  poll_hash     text not null,
  code          text not null,
  mode          text not null check (mode in ('login', 'link')),
  link_user_id  uuid,
  ref_code      text,
  status        text not null default 'pending' check (status in ('pending', 'confirmed', 'consumed', 'rejected')),
  tg_id         bigint,
  tg_username   text,
  tg_first_name text,
  ip_hash       text,
  created_at    timestamptz not null default now(),
  expires_at    timestamptz not null default now() + interval '10 minutes'
);

-- RLS: включён везде, разрешающих политик нет — доступ только через функции.
alter table app.settings            enable row level security;
alter table app.services            enable row level security;
alter table app.discount_rules      enable row level security;
alter table app.admin_telegram_ids  enable row level security;
alter table app.profiles            enable row level security;
alter table app.telegram_identities enable row level security;
alter table app.referrals           enable row level security;
alter table app.bonuses             enable row level security;
alter table app.redemptions         enable row level security;
alter table app.bonus_claims        enable row level security;
alter table app.events              enable row level security;
alter table app.rate_limits         enable row level security;
alter table app.rate_counters       enable row level security;
alter table app.tg_login_requests   enable row level security;

revoke all on all tables in schema app from public, anon, authenticated;
revoke all on all sequences in schema app from public, anon, authenticated;
alter default privileges in schema app revoke all on tables from public, anon, authenticated;
alter default privileges in schema app revoke all on functions from public, anon, authenticated;
