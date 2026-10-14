-- =====================================================================
-- 1. Персональная скидка, начисленная администратором вручную (kind = 'manual')
-- 2. Рассылка через Telegram-бота — только тем, кто сам включил «новости и акции»
-- Сообщения клиентам идут через очередь app.tg_outbox; её разбирает tg-bot (задача dispatch).
-- =====================================================================

-- ---------- 1. Персональные скидки ----------
alter table app.bonuses drop constraint if exists bonuses_kind_check;
alter table app.bonuses add constraint bonuses_kind_check
  check (kind in ('welcome', 'referral_invitee', 'referrer_reward', 'manual'));
alter table app.bonuses add column if not exists issued_by uuid;
alter table app.bonuses add column if not exists admin_note text check (char_length(admin_note) <= 300);

-- ---------- 2. Согласие на новости ----------
alter table app.profiles add column if not exists news_opt_in boolean not null default false;
alter table app.profiles add column if not exists news_opt_in_at timestamptz;

create table if not exists app.broadcasts (
  id          bigint generated always as identity primary key,
  text        text not null check (char_length(text) between 5 and 3500),
  with_button boolean not null default false,
  is_test     boolean not null default false,
  recipients  int not null default 0,
  created_by  uuid,
  created_at  timestamptz not null default now()
);

create table if not exists app.tg_outbox (
  id           bigint generated always as identity primary key,
  telegram_id  bigint not null,
  user_id      uuid,
  kind         text not null check (kind in ('broadcast', 'personal', 'test')),
  broadcast_id bigint references app.broadcasts (id),
  text         text not null,
  button_text  text,
  button_url   text,
  status       text not null default 'queued' check (status in ('queued', 'sent', 'failed')),
  attempts     int not null default 0,
  error        text,
  next_try_at  timestamptz not null default now(),
  created_at   timestamptz not null default now(),
  sent_at      timestamptz
);
-- одна рассылка — не больше одного сообщения на человека (повторный клик ничего не удвоит)
create unique index if not exists tg_outbox_once on app.tg_outbox (broadcast_id, telegram_id) where broadcast_id is not null;
create index if not exists tg_outbox_queue on app.tg_outbox (next_try_at, id) where status = 'queued';
create index if not exists tg_outbox_broadcast on app.tg_outbox (broadcast_id, status);

alter table app.broadcasts enable row level security;
alter table app.tg_outbox  enable row level security;
revoke all on app.broadcasts, app.tg_outbox from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- Начислить персональную скидку
-- ---------------------------------------------------------------------
create or replace function app.grant_bonus(p_user uuid, p jsonb, p_actor uuid, p_actor_tg bigint) returns jsonb
language plpgsql set search_path = '' as $$
declare
  v app.profiles;
  v_title text := left(regexp_replace(btrim(coalesce(p ->> 'title', '')), '\s+', ' ', 'g'), 80);
  v_type text := p ->> 'discount_type';
  v_amount numeric;
  v_days int;
  v_uses int;
  v_all boolean := coalesce((p ->> 'all_services')::boolean, true);
  v_ids text[];
  v_note text := left(nullif(btrim(coalesce(p ->> 'note', '')), ''), 300);
  v_id uuid;
  v_tg bigint;
  v_site text;
  v_expires timestamptz;
  v_queued boolean := false;
begin
  if not app.rl_hit('grant:' || coalesce(p_actor::text, p_actor_tg::text), 60, 3600) then raise exception 'rate_limited'; end if;
  select * into v from app.profiles where id = p_user for update;
  if not found then raise exception 'not_found'; end if;
  if v.status <> 'active' then raise exception 'user_not_active'; end if;

  begin
    v_amount := (p ->> 'amount')::numeric;
    v_days := (p ->> 'valid_days')::int;
    v_uses := coalesce(nullif(p ->> 'max_uses', '')::int, 1);
  exception when others then raise exception 'bad_bonus';
  end;
  if char_length(v_title) < 3 then raise exception 'bad_title'; end if;
  if v_type not in ('percent', 'fixed') or v_amount is null or v_amount <= 0
     or (v_type = 'percent' and v_amount > 100) or (v_type = 'fixed' and v_amount > 100000) then
    raise exception 'bad_amount';
  end if;
  if v_days is null or v_days not between 1 and 3650 then raise exception 'bad_days'; end if;
  if v_uses not between 1 and 100 then raise exception 'bad_uses'; end if;
  if not v_all then
    select coalesce(array_agg(s.id), '{}') into v_ids from app.services s
    where s.id in (select jsonb_array_elements_text(coalesce(p -> 'service_ids', '[]'::jsonb)));
    if cardinality(v_ids) = 0 then raise exception 'no_services'; end if;
  else
    v_ids := '{}';
  end if;

  v_expires := now() + make_interval(days => v_days);
  insert into app.bonuses (user_id, kind, title, discount_type, amount, all_services, service_ids,
                           max_uses, stackable, expires_at, issued_by, admin_note)
  values (v.id, 'manual', v_title, v_type, round(v_amount, 2), v_all, v_ids,
          v_uses, coalesce((p ->> 'stackable')::boolean, false), v_expires, p_actor, v_note)
  returning id into v_id;

  -- сообщить клиенту в Telegram (если привязан)
  if coalesce((p ->> 'notify')::boolean, true) then
    select telegram_id into v_tg from app.telegram_identities where user_id = v.id;
    if v_tg is not null then
      select site_url into v_site from app.settings;
      insert into app.tg_outbox (telegram_id, user_id, kind, text, button_text, button_url)
      values (v_tg, v.id, 'personal',
        '🎁 ' || coalesce(split_part(v.display_name, ' ', 1) || ', в', 'В') || 'ам начислена персональная скидка ' ||
        trim_scale(round(v_amount, 2))::text || case when v_type = 'percent' then '%' else ' ₽' end ||
        ' — «' || v_title || '».' || E'\n\n' ||
        'Действует до ' || to_char(v_expires at time zone 'Asia/Yekaterinburg', 'DD.MM.YYYY') || '. ' ||
        'Скидку можно использовать в личном кабинете на сайте — её подтвердит администратор на приёме.',
        'Открыть личный кабинет', rtrim(coalesce(v_site, 'https://www.fiziotera.online'), '/') || '/kabinet/');
      v_queued := true;
    end if;
  end if;

  perform app.log_event('bonus_granted', 'info', v.id, jsonb_build_object(
    'bonus_id', v_id, 'client_no', v.client_no, 'title', v_title, 'discount_type', v_type, 'amount', v_amount,
    'valid_days', v_days, 'note', v_note, 'client_notified', v_queued,
    'by_name', (select display_name from app.profiles where id = p_actor)), true, p_actor, p_actor_tg);
  if v_queued then perform app.call_bot('dispatch'); end if;
  return jsonb_build_object('ok', true, 'bonus_id', v_id, 'notified', v_queued);
end $$;

create or replace function public.admin_grant_bonus(p_user uuid, p_bonus jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_admin uuid;
begin v_admin := app.require_admin(); return app.grant_bonus(p_user, p_bonus, v_admin, null); end $$;

-- Карточка клиента в админке: + внутренний комментарий и кто начислил, + подписка на новости
create or replace function app.user_row(p app.profiles) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'id', p.id, 'client_no', p.client_no, 'name', p.display_name, 'email', p.email, 'phone', p.phone,
    'ref_code', p.ref_code, 'status', p.status, 'status_reason', p.status_reason, 'role', p.role,
    'is_admin', app.is_admin(p.id), 'signup_method', p.signup_method, 'created_at', p.created_at,
    'news_opt_in', p.news_opt_in,
    'telegram', (select jsonb_build_object('id', t.telegram_id, 'username', t.username)
                   from app.telegram_identities t where t.user_id = p.id),
    'invited_by', (select x.code from app.referrals x where x.invitee_id = p.id),
    'invites', (select count(*) from app.referrals x where x.referrer_id = p.id),
    'bonuses_active', (select count(*) from app.bonuses b where b.user_id = p.id and b.status in ('available', 'pending')))
$$;

create or replace function app.user_detail(p_user uuid) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'user', app.user_row(p),
    'bonuses', coalesce((select jsonb_agg(app.bonus_row(b) || jsonb_build_object('admin_note', b.admin_note,
        'issued_by', (select display_name from app.profiles a where a.id = b.issued_by)) order by b.created_at desc)
      from app.bonuses b where b.user_id = p.id), '[]'::jsonb),
    'invited', coalesce((select jsonb_agg(jsonb_build_object('client_no', i.client_no, 'name', i.display_name,
        'status', x.status, 'same_network', x.same_network, 'created_at', x.created_at, 'user_id', i.id) order by x.created_at desc)
      from app.referrals x join app.profiles i on i.id = x.invitee_id where x.referrer_id = p.id), '[]'::jsonb),
    'referrer', (select jsonb_build_object('client_no', o.client_no, 'name', o.display_name, 'code', x.code,
        'status', x.status, 'same_network', x.same_network, 'user_id', o.id)
      from app.referrals x join app.profiles o on o.id = x.referrer_id where x.invitee_id = p.id),
    'events', coalesce((select jsonb_agg(e order by e.id desc) from (
        select id, type, severity, data, created_at, actor_tg from app.events where user_id = p.id order by id desc limit 50) e), '[]'::jsonb))
  from app.profiles p where p.id = p_user
$$;

-- ---------------------------------------------------------------------
-- Рассылка
-- ---------------------------------------------------------------------
create or replace function app.broadcast_audience() returns table (user_id uuid, telegram_id bigint)
language sql stable set search_path = '' as $$
  select p.id, t.telegram_id from app.profiles p
  join app.telegram_identities t on t.user_id = p.id
  where p.status = 'active' and p.news_opt_in
$$;

create or replace function public.admin_broadcast_info() returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  perform app.require_admin();
  return jsonb_build_object(
    'audience', (select count(*) from app.broadcast_audience()),
    'telegram_total', (select count(*) from app.telegram_identities t join app.profiles p on p.id = t.user_id where p.status = 'active'),
    'admin_has_telegram', exists (select 1 from app.telegram_identities where user_id = auth.uid()),
    'history', coalesce((select jsonb_agg(row order by (row ->> 'id')::bigint desc) from (
      select jsonb_build_object('id', b.id, 'text', b.text, 'with_button', b.with_button, 'is_test', b.is_test,
        'created_at', b.created_at, 'recipients', b.recipients,
        'by', (select display_name from app.profiles a where a.id = b.created_by),
        'sent', (select count(*) from app.tg_outbox o where o.broadcast_id = b.id and o.status = 'sent'),
        'failed', (select count(*) from app.tg_outbox o where o.broadcast_id = b.id and o.status = 'failed'),
        'queued', (select count(*) from app.tg_outbox o where o.broadcast_id = b.id and o.status = 'queued')) as row
      from app.broadcasts b order by b.id desc limit 20) h), '[]'::jsonb));
end $$;

create or replace function public.admin_broadcast(p_text text, p_button boolean, p_test boolean) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_admin uuid;
  v_text text := btrim(regexp_replace(coalesce(p_text, ''), E'\r\n?', E'\n', 'g'));
  v_id bigint;
  v_n int;
  v_tg bigint;
  v_site text;
  v_btn_url text;
begin
  v_admin := app.require_admin();
  if char_length(v_text) < 5 then raise exception 'text_too_short'; end if;
  if char_length(v_text) > 3500 then raise exception 'text_too_long'; end if;
  select site_url into v_site from app.settings;
  v_btn_url := case when p_button then rtrim(coalesce(v_site, 'https://www.fiziotera.online'), '/') || '/#promo' end;

  if p_test then
    if not app.rl_hit('bctest:' || v_admin, 20, 3600) then raise exception 'rate_limited'; end if;
    select telegram_id into v_tg from app.telegram_identities where user_id = v_admin;
    if v_tg is null then raise exception 'no_telegram'; end if;
    insert into app.broadcasts (text, with_button, is_test, recipients, created_by)
    values (v_text, coalesce(p_button, false), true, 1, v_admin) returning id into v_id;
    insert into app.tg_outbox (telegram_id, user_id, kind, broadcast_id, text, button_text, button_url)
    values (v_tg, v_admin, 'test', v_id, v_text, case when p_button then 'Записаться' end, v_btn_url);
    perform app.call_bot('dispatch');
    return jsonb_build_object('ok', true, 'recipients', 1);
  end if;

  -- защита от случайного двойного нажатия и от слишком частых рассылок
  perform pg_advisory_xact_lock(hashtext('fiziotera:broadcast'));
  if exists (select 1 from app.broadcasts where not is_test and text = v_text and created_at > now() - interval '1 hour') then
    raise exception 'duplicate_broadcast';
  end if;
  if not app.rl_hit('broadcast', 5, 86400) then raise exception 'broadcast_limit'; end if;

  select count(*) into v_n from app.broadcast_audience();
  if v_n = 0 then raise exception 'no_audience'; end if;

  insert into app.broadcasts (text, with_button, is_test, recipients, created_by)
  values (v_text, coalesce(p_button, false), false, v_n, v_admin) returning id into v_id;
  insert into app.tg_outbox (telegram_id, user_id, kind, broadcast_id, text, button_text, button_url)
  select a.telegram_id, a.user_id, 'broadcast', v_id, v_text, case when p_button then 'Записаться' end, v_btn_url
  from app.broadcast_audience() a
  on conflict do nothing;

  perform app.log_event('broadcast_sent', 'info', null, jsonb_build_object(
    'broadcast_id', v_id, 'recipients', v_n, 'preview', left(v_text, 120),
    'by_name', (select display_name from app.profiles where id = v_admin)), true, v_admin, null);
  perform app.call_bot('dispatch');
  return jsonb_build_object('ok', true, 'recipients', v_n, 'broadcast_id', v_id);
end $$;

-- Клиент сам включает/выключает новости в кабинете
create or replace function public.set_news_opt_in(p_on boolean) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v app.profiles;
begin
  v := app.require_user();
  if not app.rl_hit('news:' || v.id, 20, 3600) then raise exception 'rate_limited'; end if;
  update app.profiles set news_opt_in = coalesce(p_on, false),
    news_opt_in_at = case when coalesce(p_on, false) then now() else news_opt_in_at end, updated_at = now()
  where id = v.id;
  perform app.log_event(case when p_on then 'news_subscribed' else 'news_unsubscribed' end, 'info', v.id,
    jsonb_build_object('client_no', v.client_no, 'source', 'site'), null);
  return jsonb_build_object('ok', true, 'news_opt_in', coalesce(p_on, false));
end $$;

-- ---------------------------------------------------------------------
-- Для бота: подписка командами /news и /stop, очередь сообщений
-- ---------------------------------------------------------------------
create or replace function public.svc_news_opt(p_tg bigint, p_on boolean) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_user uuid; v_no bigint;
begin
  select p.id, p.client_no into v_user, v_no from app.telegram_identities t join app.profiles p on p.id = t.user_id
  where t.telegram_id = p_tg and p.status = 'active';
  if v_user is null then return jsonb_build_object('ok', false, 'error', 'no_account'); end if;
  update app.profiles set news_opt_in = p_on, news_opt_in_at = case when p_on then now() else news_opt_in_at end,
    updated_at = now() where id = v_user;
  -- не отправлять то, что ещё стоит в очереди рассылки
  if not p_on then
    update app.tg_outbox set status = 'failed', error = 'unsubscribed'
    where telegram_id = p_tg and kind = 'broadcast' and status = 'queued';
  end if;
  perform app.log_event(case when p_on then 'news_subscribed' else 'news_unsubscribed' end, 'info', v_user,
    jsonb_build_object('client_no', v_no, 'source', 'telegram'), null);
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.svc_claim_outbox(p_limit int) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v jsonb;
begin
  with picked as (
    select o.id from app.tg_outbox o
    where o.status = 'queued' and o.next_try_at <= now()
    order by o.kind = 'broadcast', o.id   -- личные сообщения и проверки — первыми
    limit least(greatest(coalesce(p_limit, 50), 1), 200)
    for update skip locked
  ), upd as (
    update app.tg_outbox o set attempts = o.attempts + 1, next_try_at = now() + interval '3 minutes'
    from picked where o.id = picked.id
    returning o.*
  )
  select coalesce(jsonb_agg(jsonb_build_object('id', u.id, 'telegram_id', u.telegram_id, 'kind', u.kind,
      'text', u.text, 'button_text', u.button_text, 'button_url', u.button_url) order by u.kind = 'broadcast', u.id), '[]'::jsonb)
  into v from upd u;
  return v;
end $$;

-- p_result: 'sent' | 'retry' (временная ошибка, p_wait секунд) | 'blocked' (бот заблокирован) | 'failed'
create or replace function public.svc_outbox_result(p_id bigint, p_result text, p_error text, p_wait int) returns void
language plpgsql security definer set search_path = '' as $$
declare o app.tg_outbox;
begin
  select * into o from app.tg_outbox where id = p_id for update;
  if not found then return; end if;
  if p_result = 'sent' then
    update app.tg_outbox set status = 'sent', sent_at = now(), error = null where id = p_id;
  elsif p_result = 'retry' and (o.attempts < 6 or p_error in ('deferred', 'rate limited') or p_error like '429%') then
    -- «подождите» от Telegram и отложенные сообщения попыткой не считаются
    update app.tg_outbox set error = left(p_error, 300),
      attempts = case when p_error in ('deferred', 'rate limited') or p_error like '429%' then greatest(o.attempts - 1, 0) else o.attempts end,
      next_try_at = now() + make_interval(secs => greatest(coalesce(p_wait, 30), 5)) where id = p_id;
  else
    update app.tg_outbox set status = 'failed', error = left(coalesce(p_error, p_result), 300) where id = p_id;
    -- человек заблокировал бота — больше не пытаемся слать ему новости
    if p_result = 'blocked' and o.user_id is not null then
      update app.profiles set news_opt_in = false, updated_at = now() where id = o.user_id and news_opt_in;
    end if;
  end if;
end $$;

-- ---------------------------------------------------------------------
-- Кабинет: + news_opt_in
-- ---------------------------------------------------------------------
create or replace function public.my_dashboard() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v app.profiles;
  b record;
begin
  v := app.require_user();
  if v.onboarded_at is null then
    perform app.onboard(v.id, 'email', null, null, null);
    select * into v from app.profiles where id = v.id;
  end if;
  for b in select id from app.bonuses where user_id = v.id and status in ('available', 'pending') loop
    perform app.refresh_bonus(b.id);
  end loop;

  return jsonb_build_object(
    'profile', jsonb_build_object(
      'client_no', v.client_no, 'name', v.display_name, 'phone', v.phone, 'email', v.email,
      'name_confirmed', v.name_confirmed_at is not null and app.name_ok(v.display_name),
      'news_opt_in', v.news_opt_in,
      'ref_code', v.ref_code, 'created_at', v.created_at, 'is_admin', app.is_admin(v.id),
      'phone_locked', exists (select 1 from app.redemptions r where r.user_id = v.id and r.status in ('pending', 'confirmed')),
      'telegram', (select jsonb_build_object('username', t.username, 'first_name', t.first_name)
                     from app.telegram_identities t where t.user_id = v.id)),
    'program', jsonb_build_object(
      'referral_enabled', (select referral_enabled from app.settings),
      'site_url', (select site_url from app.settings),
      'rules', (select jsonb_object_agg(r.kind, app.rule_json(r) - 'service_ids' - 'updated_at') from app.discount_rules r)),
    'bonuses', coalesce((select jsonb_agg(app.bonus_row(x) order by
        case x.status when 'pending' then 0 when 'available' then 1 when 'used' then 2 else 3 end, x.created_at desc)
      from app.bonuses x where x.user_id = v.id), '[]'::jsonb),
    'referred_by', (select jsonb_build_object('name', app.mask_name(o.display_name), 'code', x.code, 'status', x.status)
      from app.referrals x join app.profiles o on o.id = x.referrer_id where x.invitee_id = v.id),
    'can_enter_code', not exists (select 1 from app.referrals x where x.invitee_id = v.id)
      and not exists (select 1 from app.redemptions r where r.user_id = v.id and r.status = 'confirmed'),
    'invites', coalesce((select jsonb_agg(jsonb_build_object('name', app.mask_name(i.display_name),
        'created_at', x.created_at, 'status', x.status,
        'reward', (select rb.status from app.bonuses rb where rb.source_referral_id = x.id and rb.kind = 'referrer_reward'))
        order by x.created_at desc)
      from app.referrals x join app.profiles i on i.id = x.invitee_id where x.referrer_id = v.id), '[]'::jsonb),
    'services', (select jsonb_agg(jsonb_build_object('id', id, 'title', title) order by sort) from app.services where active)
  );
end $$;

-- ---------------------------------------------------------------------
-- Права
-- ---------------------------------------------------------------------
revoke all on function app.grant_bonus(uuid, jsonb, uuid, bigint) from public, anon, authenticated;
revoke all on function app.broadcast_audience() from public, anon, authenticated;
revoke all on function public.admin_grant_bonus(uuid, jsonb) from public, anon;
revoke all on function public.admin_broadcast_info() from public, anon;
revoke all on function public.admin_broadcast(text, boolean, boolean) from public, anon;
revoke all on function public.set_news_opt_in(boolean) from public, anon;
grant execute on function public.admin_grant_bonus(uuid, jsonb) to authenticated;
grant execute on function public.admin_broadcast_info() to authenticated;
grant execute on function public.admin_broadcast(text, boolean, boolean) to authenticated;
grant execute on function public.set_news_opt_in(boolean) to authenticated;
revoke all on function public.svc_news_opt(bigint, boolean) from public, anon, authenticated;
revoke all on function public.svc_claim_outbox(int) from public, anon, authenticated;
revoke all on function public.svc_outbox_result(bigint, text, text, int) from public, anon, authenticated;
grant execute on function public.svc_news_opt(bigint, boolean) to service_role;
grant execute on function public.svc_claim_outbox(int) to service_role;
grant execute on function public.svc_outbox_result(bigint, text, text, int) to service_role;
revoke all on function app.name_ok(text) from public, anon, authenticated;
