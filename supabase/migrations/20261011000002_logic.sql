-- =====================================================================
-- Серверная логика: внутренние функции (app.*) и API для сайта (public.*)
-- Коды ошибок возвращаются в message исключения (например 'own_code'),
-- сайт переводит их в понятный русский текст.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Вспомогательные
-- ---------------------------------------------------------------------

create or replace function app.norm_phone(p text) returns text
language sql immutable set search_path = '' as $$
  select case
    when d ~ '^8[0-9]{10}$' then '7' || substr(d, 2)
    when d ~ '^9[0-9]{9}$' then '7' || d
    when d ~ '^[0-9]{10,15}$' then d
    else null end
  from (select regexp_replace(coalesce(p, ''), '\D', '', 'g') as d) s
$$;

create or replace function app.mask_name(p text) returns text
language sql immutable set search_path = '' as $$
  select case
    when p is null or btrim(p) = '' then 'Клиент'
    when position(' ' in btrim(p)) = 0 then btrim(p)
    else split_part(btrim(p), ' ', 1) || ' ' || left(split_part(btrim(p), ' ', 2), 1) || '.'
  end
$$;

create or replace function app.mask_phone(p text) returns text
language sql immutable set search_path = '' as $$
  select case when p is null then null
    else '+' || left(p, 1) || ' ••• •••-' || substr(p, length(p) - 3, 2) || '-' || right(p, 2) end
$$;

create or replace function app.gen_ref_code() returns text
language plpgsql volatile set search_path = '' as $$
declare
  alphabet constant text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  v_code text;
  v_bytes bytea;
  i int;
begin
  loop
    v_bytes := extensions.gen_random_bytes(5);
    v_code := 'GIFT-';
    for i in 0..4 loop
      v_code := v_code || substr(alphabet, (get_byte(v_bytes, i) % 31) + 1, 1);
    end loop;
    exit when not exists (select 1 from app.profiles where ref_code = v_code);
  end loop;
  return v_code;
end $$;

-- p_notify: true — всегда в Telegram, false — никогда, null — только в режиме диагностики
create or replace function app.log_event(
  p_type text, p_severity text, p_user uuid, p_data jsonb,
  p_notify boolean default false, p_actor uuid default null,
  p_actor_tg bigint default null, p_ip text default null
) returns bigint
language plpgsql set search_path = '' as $$
declare v_id bigint; v_notify boolean;
begin
  v_notify := coalesce(p_notify, (select diagnostics from app.settings));
  insert into app.events (type, severity, user_id, actor_id, actor_tg, ip_hash, data, notify)
  values (p_type, coalesce(p_severity, 'info'), p_user, p_actor, p_actor_tg, p_ip,
          coalesce(p_data, '{}'::jsonb), v_notify)
  returning id into v_id;
  return v_id;
end $$;

-- Фиксированное окно. true = запрос разрешён.
create or replace function app.rl_hit(p_key text, p_max int, p_window_seconds int) returns boolean
language plpgsql set search_path = '' as $$
declare
  v_window timestamptz := to_timestamp(floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds);
  v_hits int;
begin
  insert into app.rate_limits (key, window_start, hits) values (p_key, v_window, 1)
  on conflict (key, window_start) do update set hits = app.rate_limits.hits + 1
  returning hits into v_hits;
  return v_hits <= p_max;
end $$;

create or replace function app.is_admin(p_uid uuid) returns boolean
language sql stable set search_path = '' as $$
  select exists (
    select 1 from app.profiles p
    where p.id = p_uid and p.status = 'active'
      and (p.role = 'admin' or exists (
        select 1 from app.telegram_identities t
        join app.admin_telegram_ids a on a.telegram_id = t.telegram_id
        where t.user_id = p.id))
  )
$$;

create or replace function app.is_admin_tg(p_tg bigint) returns boolean
language sql stable set search_path = '' as $$
  select exists (select 1 from app.admin_telegram_ids where telegram_id = p_tg)
$$;

-- Текущий пользователь сайта: должен быть вошедшим и активным
create or replace function app.require_user() returns app.profiles
language plpgsql stable set search_path = '' as $$
declare v app.profiles;
begin
  if auth.uid() is null then raise exception 'not_authenticated'; end if;
  select * into v from app.profiles where id = auth.uid();
  if not found then raise exception 'profile_missing'; end if;
  if v.status = 'blocked' then raise exception 'account_blocked'; end if;
  if v.status <> 'active' then raise exception 'account_inactive'; end if;
  return v;
end $$;

create or replace function app.require_admin() returns uuid
language plpgsql stable set search_path = '' as $$
begin
  perform app.require_user();
  if not app.is_admin(auth.uid()) then
    raise exception 'forbidden';
  end if;
  return auth.uid();
end $$;

create or replace function app.service_titles(p_all boolean, p_ids text[]) returns jsonb
language sql stable set search_path = '' as $$
  select case when p_all then '[]'::jsonb else coalesce(
    (select jsonb_agg(jsonb_build_object('id', s.id, 'title', s.title) order by s.sort)
       from app.services s where s.id = any(p_ids)), '[]'::jsonb) end
$$;

create or replace function app.rule_json(r app.discount_rules) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'kind', r.kind, 'enabled', r.enabled, 'title', r.title, 'description', r.description,
    'discount_type', r.discount_type, 'amount', r.amount, 'all_services', r.all_services,
    'services', app.service_titles(r.all_services, r.service_ids),
    'service_ids', to_jsonb(r.service_ids),
    'valid_days', r.valid_days, 'max_uses', r.max_uses, 'stackable', r.stackable,
    'updated_at', r.updated_at)
$$;

-- ---------------------------------------------------------------------
-- Новый пользователь: профиль создаётся автоматически для любого способа входа
-- ---------------------------------------------------------------------

create or replace function app.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_email text;
begin
  v_email := case when new.email like '%@tg.fiziotera.online' then null else lower(new.email) end;
  loop
    begin
      insert into app.profiles (id, display_name, email, ref_code)
      values (new.id, left(nullif(btrim(new.raw_user_meta_data ->> 'full_name'), ''), 60),
              v_email, app.gen_ref_code());
      exit;
    exception when unique_violation then
      if exists (select 1 from app.profiles where id = new.id) then exit; end if;
      -- совпал промокод (крайне редко) — генерируем заново
    end;
  end loop;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function app.handle_new_user();

-- ---------------------------------------------------------------------
-- Бонусы
-- ---------------------------------------------------------------------

-- Выдать бонус по текущему правилу (если правило включено). Идемпотентно.
create or replace function app.issue_bonus(p_user uuid, p_kind text, p_referral uuid) returns uuid
language plpgsql set search_path = '' as $$
declare r app.discount_rules; v_id uuid;
begin
  select * into r from app.discount_rules where kind = p_kind;
  if not found or not r.enabled then return null; end if;
  if p_kind <> 'welcome' and not (select referral_enabled from app.settings) then return null; end if;

  insert into app.bonuses (user_id, kind, title, discount_type, amount, all_services, service_ids,
                           max_uses, stackable, expires_at, source_referral_id)
  values (p_user, p_kind, r.title, r.discount_type, r.amount, r.all_services, r.service_ids,
          r.max_uses, r.stackable, now() + make_interval(days => r.valid_days), p_referral)
  on conflict do nothing
  returning id into v_id;

  if v_id is not null then
    perform app.log_event('bonus_issued', 'info', p_user,
      jsonb_build_object('bonus_id', v_id, 'kind', p_kind, 'title', r.title,
                         'discount_type', r.discount_type, 'amount', r.amount),
      p_kind = 'referrer_reward');
  end if;
  return v_id;
end $$;

create or replace function app.refresh_bonus(p_bonus uuid) returns text
language plpgsql set search_path = '' as $$
declare v_status text;
begin
  update app.bonuses b set
    status = case
      when b.status = 'cancelled' then 'cancelled'
      when exists (select 1 from app.redemptions r where r.bonus_id = b.id and r.status = 'pending') then 'pending'
      when b.uses_confirmed >= b.max_uses then 'used'
      when b.expires_at < now() then 'expired'
      else 'available' end,
    updated_at = now()
  where b.id = p_bonus
  returning status into v_status;
  return v_status;
end $$;

create or replace function app.expire_bonuses() returns int
language plpgsql set search_path = '' as $$
declare n int;
begin
  update app.bonuses b set status = 'expired', updated_at = now()
  where b.status = 'available' and b.expires_at < now();
  get diagnostics n = row_count;
  delete from app.rate_limits where window_start < now() - interval '2 days';
  update app.tg_login_requests set status = 'rejected'
  where status in ('pending', 'confirmed') and expires_at < now();
  delete from app.tg_login_requests where created_at < now() - interval '7 days';
  return n;
end $$;

-- ---------------------------------------------------------------------
-- Реферальная программа
-- ---------------------------------------------------------------------

create or replace function app.attach_referral(p_user uuid, p_code text, p_ip text, p_source text) returns jsonb
language plpgsql set search_path = '' as $$
declare
  v_code text := upper(btrim(coalesce(p_code, '')));
  v_owner app.profiles;
  v_me app.profiles;
  v_ref uuid;
  v_bonus uuid;
  v_same boolean;
begin
  if v_code = '' then return jsonb_build_object('ok', false, 'error', 'code_empty'); end if;
  if not (select referral_enabled from app.settings) then
    return jsonb_build_object('ok', false, 'error', 'program_disabled');
  end if;

  select * into v_me from app.profiles where id = p_user;
  select * into v_owner from app.profiles where ref_code = v_code;
  if not found then
    perform app.log_event('ref_code_invalid', 'info', p_user, jsonb_build_object('code', left(v_code, 20)), null, null, null, p_ip);
    return jsonb_build_object('ok', false, 'error', 'code_not_found');
  end if;

  if v_owner.id = p_user then
    perform app.log_event('self_referral_attempt', 'warn', p_user,
      jsonb_build_object('code', v_code, 'source', p_source), true, null, null, p_ip);
    return jsonb_build_object('ok', false, 'error', 'own_code');
  end if;

  if v_owner.status <> 'active' then
    return jsonb_build_object('ok', false, 'error', 'code_inactive');
  end if;

  if exists (select 1 from app.referrals where invitee_id = p_user) then
    perform app.log_event('repeat_referral_attempt', 'warn', p_user,
      jsonb_build_object('code', v_code, 'source', p_source), true, null, null, p_ip);
    return jsonb_build_object('ok', false, 'error', 'already_referred');
  end if;

  if p_source = 'later' and exists (
      select 1 from app.redemptions where user_id = p_user and status = 'confirmed') then
    return jsonb_build_object('ok', false, 'error', 'not_first_visit');
  end if;

  -- Один и тот же телефон у пригласившего и приглашённого — это один человек
  if v_me.phone_norm is not null and v_me.phone_norm = v_owner.phone_norm then
    perform app.log_event('self_referral_suspected', 'alert', p_user,
      jsonb_build_object('code', v_code, 'referrer_no', v_owner.client_no, 'reason', 'same_phone'), true, null, null, p_ip);
    return jsonb_build_object('ok', false, 'error', 'own_code');
  end if;

  -- Общая сеть — НЕ повод блокировать (семья, офис), только отметка для администратора
  v_same := p_ip is not null and p_ip = v_owner.signup_ip_hash;

  insert into app.referrals (referrer_id, invitee_id, code, same_network)
  values (v_owner.id, p_user, v_code, v_same)
  on conflict (invitee_id) do nothing
  returning id into v_ref;
  if v_ref is null then return jsonb_build_object('ok', false, 'error', 'already_referred'); end if;

  v_bonus := app.issue_bonus(p_user, 'referral_invitee', v_ref);

  perform app.log_event('referral_applied', case when v_same then 'warn' else 'info' end, p_user,
    jsonb_build_object('code', v_code, 'referrer_no', v_owner.client_no,
      'referrer_name', app.mask_name(v_owner.display_name), 'source', p_source,
      'same_network', v_same, 'bonus', case when v_bonus is null then 'not_issued' else 'available' end),
    true, null, null, p_ip);

  return jsonb_build_object('ok', true, 'bonus_issued', v_bonus is not null);
end $$;

-- Завершение регистрации: приветственный бонус, промокод друга, проверки
create or replace function app.onboard(p_user uuid, p_method text, p_ref text, p_ip text, p_phone text) returns jsonb
language plpgsql set search_path = '' as $$
declare
  v app.profiles;
  v_phone text := app.norm_phone(p_phone);
  v_welcome uuid;
  v_ref jsonb := null;
  v_same_net int;
begin
  select * into v from app.profiles where id = p_user for update;
  if not found then raise exception 'profile_missing'; end if;
  if v.onboarded_at is not null then return jsonb_build_object('ok', true, 'already', true); end if;

  update app.profiles set
    onboarded_at = now(),
    signup_method = coalesce(p_method, 'email'),
    signup_ip_hash = p_ip,
    phone = coalesce(phone, case when v_phone is not null then '+' || v_phone end),
    phone_norm = coalesce(phone_norm, v_phone),
    updated_at = now()
  where id = p_user
  returning * into v;

  v_welcome := app.issue_bonus(p_user, 'welcome', null);

  if nullif(btrim(coalesce(p_ref, '')), '') is not null then
    v_ref := app.attach_referral(p_user, p_ref, p_ip, 'signup');
  end if;

  perform app.log_event('user_registered', 'info', p_user, jsonb_build_object(
    'client_no', v.client_no, 'name', v.display_name, 'method', v.signup_method,
    'ref_code', v.ref_code, 'invited_with', upper(nullif(btrim(coalesce(p_ref, '')), '')),
    'invite_result', v_ref, 'welcome', v_welcome is not null), true, null, null, p_ip);

  -- Много регистраций из одной сети за сутки — сигнал, но не блокировка
  if p_ip is not null then
    select count(*) into v_same_net from app.profiles
    where signup_ip_hash = p_ip and created_at > now() - interval '24 hours';
    if v_same_net >= 4 then
      perform app.log_event('suspicious_signups', 'warn', p_user,
        jsonb_build_object('count_24h', v_same_net, 'client_no', v.client_no), true, null, null, p_ip);
    end if;
  end if;

  if v.phone_norm is not null and exists (
      select 1 from app.profiles where phone_norm = v.phone_norm and id <> p_user) then
    perform app.log_event('duplicate_phone', 'warn', p_user,
      jsonb_build_object('client_no', v.client_no, 'phone', app.mask_phone(v.phone_norm)), true);
  end if;

  return jsonb_build_object('ok', true, 'welcome', v_welcome is not null, 'referral', v_ref);
end $$;

-- ---------------------------------------------------------------------
-- Использование скидки: запрос → подтверждение администратором
-- ---------------------------------------------------------------------

create or replace function app.decide(p_redemption uuid, p_decision text, p_actor uuid, p_actor_tg bigint, p_note text)
returns jsonb
language plpgsql set search_path = '' as $$
declare
  r app.redemptions;
  b app.bonuses;
  v_ref app.referrals;
  v_reward uuid;
  v_rb app.bonuses;
  v_note text := left(nullif(btrim(coalesce(p_note, '')), ''), 300);
  v_client bigint;
begin
  select * into r from app.redemptions where id = p_redemption for update;
  if not found then raise exception 'not_found'; end if;
  select * into b from app.bonuses where id = r.bonus_id for update;
  select client_no into v_client from app.profiles where id = r.user_id;

  if p_decision = 'confirm' then
    if r.status <> 'pending' then raise exception 'not_pending'; end if;
    if b.status = 'cancelled' then raise exception 'bonus_cancelled'; end if;
    update app.redemptions set status = 'confirmed', decided_at = now(), decided_by = p_actor,
      decided_by_tg = p_actor_tg, note = coalesce(v_note, note) where id = r.id;
    update app.bonuses set uses_confirmed = uses_confirmed + 1 where id = b.id;
    perform app.refresh_bonus(b.id);

    perform app.log_event('bonus_confirmed', 'info', r.user_id, jsonb_build_object(
      'client_no', v_client, 'bonus', b.title, 'kind', b.kind, 'discount_type', b.discount_type,
      'amount', b.amount, 'service', (select title from app.services where id = r.service_id)),
      true, p_actor, p_actor_tg);

    -- Первая подтверждённая услуга приглашённого клиента
    update app.referrals set status = 'qualified', qualified_at = now()
    where invitee_id = r.user_id and status = 'registered'
    returning * into v_ref;
    if found then
      v_reward := app.issue_bonus(v_ref.referrer_id, 'referrer_reward', v_ref.id);
      perform app.log_event('referral_qualified', 'info', v_ref.referrer_id, jsonb_build_object(
        'code', v_ref.code, 'invitee_no', v_client,
        'referrer_no', (select client_no from app.profiles where id = v_ref.referrer_id),
        'reward', case when v_reward is null then 'disabled' else 'issued' end), true, p_actor, p_actor_tg);
    end if;

  elsif p_decision = 'cancel' then
    if r.status <> 'pending' then raise exception 'not_pending'; end if;
    update app.redemptions set status = 'cancelled', decided_at = now(), decided_by = p_actor,
      decided_by_tg = p_actor_tg, note = coalesce(v_note, note) where id = r.id;
    -- визит не состоялся — человек сохраняет право на подарок
    if b.uses_confirmed = 0 then
      update app.bonus_claims set released_at = now() where redemption_id = r.id and released_at is null;
    end if;
    perform app.refresh_bonus(b.id);
    perform app.log_event('bonus_request_cancelled', 'info', r.user_id, jsonb_build_object(
      'client_no', v_client, 'bonus', b.title, 'by', case when p_actor = r.user_id then 'client' else 'admin' end,
      'note', v_note), true, p_actor, p_actor_tg);

  elsif p_decision = 'refund' then
    if r.status <> 'confirmed' then raise exception 'not_confirmed'; end if;
    update app.redemptions set status = 'refunded', decided_at = now(), decided_by = p_actor,
      decided_by_tg = p_actor_tg, note = coalesce(v_note, note) where id = r.id;
    update app.bonuses set status = 'cancelled', cancel_reason = 'Возврат за услугу' || coalesce(': ' || v_note, ''),
      updated_at = now() where id = b.id;

    -- Пересчёт реферальной цепочки: приглашение снова «не подтверждено»,
    -- награда пригласившему отменяется
    update app.referrals set status = 'registered', qualified_at = null
    where invitee_id = r.user_id and status = 'qualified'
      and not exists (select 1 from app.redemptions x where x.user_id = r.user_id and x.status = 'confirmed')
    returning * into v_ref;
    if found then
      select * into v_rb from app.bonuses where source_referral_id = v_ref.id and kind = 'referrer_reward' for update;
      if found then
        if v_rb.uses_confirmed > 0 then
          perform app.log_event('reward_used_before_refund', 'alert', v_ref.referrer_id, jsonb_build_object(
            'referrer_no', (select client_no from app.profiles where id = v_ref.referrer_id),
            'invitee_no', v_client), true, p_actor, p_actor_tg);
        else
          update app.redemptions set status = 'cancelled', decided_at = now(), note = 'Отменено: возврат у приглашённого'
          where bonus_id = v_rb.id and status = 'pending';
          update app.bonuses set status = 'cancelled', cancel_reason = 'Приглашённый клиент оформил возврат', updated_at = now()
          where id = v_rb.id;
        end if;
      end if;
    end if;

    perform app.log_event('bonus_refunded', 'warn', r.user_id, jsonb_build_object(
      'client_no', v_client, 'bonus', b.title, 'note', v_note), true, p_actor, p_actor_tg);
  else
    raise exception 'bad_decision';
  end if;

  return jsonb_build_object('ok', true, 'status', (select status from app.redemptions where id = r.id));
end $$;

create or replace function app.cancel_bonus(p_bonus uuid, p_reason text, p_actor uuid, p_actor_tg bigint) returns jsonb
language plpgsql set search_path = '' as $$
declare b app.bonuses;
begin
  select * into b from app.bonuses where id = p_bonus for update;
  if not found then raise exception 'not_found'; end if;
  if b.status = 'cancelled' then return jsonb_build_object('ok', true, 'already', true); end if;
  update app.redemptions set status = 'cancelled', decided_at = now(), decided_by = p_actor,
    decided_by_tg = p_actor_tg, note = 'Бонус отменён администратором'
  where bonus_id = b.id and status = 'pending';
  -- право на подарок НЕ возвращается: отмена за нарушение
  update app.bonuses set status = 'cancelled', updated_at = now(),
    cancel_reason = left(coalesce(nullif(btrim(p_reason), ''), 'Отменён администратором'), 300)
  where id = b.id;
  perform app.log_event('bonus_cancelled', 'info', b.user_id, jsonb_build_object(
    'client_no', (select client_no from app.profiles where id = b.user_id),
    'bonus', b.title, 'reason', p_reason), true, p_actor, p_actor_tg);
  return jsonb_build_object('ok', true);
end $$;

create or replace function app.set_user_status(p_user uuid, p_status text, p_reason text, p_actor uuid, p_actor_tg bigint)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v app.profiles;
begin
  if p_status not in ('active', 'blocked') then raise exception 'bad_status'; end if;
  if p_user = p_actor then raise exception 'cannot_block_self'; end if;
  select * into v from app.profiles where id = p_user for update;
  if not found then raise exception 'not_found'; end if;
  if v.status = 'deleted' then raise exception 'account_deleted'; end if;
  update app.profiles set status = p_status, status_reason = left(p_reason, 300), updated_at = now() where id = p_user;
  -- блокировка входа на уровне Supabase Auth (действует при следующем обновлении сессии)
  update auth.users set banned_until = case when p_status = 'blocked' then now() + interval '100 years' else null end
  where id = p_user;
  perform app.log_event(case when p_status = 'blocked' then 'user_blocked' else 'user_unblocked' end, 'info', p_user,
    jsonb_build_object('client_no', v.client_no, 'reason', p_reason), true, p_actor, p_actor_tg);
  return jsonb_build_object('ok', true);
end $$;

-- ---------------------------------------------------------------------
-- Администрирование: чтение
-- ---------------------------------------------------------------------

create or replace function app.overview() returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'users_total', (select count(*) from app.profiles where status <> 'deleted'),
    'users_today', (select count(*) from app.profiles where created_at > date_trunc('day', now() at time zone 'Asia/Yekaterinburg') at time zone 'Asia/Yekaterinburg'),
    'users_7d', (select count(*) from app.profiles where created_at > now() - interval '7 days'),
    'blocked', (select count(*) from app.profiles where status = 'blocked'),
    'telegram_linked', (select count(*) from app.telegram_identities),
    'referrals_total', (select count(*) from app.referrals),
    'referrals_qualified', (select count(*) from app.referrals where status = 'qualified'),
    'bonuses', (select coalesce(jsonb_object_agg(status, n), '{}'::jsonb)
                  from (select status, count(*) n from app.bonuses group by status) s),
    'redemptions_pending', (select count(*) from app.redemptions where status = 'pending'),
    'redemptions_confirmed', (select count(*) from app.redemptions where status = 'confirmed'),
    'suspicious_7d', (select count(*) from app.events where severity in ('warn', 'alert') and created_at > now() - interval '7 days'),
    'series', (select coalesce(jsonb_agg(jsonb_build_object('day', d, 'users', u, 'referrals', rf, 'confirmed', c) order by d), '[]'::jsonb)
      from (select g::date d,
              (select count(*) from app.profiles p where (p.created_at at time zone 'Asia/Yekaterinburg')::date = g::date) u,
              (select count(*) from app.referrals x where (x.created_at at time zone 'Asia/Yekaterinburg')::date = g::date) rf,
              (select count(*) from app.redemptions y where y.status = 'confirmed' and (y.decided_at at time zone 'Asia/Yekaterinburg')::date = g::date) c
            from generate_series((now() at time zone 'Asia/Yekaterinburg')::date - 13, (now() at time zone 'Asia/Yekaterinburg')::date, interval '1 day') g) s),
    'settings', (select jsonb_build_object('referral_enabled', referral_enabled, 'diagnostics', diagnostics) from app.settings),
    'rules', (select jsonb_object_agg(r.kind, app.rule_json(r)) from app.discount_rules r),
    'services', (select jsonb_agg(jsonb_build_object('id', id, 'title', title, 'active', active) order by sort) from app.services)
  )
$$;

create or replace function app.user_row(p app.profiles) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'id', p.id, 'client_no', p.client_no, 'name', p.display_name, 'email', p.email, 'phone', p.phone,
    'ref_code', p.ref_code, 'status', p.status, 'status_reason', p.status_reason, 'role', p.role,
    'is_admin', app.is_admin(p.id), 'signup_method', p.signup_method, 'created_at', p.created_at,
    'telegram', (select jsonb_build_object('id', t.telegram_id, 'username', t.username)
                   from app.telegram_identities t where t.user_id = p.id),
    'invited_by', (select x.code from app.referrals x where x.invitee_id = p.id),
    'invites', (select count(*) from app.referrals x where x.referrer_id = p.id),
    'bonuses_active', (select count(*) from app.bonuses b where b.user_id = p.id and b.status in ('available', 'pending')))
$$;

create or replace function app.find_users(p_q text, p_limit int, p_offset int) returns jsonb
language plpgsql stable set search_path = '' as $$
declare
  v_q text := btrim(coalesce(p_q, ''));
  v_digits text := regexp_replace(v_q, '\D', '', 'g');
  v_like text := '%' || replace(replace(replace(v_q, '\', '\\'), '%', '\%'), '_', '\_') || '%';
begin
  return jsonb_build_object(
    'total', (select count(*) from app.profiles p where v_q = ''
       or p.display_name ilike v_like or p.email ilike v_like or p.ref_code ilike v_like
       or (v_digits <> '' and (p.client_no::text = v_digits or p.phone_norm like '%' || v_digits || '%'))
       or exists (select 1 from app.telegram_identities t where t.user_id = p.id and t.username ilike v_like)),
    'items', coalesce((select jsonb_agg(app.user_row(p) order by p.created_at desc)
       from (select * from app.profiles p where v_q = ''
         or p.display_name ilike v_like or p.email ilike v_like or p.ref_code ilike v_like
         or (v_digits <> '' and (p.client_no::text = v_digits or p.phone_norm like '%' || v_digits || '%'))
         or exists (select 1 from app.telegram_identities t where t.user_id = p.id and t.username ilike v_like)
         order by p.created_at desc
         limit least(greatest(coalesce(p_limit, 30), 1), 100) offset greatest(coalesce(p_offset, 0), 0)) p), '[]'::jsonb));
end $$;

create or replace function app.bonus_row(b app.bonuses) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'id', b.id, 'kind', b.kind, 'title', b.title, 'discount_type', b.discount_type, 'amount', b.amount,
    'all_services', b.all_services, 'services', app.service_titles(b.all_services, b.service_ids),
    'max_uses', b.max_uses, 'uses_confirmed', b.uses_confirmed, 'stackable', b.stackable,
    'status', b.status, 'expires_at', b.expires_at, 'created_at', b.created_at, 'cancel_reason', b.cancel_reason,
    'redemptions', coalesce((select jsonb_agg(jsonb_build_object(
        'id', r.id, 'service', s.title, 'service_id', r.service_id, 'status', r.status,
        'requested_at', r.requested_at, 'decided_at', r.decided_at, 'note', r.note) order by r.requested_at desc)
      from app.redemptions r join app.services s on s.id = r.service_id where r.bonus_id = b.id), '[]'::jsonb))
$$;

create or replace function app.user_detail(p_user uuid) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'user', app.user_row(p),
    'bonuses', coalesce((select jsonb_agg(app.bonus_row(b) order by b.created_at desc) from app.bonuses b where b.user_id = p.id), '[]'::jsonb),
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

create or replace function app.list_referrals(p_q text, p_limit int, p_offset int) returns jsonb
language sql stable set search_path = '' as $$
  select coalesce(jsonb_agg(row order by (row ->> 'created_at') desc), '[]'::jsonb) from (
    select jsonb_build_object('id', x.id, 'code', x.code, 'status', x.status, 'same_network', x.same_network,
      'created_at', x.created_at, 'qualified_at', x.qualified_at,
      'referrer', jsonb_build_object('id', o.id, 'client_no', o.client_no, 'name', o.display_name),
      'invitee', jsonb_build_object('id', i.id, 'client_no', i.client_no, 'name', i.display_name)) as row
    from app.referrals x join app.profiles o on o.id = x.referrer_id join app.profiles i on i.id = x.invitee_id
    where coalesce(btrim(p_q), '') = '' or x.code ilike '%' || btrim(p_q) || '%'
       or o.client_no::text = btrim(p_q) or i.client_no::text = btrim(p_q)
       or o.display_name ilike '%' || btrim(p_q) || '%' or i.display_name ilike '%' || btrim(p_q) || '%'
    order by x.created_at desc
    limit least(greatest(coalesce(p_limit, 50), 1), 200) offset greatest(coalesce(p_offset, 0), 0)) t
$$;

create or replace function app.list_redemptions(p_status text, p_limit int, p_offset int) returns jsonb
language sql stable set search_path = '' as $$
  select coalesce(jsonb_agg(row order by (row ->> 'requested_at') desc), '[]'::jsonb) from (
    select jsonb_build_object('id', r.id, 'status', r.status, 'requested_at', r.requested_at, 'decided_at', r.decided_at,
      'note', r.note, 'service', s.title, 'phone', '+' || r.phone_norm,
      'bonus', jsonb_build_object('id', b.id, 'title', b.title, 'kind', b.kind, 'discount_type', b.discount_type,
         'amount', b.amount, 'status', b.status, 'stackable', b.stackable),
      'user', jsonb_build_object('id', p.id, 'client_no', p.client_no, 'name', p.display_name),
      'invited_by', (select x.code from app.referrals x where x.invitee_id = p.id)) as row
    from app.redemptions r join app.bonuses b on b.id = r.bonus_id join app.profiles p on p.id = r.user_id
    join app.services s on s.id = r.service_id
    where coalesce(p_status, '') = '' or r.status = p_status
    order by r.requested_at desc
    limit least(greatest(coalesce(p_limit, 50), 1), 200) offset greatest(coalesce(p_offset, 0), 0)) t
$$;

create or replace function app.list_events(p_type text, p_severity text, p_before bigint, p_limit int) returns jsonb
language sql stable set search_path = '' as $$
  select coalesce(jsonb_agg(row order by (row ->> 'id')::bigint desc), '[]'::jsonb) from (
    select jsonb_build_object('id', e.id, 'type', e.type, 'severity', e.severity, 'data', e.data,
      'created_at', e.created_at, 'actor_tg', e.actor_tg, 'notified', e.notified_at is not null,
      'user', case when p.id is null then null else jsonb_build_object('id', p.id, 'client_no', p.client_no, 'name', p.display_name) end) as row
    from app.events e left join app.profiles p on p.id = e.user_id
    where (coalesce(p_type, '') = '' or e.type = p_type)
      and (coalesce(p_severity, '') = '' or (p_severity = 'suspicious' and e.severity in ('warn', 'alert')) or e.severity = p_severity)
      and (p_before is null or e.id < p_before)
    order by e.id desc
    limit least(greatest(coalesce(p_limit, 50), 1), 200)) t
$$;

create or replace function app.top_referrers(p_limit int) returns jsonb
language sql stable set search_path = '' as $$
  select coalesce(jsonb_agg(row), '[]'::jsonb) from (
    select jsonb_build_object('client_no', p.client_no, 'name', p.display_name, 'code', p.ref_code,
      'invited', count(x.id), 'qualified', count(x.id) filter (where x.status = 'qualified')) as row
    from app.profiles p join app.referrals x on x.referrer_id = p.id
    group by p.id order by count(x.id) desc limit least(greatest(coalesce(p_limit, 10), 1), 50)) t
$$;

-- ---------------------------------------------------------------------
-- Администрирование: изменения условий
-- ---------------------------------------------------------------------

create or replace function app.update_rule(p_kind text, p jsonb, p_actor uuid, p_actor_tg bigint) returns jsonb
language plpgsql set search_path = '' as $$
declare
  v_old app.discount_rules;
  v_new app.discount_rules;
  v_ids text[];
begin
  select * into v_old from app.discount_rules where kind = p_kind for update;
  if not found then raise exception 'not_found'; end if;

  if p ? 'service_ids' then
    select coalesce(array_agg(distinct x), '{}') into v_ids
    from jsonb_array_elements_text(p -> 'service_ids') x
    where x in (select id from app.services);
  end if;

  begin
    update app.discount_rules set
      enabled       = coalesce((p ->> 'enabled')::boolean, enabled),
      title         = coalesce(left(nullif(btrim(p ->> 'title'), ''), 80), title),
      description   = coalesce(left(p ->> 'description', 500), description),
      discount_type = case when p ? 'discount_type' then nullif(p ->> 'discount_type', '') else discount_type end,
      amount        = case when p ? 'amount' then nullif(p ->> 'amount', '')::numeric else amount end,
      all_services  = coalesce((p ->> 'all_services')::boolean, all_services),
      service_ids   = coalesce(v_ids, service_ids),
      valid_days    = case when p ? 'valid_days' then nullif(p ->> 'valid_days', '')::int else valid_days end,
      max_uses      = coalesce(nullif(p ->> 'max_uses', '')::int, max_uses),
      stackable     = coalesce((p ->> 'stackable')::boolean, stackable),
      updated_at    = now(),
      updated_by    = p_actor
    where kind = p_kind
    returning * into v_new;
  exception
    when check_violation then raise exception 'rule_incomplete';
    when invalid_text_representation or numeric_value_out_of_range then raise exception 'rule_bad_value';
  end;

  perform app.log_event('rules_changed', 'info', p_actor, jsonb_build_object(
    'kind', p_kind, 'title', v_new.title, 'before', app.rule_json(v_old) - 'services' - 'updated_at',
    'after', app.rule_json(v_new) - 'services' - 'updated_at'), true, p_actor, p_actor_tg);
  return app.rule_json(v_new);
end $$;

create or replace function app.update_settings(p jsonb, p_actor uuid, p_actor_tg bigint) returns jsonb
language plpgsql set search_path = '' as $$
declare v_old app.settings; v_new app.settings;
begin
  select * into v_old from app.settings for update;
  update app.settings set
    referral_enabled = coalesce((p ->> 'referral_enabled')::boolean, referral_enabled),
    diagnostics      = coalesce((p ->> 'diagnostics')::boolean, diagnostics),
    updated_at = now(), updated_by = p_actor
  where id
  returning * into v_new;
  perform app.log_event('settings_changed', 'info', p_actor, jsonb_build_object(
    'referral_enabled', jsonb_build_array(v_old.referral_enabled, v_new.referral_enabled),
    'diagnostics', jsonb_build_array(v_old.diagnostics, v_new.diagnostics)), true, p_actor, p_actor_tg);
  return jsonb_build_object('referral_enabled', v_new.referral_enabled, 'diagnostics', v_new.diagnostics);
end $$;

create or replace function app.update_service(p_id text, p_active boolean, p_actor uuid, p_actor_tg bigint) returns jsonb
language plpgsql set search_path = '' as $$
begin
  update app.services set active = p_active where id = p_id;
  if not found then raise exception 'not_found'; end if;
  perform app.log_event('service_toggled', 'info', p_actor, jsonb_build_object('service', p_id, 'active', p_active), true, p_actor, p_actor_tg);
  return jsonb_build_object('ok', true);
end $$;

-- =====================================================================
-- API для сайта (вошедший пользователь)
-- =====================================================================

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
    'can_enter_code', (select referral_enabled from app.settings)
      and not exists (select 1 from app.referrals x where x.invitee_id = v.id)
      and not exists (select 1 from app.redemptions r where r.user_id = v.id and r.status = 'confirmed'),
    'invites', coalesce((select jsonb_agg(jsonb_build_object('name', app.mask_name(i.display_name),
        'created_at', x.created_at, 'status', x.status,
        'reward', (select rb.status from app.bonuses rb where rb.source_referral_id = x.id and rb.kind = 'referrer_reward'))
        order by x.created_at desc)
      from app.referrals x join app.profiles i on i.id = x.invitee_id where x.referrer_id = v.id), '[]'::jsonb),
    'services', (select jsonb_agg(jsonb_build_object('id', id, 'title', title) order by sort) from app.services where active)
  );
end $$;

create or replace function public.update_my_profile(p_name text, p_phone text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v app.profiles;
  v_name text := left(nullif(btrim(coalesce(p_name, '')), ''), 60);
  v_phone text := app.norm_phone(p_phone);
begin
  v := app.require_user();
  if not app.rl_hit('profile:' || v.id, 20, 3600) then raise exception 'rate_limited'; end if;
  if v_name is not null and char_length(v_name) < 2 then raise exception 'bad_name'; end if;
  if nullif(btrim(coalesce(p_phone, '')), '') is not null and v_phone is null then raise exception 'bad_phone'; end if;
  if v_phone is distinct from v.phone_norm and exists (
      select 1 from app.redemptions r where r.user_id = v.id and r.status in ('pending', 'confirmed')) then
    raise exception 'phone_locked';
  end if;

  update app.profiles set display_name = v_name,
    phone = case when v_phone is null then null else '+' || v_phone end,
    phone_norm = v_phone, updated_at = now()
  where id = v.id;

  if v_phone is not null and v_phone is distinct from v.phone_norm and exists (
      select 1 from app.profiles where phone_norm = v_phone and id <> v.id) then
    perform app.log_event('duplicate_phone', 'warn', v.id,
      jsonb_build_object('client_no', v.client_no, 'phone', app.mask_phone(v_phone)), true);
  end if;
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.apply_ref_code(p_code text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v app.profiles; v_res jsonb;
begin
  v := app.require_user();
  if not app.rl_hit('refapply:' || v.id, 10, 3600) then raise exception 'rate_limited'; end if;
  perform 1 from app.profiles where id = v.id for update; -- сериализуем параллельные попытки
  -- ошибку возвращаем в ответе, а не исключением, чтобы запись о попытке осталась в журнале
  return app.attach_referral(v.id, p_code, null, 'later');
end $$;

create or replace function public.request_bonus(p_bonus uuid, p_service text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v app.profiles;
  b app.bonuses;
  v_status text;
  v_claim app.bonus_claims;
  v_rid uuid;
  v_ref app.referrals;
  v_service text;
begin
  v := app.require_user();
  if not app.rl_hit('bonusreq:' || v.id, 10, 3600) then raise exception 'rate_limited'; end if;

  -- блокировка профиля сериализует все запросы одного пользователя (двойной клик, параллельные вкладки)
  perform 1 from app.profiles where id = v.id for update;
  select * into b from app.bonuses where id = p_bonus and user_id = v.id for update;
  if not found then raise exception 'bonus_not_found'; end if;

  v_status := app.refresh_bonus(b.id);
  if v_status <> 'available' then raise exception 'bonus_%', v_status; end if;

  select title into v_service from app.services where id = p_service and active;
  if v_service is null then raise exception 'bad_service'; end if;
  if not b.all_services and not (p_service = any (b.service_ids)) then raise exception 'service_not_covered'; end if;
  if v.phone_norm is null then raise exception 'phone_required'; end if;

  if exists (select 1 from app.redemptions r join app.bonuses o on o.id = r.bonus_id
             where r.user_id = v.id and r.status = 'pending' and (not o.stackable or not b.stackable)) then
    raise exception 'not_stackable';
  end if;

  if b.kind = 'referral_invitee' then
    select * into v_ref from app.referrals where id = b.source_referral_id;
    if v_ref.status = 'cancelled' then raise exception 'bonus_cancelled'; end if;
    if exists (select 1 from app.profiles o where o.id = v_ref.referrer_id and o.phone_norm = v.phone_norm) then
      perform app.log_event('self_referral_suspected', 'alert', v.id, jsonb_build_object(
        'client_no', v.client_no, 'code', v_ref.code, 'reason', 'same_phone_on_request'), true);
      return jsonb_build_object('ok', false, 'error', 'own_code');
    end if;
  end if;

  if b.kind in ('welcome', 'referral_invitee') then
    select * into v_claim from app.bonus_claims
    where kind = b.kind and phone_norm = v.phone_norm and released_at is null;
    if found and v_claim.user_id <> v.id then
      perform app.log_event('duplicate_bonus_attempt', 'alert', v.id, jsonb_build_object(
        'client_no', v.client_no, 'kind', b.kind, 'phone', app.mask_phone(v.phone_norm),
        'other_client_no', (select client_no from app.profiles where id = v_claim.user_id)), true);
      return jsonb_build_object('ok', false, 'error', 'already_claimed');
    end if;
  end if;

  begin  -- подтранзакция: при гонке откатываем запрос, но запись в журнале сохраняем
    insert into app.redemptions (bonus_id, user_id, service_id, phone_norm)
    values (b.id, v.id, p_service, v.phone_norm) returning id into v_rid;
    if b.kind in ('welcome', 'referral_invitee') and v_claim.id is null then
      insert into app.bonus_claims (kind, phone_norm, user_id, redemption_id)
      values (b.kind, v.phone_norm, v.id, v_rid);
    end if;
  exception when unique_violation then
    perform app.log_event('duplicate_bonus_attempt', 'alert', v.id, jsonb_build_object(
      'client_no', v.client_no, 'kind', b.kind, 'phone', app.mask_phone(v.phone_norm), 'race', true), true);
    return jsonb_build_object('ok', false, 'error', 'already_claimed');
  end;

  perform app.refresh_bonus(b.id);

  perform app.log_event('bonus_requested', 'info', v.id, jsonb_build_object(
    'redemption_id', v_rid, 'client_no', v.client_no, 'name', v.display_name, 'phone', v.phone,
    'bonus', b.title, 'kind', b.kind, 'discount_type', b.discount_type, 'amount', b.amount,
    'service', v_service, 'invited_by', (select code from app.referrals where invitee_id = v.id)), true);

  return jsonb_build_object('ok', true, 'redemption_id', v_rid);
end $$;

create or replace function public.cancel_my_request(p_redemption uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v app.profiles;
begin
  v := app.require_user();
  if not exists (select 1 from app.redemptions where id = p_redemption and user_id = v.id and status = 'pending') then
    raise exception 'not_found';
  end if;
  return app.decide(p_redemption, 'cancel', v.id, null, 'Отменено клиентом');
end $$;

create or replace function public.delete_my_account() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v app.profiles;
begin
  v := app.require_user();
  update app.redemptions set status = 'cancelled', decided_at = now(), note = 'Аккаунт удалён'
  where user_id = v.id and status = 'pending';
  update app.bonuses set status = 'cancelled', cancel_reason = 'Аккаунт удалён', updated_at = now()
  where user_id = v.id and status in ('available', 'pending');
  -- право на подарок НЕ возвращается: записи в bonus_claims и referrals остаются
  update app.profiles set status = 'deleted', display_name = null, phone = null, email = null,
    status_reason = 'Удалён пользователем', updated_at = now() where id = v.id;
  delete from app.telegram_identities where user_id = v.id;
  update auth.users set banned_until = now() + interval '100 years' where id = v.id;
  perform app.log_event('user_deleted', 'warn', v.id, jsonb_build_object('client_no', v.client_no), true);
  return jsonb_build_object('ok', true);
end $$;

-- Публичная информация о программе (для главной страницы и окна регистрации)
create or replace function public.program_info() returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'referral_enabled', s.referral_enabled,
    'welcome', (select app.rule_json(r) - 'service_ids' - 'updated_at' from app.discount_rules r where r.kind = 'welcome' and r.enabled),
    'invitee', (select app.rule_json(r) - 'service_ids' - 'updated_at' from app.discount_rules r
                where r.kind = 'referral_invitee' and r.enabled and s.referral_enabled))
  from app.settings s
$$;

-- =====================================================================
-- API администратора на сайте (проверка прав внутри каждой функции)
-- =====================================================================

create or replace function public.admin_overview() returns jsonb
language plpgsql security definer set search_path = '' as $$
begin perform app.require_admin(); return app.overview(); end $$;

create or replace function public.admin_users(p_q text default '', p_limit int default 30, p_offset int default 0) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin perform app.require_admin(); return app.find_users(p_q, p_limit, p_offset); end $$;

create or replace function public.admin_user(p_user uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin perform app.require_admin(); return app.user_detail(p_user); end $$;

create or replace function public.admin_referrals(p_q text default '', p_limit int default 50, p_offset int default 0) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin perform app.require_admin(); return app.list_referrals(p_q, p_limit, p_offset); end $$;

create or replace function public.admin_redemptions(p_status text default 'pending', p_limit int default 50, p_offset int default 0) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin perform app.require_admin(); return app.list_redemptions(p_status, p_limit, p_offset); end $$;

create or replace function public.admin_events(p_type text default '', p_severity text default '', p_before bigint default null, p_limit int default 50) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin perform app.require_admin(); return app.list_events(p_type, p_severity, p_before, p_limit); end $$;

create or replace function public.admin_decide(p_redemption uuid, p_decision text, p_note text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_admin uuid;
begin v_admin := app.require_admin(); return app.decide(p_redemption, p_decision, v_admin, null, p_note); end $$;

create or replace function public.admin_cancel_bonus(p_bonus uuid, p_reason text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_admin uuid;
begin v_admin := app.require_admin(); return app.cancel_bonus(p_bonus, p_reason, v_admin, null); end $$;

create or replace function public.admin_set_user_status(p_user uuid, p_status text, p_reason text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_admin uuid;
begin v_admin := app.require_admin(); return app.set_user_status(p_user, p_status, p_reason, v_admin, null); end $$;

create or replace function public.admin_update_rule(p_kind text, p_rule jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_admin uuid;
begin v_admin := app.require_admin(); return app.update_rule(p_kind, p_rule, v_admin, null); end $$;

create or replace function public.admin_update_settings(p_settings jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_admin uuid;
begin v_admin := app.require_admin(); return app.update_settings(p_settings, v_admin, null); end $$;

create or replace function public.admin_update_service(p_id text, p_active boolean) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_admin uuid;
begin v_admin := app.require_admin(); return app.update_service(p_id, p_active, v_admin, null); end $$;

-- =====================================================================
-- API для серверных функций (только service_role)
-- =====================================================================

create or replace function public.svc_onboard(p_user uuid, p_method text, p_ref text, p_ip text, p_phone text) returns jsonb
language sql security definer set search_path = '' as $$ select app.onboard(p_user, p_method, p_ref, p_ip, p_phone) $$;

create or replace function public.svc_log(p_type text, p_severity text, p_user uuid, p_data jsonb, p_notify boolean, p_ip text default null)
returns bigint
language sql security definer set search_path = '' as $$
  select app.log_event(p_type, p_severity, p_user, p_data, p_notify, null, null, p_ip)
$$;

create or replace function public.svc_rate(p_key text, p_max int, p_window int) returns boolean
language sql security definer set search_path = '' as $$ select app.rl_hit(p_key, p_max, p_window) $$;

create or replace function public.svc_profile(p_user uuid) returns jsonb
language sql security definer set search_path = '' as $$
  select jsonb_build_object('id', p.id, 'client_no', p.client_no, 'name', p.display_name, 'status', p.status,
    'email', p.email, 'is_admin', app.is_admin(p.id),
    'telegram_id', (select telegram_id from app.telegram_identities where user_id = p.id))
  from app.profiles p where p.id = p_user
$$;

create or replace function public.svc_user_by_email(p_email text) returns jsonb
language sql security definer set search_path = '' as $$
  select jsonb_build_object('id', p.id, 'client_no', p.client_no, 'status', p.status,
    'telegram_id', (select telegram_id from app.telegram_identities where user_id = p.id))
  from app.profiles p where p.email = lower(btrim(p_email)) limit 1
$$;

create or replace function public.svc_set_email(p_user uuid, p_email text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  update app.profiles set email = lower(btrim(p_email)), updated_at = now() where id = p_user;
  perform app.log_event('email_added', 'info', p_user,
    jsonb_build_object('client_no', (select client_no from app.profiles where id = p_user)), null);
end $$;

create or replace function public.svc_check_code(p_code text) returns jsonb
language sql security definer set search_path = '' as $$
  select jsonb_build_object(
    'program', s.referral_enabled,
    'valid', s.referral_enabled and exists (
      select 1 from app.profiles where ref_code = upper(btrim(p_code)) and status = 'active'))
  from app.settings s
$$;

create or replace function public.svc_settings() returns jsonb
language sql security definer set search_path = '' as $$
  select jsonb_build_object('site_url', site_url, 'bot_username', bot_username,
    'referral_enabled', referral_enabled, 'diagnostics', diagnostics) from app.settings
$$;

create or replace function public.svc_set_bot_username(p_username text) returns void
language sql security definer set search_path = '' as $$
  update app.settings set bot_username = nullif(btrim(p_username), '') where id
$$;

-- Секреты (токен бота и т.п.) лежат в Supabase Vault в зашифрованном виде
create or replace function public.svc_secret(p_name text) returns text
language sql security definer set search_path = '' as $$
  select decrypted_secret from vault.decrypted_secrets where name = p_name limit 1
$$;

-- ---- Вход через Telegram ----

create or replace function public.svc_tg_login_start(p_mode text, p_link_user uuid, p_ref text, p_ip text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_nonce text := translate(encode(extensions.gen_random_bytes(18), 'base64'), '+/=', '-_');
  v_secret text := encode(extensions.gen_random_bytes(24), 'hex');
  v_code text := lpad((('x' || encode(extensions.gen_random_bytes(3), 'hex'))::bit(24)::int % 10000)::text, 4, '0');
  v_id uuid;
begin
  if p_mode not in ('login', 'link') then raise exception 'bad_mode'; end if;
  if p_mode = 'link' and p_link_user is null then raise exception 'not_authenticated'; end if;
  insert into app.tg_login_requests (nonce, poll_hash, code, mode, link_user_id, ref_code, ip_hash)
  values (v_nonce, encode(extensions.digest(v_secret, 'sha256'), 'hex'), v_code, p_mode, p_link_user,
          left(upper(nullif(btrim(coalesce(p_ref, '')), '')), 20), p_ip)
  returning id into v_id;
  return jsonb_build_object('id', v_id, 'nonce', v_nonce, 'poll_secret', v_secret, 'code', v_code);
end $$;

create or replace function public.svc_tg_login_peek(p_nonce text) returns jsonb
language sql security definer set search_path = '' as $$
  select jsonb_build_object('code', code, 'mode', mode, 'status', status, 'expired', expires_at < now())
  from app.tg_login_requests where nonce = p_nonce
$$;

create or replace function public.svc_tg_login_confirm(p_nonce text, p_tg bigint, p_username text, p_first text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v app.tg_login_requests;
begin
  update app.tg_login_requests set status = 'confirmed', tg_id = p_tg,
    tg_username = left(p_username, 64), tg_first_name = left(p_first, 64)
  where nonce = p_nonce and status = 'pending' and expires_at > now()
  returning * into v;
  if not found then return jsonb_build_object('ok', false); end if;
  return jsonb_build_object('ok', true, 'code', v.code, 'mode', v.mode);
end $$;

create or replace function public.svc_tg_login_reject(p_nonce text) returns void
language sql security definer set search_path = '' as $$
  update app.tg_login_requests set status = 'rejected' where nonce = p_nonce and status = 'pending'
$$;

-- Одноразовое получение результата: подтверждённый запрос можно забрать только один раз
create or replace function public.svc_tg_login_consume(p_id uuid, p_secret text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v app.tg_login_requests;
begin
  select * into v from app.tg_login_requests
  where id = p_id and poll_hash = encode(extensions.digest(coalesce(p_secret, ''), 'sha256'), 'hex')
  for update;
  if not found then return jsonb_build_object('status', 'not_found'); end if;
  if v.status = 'pending' and v.expires_at < now() then return jsonb_build_object('status', 'expired'); end if;
  if v.status <> 'confirmed' then return jsonb_build_object('status', v.status); end if;
  update app.tg_login_requests set status = 'consumed' where id = v.id;
  return jsonb_build_object('status', 'confirmed', 'mode', v.mode, 'link_user_id', v.link_user_id,
    'tg_id', v.tg_id, 'username', v.tg_username, 'first_name', v.tg_first_name, 'ref_code', v.ref_code, 'ip_hash', v.ip_hash);
end $$;

create or replace function public.svc_tg_user(p_tg bigint) returns uuid
language sql security definer set search_path = '' as $$
  select user_id from app.telegram_identities where telegram_id = p_tg
$$;

create or replace function public.svc_tg_link(p_user uuid, p_tg bigint, p_username text, p_first text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_owner uuid; v_existing bigint; v_client bigint;
begin
  select user_id into v_owner from app.telegram_identities where telegram_id = p_tg for update;
  if v_owner is not null and v_owner <> p_user then
    perform app.log_event('telegram_link_conflict', 'warn', p_user, jsonb_build_object(
      'tg_username', p_username, 'owner_no', (select client_no from app.profiles where id = v_owner)), true);
    return jsonb_build_object('ok', false, 'error', 'telegram_taken');
  end if;
  if v_owner = p_user then
    update app.telegram_identities set username = p_username, first_name = p_first where telegram_id = p_tg;
    return jsonb_build_object('ok', true, 'already', true);
  end if;
  select telegram_id into v_existing from app.telegram_identities where user_id = p_user;
  if v_existing is not null then return jsonb_build_object('ok', false, 'error', 'other_telegram_linked'); end if;
  insert into app.telegram_identities (telegram_id, user_id, username, first_name)
  values (p_tg, p_user, left(p_username, 64), left(p_first, 64));
  select client_no into v_client from app.profiles where id = p_user;
  perform app.log_event('telegram_linked', 'info', p_user, jsonb_build_object(
    'client_no', v_client, 'tg_username', p_username, 'admin', app.is_admin_tg(p_tg)), true);
  return jsonb_build_object('ok', true);
end $$;

-- ---- Очередь уведомлений в Telegram ----

create or replace function public.svc_claim_notifications(p_limit int) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v jsonb;
begin
  with picked as (
    select e.id from app.events e
    where e.notify and e.notified_at is null and e.notify_attempts < 8
      and e.created_at > now() - interval '2 days'
    order by e.id
    limit least(greatest(coalesce(p_limit, 20), 1), 50)
    for update skip locked
  ), upd as (
    update app.events e set notify_attempts = e.notify_attempts + 1
    from picked where e.id = picked.id
    returning e.*
  )
  select coalesce(jsonb_agg(jsonb_build_object('id', u.id, 'type', u.type, 'severity', u.severity,
      'data', u.data, 'created_at', u.created_at, 'actor_tg', u.actor_tg,
      'user', case when p.id is null then null else jsonb_build_object('client_no', p.client_no, 'name', p.display_name,
        'email', p.email, 'ref_code', p.ref_code) end) order by u.id), '[]'::jsonb)
  into v
  from upd u left join app.profiles p on p.id = u.user_id;
  return v;
end $$;

create or replace function public.svc_mark_notified(p_ids bigint[], p_ok boolean, p_error text) returns void
language sql security definer set search_path = '' as $$
  update app.events set
    notified_at = case when p_ok then now() else notified_at end,
    notify_error = case when p_ok then null else left(p_error, 300) end
  where id = any (p_ids)
$$;

create or replace function public.svc_admin_chats() returns bigint[]
language sql security definer set search_path = '' as $$
  select coalesce(array_agg(telegram_id order by telegram_id), '{}') from app.admin_telegram_ids
$$;

-- ---- Команды администратора в Telegram-боте ----

create or replace function public.svc_bot(p_tg bigint, p_cmd text, p_args jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_actor uuid;
begin
  if not app.is_admin_tg(p_tg) then raise exception 'forbidden'; end if;
  select user_id into v_actor from app.telegram_identities where telegram_id = p_tg;
  case p_cmd
    when 'stats'      then return app.overview() - 'rules' - 'services';
    when 'users'      then return app.find_users(p_args ->> 'q', 10, 0);
    when 'user'       then return app.user_detail(coalesce((p_args ->> 'id')::uuid,
                             (select id from app.profiles where client_no = (p_args ->> 'client_no')::bigint)));
    when 'codes'      then return app.top_referrers(10);
    when 'suspicious' then return app.list_events('', 'suspicious', null, 10);
    when 'pending'    then return app.list_redemptions('pending', 10, 0);
    when 'decide'     then return app.decide((p_args ->> 'id')::uuid, p_args ->> 'decision', v_actor, p_tg, 'через Telegram');
    when 'settings'   then return app.update_settings(p_args, v_actor, p_tg);
    when 'rules'      then return (select jsonb_object_agg(r.kind, app.rule_json(r)) from app.discount_rules r);
    else raise exception 'bad_command';
  end case;
end $$;

-- =====================================================================
-- Права на функции: по умолчанию в PostgreSQL их может вызвать кто угодно,
-- поэтому сначала забираем все права, затем выдаём нужным ролям.
-- =====================================================================

do $$
declare f record;
begin
  for f in
    select p.oid::regprocedure as sig, n.nspname, p.proname
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('app', 'public')
      and (n.nspname = 'app' or p.proname like 'svc\_%' or p.proname like 'admin\_%'
           or p.proname in ('my_dashboard', 'update_my_profile', 'apply_ref_code', 'request_bonus',
                            'cancel_my_request', 'delete_my_account', 'program_info'))
  loop
    execute format('revoke all on function %s from public, anon, authenticated', f.sig);
    if f.nspname = 'public' and f.proname like 'svc\_%' then
      execute format('grant execute on function %s to service_role', f.sig);
    elsif f.nspname = 'public' and f.proname = 'program_info' then
      execute format('grant execute on function %s to anon, authenticated, service_role', f.sig);
    elsif f.nspname = 'public' then
      execute format('grant execute on function %s to authenticated', f.sig);
    end if;
  end loop;
end $$;
