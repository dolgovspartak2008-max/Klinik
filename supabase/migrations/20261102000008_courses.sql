-- =====================================================================
-- Онлайн-курсы: каталог, уроки, комплекты, промокоды, заказы, платежи,
-- возвраты, права доступа, подарки, прогресс, сессии просмотра.
--
-- Принципы те же, что у кабинета (см. 20261011000001_accounts.sql):
--   * таблицы в закрытой схеме app, RLS включён без разрешающих политик;
--   * сайт вызывает только public.* (security definer), каждая функция
--     сама проверяет пользователя, права и цену;
--   * цена, скидка, статус заказа и выдача доступа вычисляются только в базе;
--   * доступ выдаётся единственной функцией app.order_mark_paid — её вызовут
--     подтверждение администратора (сейчас) и вебхук платёжной системы (потом).
--   * видео лежат в приватном бакете course-videos; ссылку на просмотр выдаёт
--     только серверная функция courses после проверки права и сессии.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Каталог
-- ---------------------------------------------------------------------

create table app.course_categories (
  id          uuid primary key default gen_random_uuid(),
  slug        text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{1,59}$'),
  title       text not null check (char_length(title) between 2 and 120),
  description text not null default '' check (char_length(description) <= 1000),
  sort        int not null default 0,
  hidden      boolean not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table app.courses (
  id                uuid primary key default gen_random_uuid(),
  slug              text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{1,59}$'),
  category_id       uuid not null references app.course_categories (id) on delete restrict,
  title             text not null check (char_length(title) between 3 and 120),
  short             text not null default '' check (char_length(short) <= 400),
  direction         text not null default '' check (char_length(direction) <= 120),
  cover_url         text check (cover_url is null or cover_url ~ '^/sb/storage/v1/object/public/course-media/'),
  for_whom          text not null default '' check (char_length(for_whom) <= 4000),
  tasks             text not null default '' check (char_length(tasks) <= 4000),
  program           text not null default '' check (char_length(program) <= 4000),
  results           text not null default '' check (char_length(results) <= 4000),
  recommendations   text not null default '' check (char_length(recommendations) <= 4000),
  author            text not null default '' check (char_length(author) <= 4000),
  contraindications text not null default '' check (char_length(contraindications) <= 6000),
  access_terms      text not null default '' check (char_length(access_terms) <= 3000),
  price             numeric(12, 2) check (price >= 0 and price <= 1000000),
  old_price         numeric(12, 2) check (old_price > 0 and old_price <= 1000000),
  access_days       int check (access_days between 1 and 3650),   -- null = бессрочно
  status            text not null default 'draft' check (status in ('draft', 'published', 'archived')),
  sort              int not null default 0,
  published_at      timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  -- опубликовать можно только курс с ценой
  constraint course_publishable check (status <> 'published' or price is not null)
);
create index courses_category_idx on app.courses (category_id, sort);

create table app.lessons (
  id              uuid primary key default gen_random_uuid(),
  course_id       uuid not null references app.courses (id) on delete restrict,
  sort            int not null default 0,
  title           text not null check (char_length(title) between 2 and 160),
  description     text not null default '' check (char_length(description) <= 4000),
  recommendations text not null default '' check (char_length(recommendations) <= 4000),
  video_path      text check (video_path is null or video_path ~ '^lessons/[0-9a-f-]{36}/[A-Za-z0-9_-]{8,64}\.mp4$'),
  video_size      bigint,
  duration_sec    int check (duration_sec between 1 and 36000),
  poster_url      text check (poster_url is null or poster_url ~ '^/sb/storage/v1/object/public/course-media/'),
  is_free         boolean not null default false,   -- ознакомительный урок (после входа на сайт)
  hidden          boolean not null default true,    -- новый урок скрыт, пока его не опубликуют
  published_at    timestamptz,                       -- первая публикация (для уведомления «новый урок»)
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  -- показать урок можно только с видео
  constraint lesson_visible_has_video check (hidden or video_path is not null)
);
create index lessons_course_idx on app.lessons (course_id, sort);

create table app.bundles (
  id           uuid primary key default gen_random_uuid(),
  slug         text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{1,59}$'),
  title        text not null check (char_length(title) between 3 and 120),
  description  text not null default '' check (char_length(description) <= 4000),
  cover_url    text check (cover_url is null or cover_url ~ '^/sb/storage/v1/object/public/course-media/'),
  price        numeric(12, 2) check (price >= 0 and price <= 1000000),
  old_price    numeric(12, 2) check (old_price > 0 and old_price <= 1000000),
  -- что делать, если у покупателя уже есть часть курсов комплекта:
  --   prorate — цена уменьшается пропорционально стоимости уже купленных курсов;
  --   full    — полная цена (покупателя предупреждают);
  --   block   — купить нельзя, предлагаем докупить недостающие курсы по отдельности.
  overlap_mode text not null default 'prorate' check (overlap_mode in ('prorate', 'full', 'block')),
  status       text not null default 'draft' check (status in ('draft', 'published', 'archived')),
  sort         int not null default 0,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint bundle_publishable check (status <> 'published' or price is not null)
);

create table app.bundle_courses (
  bundle_id uuid not null references app.bundles (id) on delete cascade,
  course_id uuid not null references app.courses (id) on delete restrict,
  primary key (bundle_id, course_id)
);

-- ---------------------------------------------------------------------
-- Промокоды на курсы (отдельно от реферальных GIFT-XXXXX для услуг клиники)
-- ---------------------------------------------------------------------

create table app.course_promos (
  id            uuid primary key default gen_random_uuid(),
  code          text not null unique check (code ~ '^[A-Z0-9][A-Z0-9-]{2,29}$' and code !~ '^GIFT-'),
  discount_type text not null check (discount_type in ('percent', 'fixed')),
  amount        numeric(12, 2) not null check (amount > 0),
  max_uses      int check (max_uses between 1 and 100000),       -- null = без ограничения
  per_user      int not null default 1 check (per_user between 1 and 100),
  valid_from    timestamptz,
  valid_until   timestamptz,
  applies_all   boolean not null default true,
  course_ids    uuid[] not null default '{}',
  bundle_ids    uuid[] not null default '{}',
  active        boolean not null default true,
  note          text check (char_length(note) <= 300),
  created_by    uuid,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint promo_percent check (discount_type <> 'percent' or amount <= 100),
  constraint promo_scope check (applies_all or cardinality(course_ids) + cardinality(bundle_ids) > 0)
);

-- ---------------------------------------------------------------------
-- Заказы, платежи, возвраты
-- ---------------------------------------------------------------------

create table app.course_orders (
  id                  uuid primary key default gen_random_uuid(),
  order_no            bigint generated always as identity (start with 5001) unique,
  user_id             uuid not null references app.profiles (id) on delete restrict,
  item_type           text not null check (item_type in ('course', 'bundle')),
  course_id           uuid references app.courses (id) on delete restrict,
  bundle_id           uuid references app.bundles (id) on delete restrict,
  is_gift             boolean not null default false,
  title               text not null,
  course_ids          uuid[] not null,                -- какие курсы выдать после оплаты
  base_price          numeric(12, 2) not null check (base_price >= 0),
  discount            numeric(12, 2) not null default 0 check (discount >= 0),
  total               numeric(12, 2) not null check (total >= 0),
  promo_id            uuid references app.course_promos (id),
  promo_code          text,
  quote_note          text,
  status              text not null default 'pending'
                      check (status in ('pending', 'paid', 'cancelled', 'expired', 'refunded')),
  provider            text not null default 'manual' check (provider in ('manual', 'free', 'yookassa', 'telegram_stars')),
  provider_payment_id text,
  idempotency_key     text not null check (char_length(idempotency_key) between 8 and 64),
  paid_at             timestamptz,
  paid_amount         numeric(12, 2),
  cancel_reason       text,
  expires_at          timestamptz not null default now() + interval '72 hours',
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint order_item check ((item_type = 'course' and course_id is not null and bundle_id is null)
                            or (item_type = 'bundle' and bundle_id is not null and course_id is null)),
  constraint order_total check (total = base_price - discount)
);
create unique index course_orders_idem on app.course_orders (user_id, idempotency_key);
-- один открытый заказ на один товар (двойной клик, параллельные вкладки)
create unique index course_orders_one_pending on app.course_orders
  (user_id, item_type, coalesce(course_id, bundle_id), is_gift) where status = 'pending';
create unique index course_orders_provider on app.course_orders (provider, provider_payment_id)
  where provider_payment_id is not null;
create index course_orders_user_idx on app.course_orders (user_id, created_at desc);
create index course_orders_status_idx on app.course_orders (status, created_at desc);
create index course_orders_promo_idx on app.course_orders (promo_id) where promo_id is not null;

create table app.course_payments (
  id                  uuid primary key default gen_random_uuid(),
  order_id            uuid not null references app.course_orders (id) on delete restrict,
  provider            text not null,
  provider_payment_id text,
  amount              numeric(12, 2) not null check (amount >= 0),
  method              text,
  note                text check (char_length(note) <= 500),
  created_by          uuid,
  created_by_tg       bigint,
  created_at          timestamptz not null default now()
);
-- заказ оплачивается ровно один раз; один платёж провайдера — один заказ
create unique index course_payments_one_per_order on app.course_payments (order_id);
create unique index course_payments_provider on app.course_payments (provider, provider_payment_id)
  where provider_payment_id is not null;

create table app.course_refunds (
  id            uuid primary key default gen_random_uuid(),
  order_id      uuid not null references app.course_orders (id) on delete restrict,
  amount        numeric(12, 2) not null check (amount > 0),
  reason        text not null check (char_length(reason) between 3 and 500),
  revoke_access boolean not null,
  provider_refund_id text,
  created_by    uuid,
  created_at    timestamptz not null default now()
);
create index course_refunds_order_idx on app.course_refunds (order_id);

-- ---------------------------------------------------------------------
-- Подарки и права доступа
-- ---------------------------------------------------------------------

create table app.course_gifts (
  id           uuid primary key default gen_random_uuid(),
  code         text not null unique check (code ~ '^FZG-[A-Z0-9]{4}-[A-Z0-9]{4}$'),
  order_id     uuid not null unique references app.course_orders (id) on delete restrict,
  buyer_id     uuid not null references app.profiles (id) on delete restrict,
  title        text not null,
  course_ids   uuid[] not null,
  status       text not null default 'issued' check (status in ('issued', 'activated', 'cancelled')),
  activated_by uuid references app.profiles (id),
  activated_at timestamptz,
  created_at   timestamptz not null default now()
);

create table app.course_access (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references app.profiles (id) on delete restrict,
  course_id     uuid not null references app.courses (id) on delete restrict,
  source        text not null check (source in ('purchase', 'bundle', 'gift', 'manual', 'promo')),
  order_id      uuid references app.course_orders (id),
  gift_id       uuid references app.course_gifts (id),
  granted_by    uuid,
  grant_note    text check (char_length(grant_note) <= 300),
  granted_at    timestamptz not null default now(),
  expires_at    timestamptz,
  revoked_at    timestamptz,
  revoked_by    uuid,
  revoke_reason text check (char_length(revoke_reason) <= 500)
);
-- у человека не может быть двух действующих доступов к одному курсу
create unique index course_access_active on app.course_access (user_id, course_id) where revoked_at is null;
create index course_access_course_idx on app.course_access (course_id) where revoked_at is null;
create index course_access_order_idx on app.course_access (order_id);
create index course_access_gift_idx on app.course_access (gift_id);

-- ---------------------------------------------------------------------
-- Прогресс и сессии просмотра
-- ---------------------------------------------------------------------

create table app.lesson_progress (
  user_id      uuid not null references app.profiles (id) on delete restrict,
  lesson_id    uuid not null references app.lessons (id) on delete restrict,
  course_id    uuid not null references app.courses (id) on delete restrict,
  position_sec numeric(10, 2) not null default 0 check (position_sec >= 0),
  duration_sec numeric(10, 2),
  completed_at timestamptz,
  started_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  primary key (user_id, lesson_id)
);
create index lesson_progress_course_idx on app.lesson_progress (user_id, course_id, updated_at desc);

create table app.playback_sessions (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references app.profiles (id) on delete restrict,
  device_id    text not null check (device_id ~ '^[A-Za-z0-9_-]{16,64}$'),
  lesson_id    uuid references app.lessons (id),
  ip_hash      text,
  user_agent   text,
  urls_issued  int not null default 0,
  started_at   timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  ended_at     timestamptz,
  end_reason   text check (end_reason in ('replaced', 'stopped', 'expired', 'admin', 'revoked'))
);
-- одна незавершённая сессия на аккаунт
create unique index playback_one_active on app.playback_sessions (user_id) where ended_at is null;
create index playback_user_idx on app.playback_sessions (user_id, started_at desc);

-- ---------------------------------------------------------------------
-- Профиль: блокировка курсов и согласие на уведомления о новых уроках
-- ---------------------------------------------------------------------

alter table app.profiles add column if not exists courses_blocked boolean not null default false;
alter table app.profiles add column if not exists courses_block_reason text check (char_length(courses_block_reason) <= 300);
alter table app.profiles add column if not exists course_news boolean not null default true;

-- ---------------------------------------------------------------------
-- Очереди уведомлений: защита от дублей при повторной обработке
-- ---------------------------------------------------------------------

alter table app.tg_outbox add column if not exists dedupe_key text;
create unique index if not exists tg_outbox_dedupe on app.tg_outbox (dedupe_key) where dedupe_key is not null;

create table app.mail_outbox (
  id          bigint generated always as identity primary key,
  to_email    text not null,
  subject     text not null,
  body        text not null,
  dedupe_key  text not null unique,
  status      text not null default 'queued' check (status in ('queued', 'sent', 'failed')),
  attempts    int not null default 0,
  error       text,
  next_try_at timestamptz not null default now(),
  created_at  timestamptz not null default now(),
  sent_at     timestamptz
);
create index mail_outbox_queue on app.mail_outbox (next_try_at, id) where status = 'queued';

-- ---------------------------------------------------------------------
-- RLS: как и раньше — включён, разрешающих политик нет
-- ---------------------------------------------------------------------

alter table app.course_categories enable row level security;
alter table app.courses           enable row level security;
alter table app.lessons           enable row level security;
alter table app.bundles           enable row level security;
alter table app.bundle_courses    enable row level security;
alter table app.course_promos     enable row level security;
alter table app.course_orders     enable row level security;
alter table app.course_payments   enable row level security;
alter table app.course_refunds    enable row level security;
alter table app.course_gifts      enable row level security;
alter table app.course_access     enable row level security;
alter table app.lesson_progress   enable row level security;
alter table app.playback_sessions enable row level security;
alter table app.mail_outbox       enable row level security;
revoke all on all tables in schema app from public, anon, authenticated;
revoke all on all sequences in schema app from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- Хранилище: видео — приватно, обложки — публично. Политик на storage.objects
-- для этих бакетов нет: загрузка только по подписанным ссылкам, которые выдаёт
-- серверная функция администратору; чтение видео — только по подписанной ссылке.
-- ---------------------------------------------------------------------

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('course-videos', 'course-videos', false, 52428800, array['video/mp4']),
       ('course-media', 'course-media', true, 5242880, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update set public = excluded.public, file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;
