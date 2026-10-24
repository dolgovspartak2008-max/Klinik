-- =====================================================================
-- Роли администраторов и управление ими из Telegram-бота.
--
--   owner — владелец: может выдавать и снимать права администратора;
--   admin — администратор: бот и админ-панель сайта, но не управление админами.
--
-- Выдать/снять права можно командами бота /addadmin, /removeadmin (только владелец).
-- Владельца назначают только через базу. Последнего владельца снять нельзя.
-- =====================================================================

alter table app.admin_telegram_ids
  add column if not exists role text not null default 'admin' check (role in ('owner', 'admin')),
  add column if not exists added_by bigint;

update app.admin_telegram_ids set role = 'owner', note = coalesce(note, 'владелец') where telegram_id = 963921711;

create or replace function app.is_owner_tg(p_tg bigint) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from app.admin_telegram_ids where telegram_id = p_tg and role = 'owner')
$$;

-- Карточка человека по номеру клиента или Telegram ID
create or replace function app.admin_target(p_tg bigint) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'telegram_id', p_tg,
    'client_no', p.client_no,
    'name', p.display_name,
    'status', p.status,
    'username', t.username,
    'first_name', t.first_name,
    'role', a.role)
  from (select p_tg as tg) x
  left join app.telegram_identities t on t.telegram_id = x.tg
  left join app.profiles p on p.id = t.user_id
  left join app.admin_telegram_ids a on a.telegram_id = x.tg
$$;

create or replace function public.svc_admin_manage(p_tg bigint, p_action text, p_args jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_q text := btrim(coalesce(p_args ->> 'q', ''));
  v_n bigint;
  v_target bigint;
  v_profile app.profiles;
  v_role text;
  v_actor uuid;
  v_card jsonb;
begin
  if not app.is_admin_tg(p_tg) then raise exception 'forbidden'; end if;
  select user_id into v_actor from app.telegram_identities where telegram_id = p_tg;

  if p_action = 'list' then
    return coalesce((
      select jsonb_agg(app.admin_target(a.telegram_id) || jsonb_build_object('added_at', a.added_at, 'note', a.note)
                       order by (a.role = 'owner') desc, a.added_at)
      from app.admin_telegram_ids a), '[]'::jsonb);
  end if;

  -- всё остальное — только владелец
  if not app.is_owner_tg(p_tg) then raise exception 'owner_only'; end if;

  if p_action = 'resolve' then
    -- «1042» — номер клиента на сайте, длинное число — Telegram ID
    if v_q !~ '^[0-9]{1,15}$' then raise exception 'bad_target'; end if;
    v_n := v_q::bigint;
    select * into v_profile from app.profiles where client_no = v_n;
    if found then
      select telegram_id into v_target from app.telegram_identities where user_id = v_profile.id;
      if v_target is null then raise exception 'no_telegram'; end if;
      if v_profile.status <> 'active' then raise exception 'user_not_active'; end if;
    else
      if v_n < 10000 then raise exception 'not_found'; end if;
      v_target := v_n;
    end if;
    return app.admin_target(v_target);
  end if;

  v_target := (p_args ->> 'telegram_id')::bigint;
  if v_target is null then raise exception 'bad_target'; end if;

  if p_action = 'grant' then
    select role into v_role from app.admin_telegram_ids where telegram_id = v_target;
    if v_role is not null then raise exception 'already_admin'; end if;
    if exists (select 1 from app.profiles p join app.telegram_identities t on t.user_id = p.id
               where t.telegram_id = v_target and p.status <> 'active') then
      raise exception 'user_not_active';
    end if;
    insert into app.admin_telegram_ids (telegram_id, note, role, added_by)
    values (v_target, left(nullif(btrim(coalesce(p_args ->> 'note', '')), ''), 80), 'admin', p_tg);
    v_card := app.admin_target(v_target);
    perform app.log_event('admin_granted', 'warn',
      (select user_id from app.telegram_identities where telegram_id = v_target),
      v_card || jsonb_build_object('by_tg', p_tg), true, v_actor, p_tg);
    return v_card;
  end if;

  if p_action = 'revoke' then
    select role into v_role from app.admin_telegram_ids where telegram_id = v_target for update;
    if v_role is null then raise exception 'not_admin'; end if;
    if v_role = 'owner' and (select count(*) from app.admin_telegram_ids where role = 'owner') <= 1 then
      raise exception 'last_owner';
    end if;
    v_card := app.admin_target(v_target);
    delete from app.admin_telegram_ids where telegram_id = v_target;
    perform app.log_event('admin_revoked', 'warn',
      (select user_id from app.telegram_identities where telegram_id = v_target),
      v_card || jsonb_build_object('by_tg', p_tg), true, v_actor, p_tg);
    return v_card;
  end if;

  raise exception 'bad_command';
end $$;

revoke all on function app.is_owner_tg(bigint) from public, anon, authenticated;
revoke all on function app.admin_target(bigint) from public, anon, authenticated;
revoke all on function public.svc_admin_manage(bigint, text, jsonb) from public, anon, authenticated;
grant execute on function public.svc_admin_manage(bigint, text, jsonb) to service_role;
