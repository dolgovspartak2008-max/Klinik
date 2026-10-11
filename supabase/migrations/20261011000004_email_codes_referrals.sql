-- =====================================================================
-- 1) Промокод друга засчитывается всегда, даже когда программа выключена
--    (раньше код при регистрации молча отклонялся с ошибкой program_disabled).
--    Скидки по-прежнему выдаются только по включённым правилам.
-- 2) Подтверждение email кодом из письма: привязка email к аккаунту из Telegram.
-- 3) Служебные функции для серверной функции account.
-- =====================================================================

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
  -- Приглашение засчитывается всегда (даже когда программа выключена):
  -- скидки начисляются только по включённым правилам (см. app.issue_bonus).

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

  return jsonb_build_object('ok', true, 'bonus_issued', v_bonus is not null,
    'program', (select referral_enabled from app.settings));
end $$;

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

-- Проверка промокода не зависит от того, включена ли программа (приглашение засчитывается всегда)
create or replace function public.svc_check_code(p_code text) returns jsonb
language sql security definer set search_path = '' as $$
  select jsonb_build_object(
    'program', s.referral_enabled,
    'valid', exists (select 1 from app.profiles where ref_code = upper(btrim(p_code)) and status = 'active'))
  from app.settings s
$$;

-- Промокод при входе через Telegram в уже существующий аккаунт:
-- применяем, только если приглашения ещё нет и не было подтверждённых услуг (без шумных предупреждений).
create or replace function public.svc_attach_referral(p_user uuid, p_code text, p_ip text) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  perform 1 from app.profiles where id = p_user for update;
  if exists (select 1 from app.referrals where invitee_id = p_user) then
    return jsonb_build_object('ok', false, 'error', 'already_referred');
  end if;
  if exists (select 1 from app.redemptions where user_id = p_user and status = 'confirmed') then
    return jsonb_build_object('ok', false, 'error', 'not_first_visit');
  end if;
  return app.attach_referral(p_user, p_code, p_ip, 'later');
end $$;

-- Пользователь Supabase Auth по email (в том числе ещё не подтвердивший адрес)
create or replace function public.svc_auth_user(p_email text) returns jsonb
language sql security definer set search_path = '' as $$
  select jsonb_build_object('id', u.id, 'confirmed', u.email_confirmed_at is not null,
    'status', p.status, 'onboarded', p.onboarded_at is not null, 'client_no', p.client_no,
    'telegram_id', (select telegram_id from app.telegram_identities where user_id = u.id))
  from auth.users u left join app.profiles p on p.id = u.id
  where lower(u.email) = lower(btrim(p_email)) limit 1
$$;

-- Привязка email к аккаунту, созданному через Telegram: код из письма
create table if not exists app.email_changes (
  user_id    uuid primary key references app.profiles (id) on delete cascade,
  email      text not null,
  code_hash  text not null,
  attempts   int not null default 0,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '15 minutes'
);
alter table app.email_changes enable row level security;
revoke all on app.email_changes from public, anon, authenticated;

create or replace function public.svc_email_change_start(p_user uuid, p_email text, p_code_hash text) returns void
language sql security definer set search_path = '' as $$
  insert into app.email_changes (user_id, email, code_hash)
  values (p_user, lower(btrim(p_email)), p_code_hash)
  on conflict (user_id) do update set email = excluded.email, code_hash = excluded.code_hash,
    attempts = 0, created_at = now(), expires_at = now() + interval '15 minutes'
$$;

-- Не больше 5 попыток на один код; после успеха код гасится (одна строка на пользователя — таблица не растёт)
create or replace function public.svc_email_change_check(p_user uuid, p_code_hash text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v app.email_changes;
begin
  select * into v from app.email_changes where user_id = p_user for update;
  if not found or v.expires_at < now() or v.attempts >= 5 then
    return jsonb_build_object('ok', false, 'error', 'code_expired');
  end if;
  if v.code_hash <> p_code_hash then
    update app.email_changes set attempts = attempts + 1 where user_id = p_user;
    return jsonb_build_object('ok', false, 'error', case when v.attempts + 1 >= 5 then 'code_expired' else 'bad_code' end);
  end if;
  -- код одноразовый: гасим его
  update app.email_changes set expires_at = now() - interval '1 second', attempts = 99 where user_id = p_user;
  return jsonb_build_object('ok', true, 'email', v.email);
end $$;

revoke all on function public.svc_attach_referral(uuid, text, text) from public, anon, authenticated;
revoke all on function public.svc_auth_user(text) from public, anon, authenticated;
revoke all on function public.svc_email_change_start(uuid, text, text) from public, anon, authenticated;
revoke all on function public.svc_email_change_check(uuid, text) from public, anon, authenticated;
grant execute on function public.svc_attach_referral(uuid, text, text) to service_role;
grant execute on function public.svc_auth_user(text) to service_role;
grant execute on function public.svc_email_change_start(uuid, text, text) to service_role;
grant execute on function public.svc_email_change_check(uuid, text) to service_role;
