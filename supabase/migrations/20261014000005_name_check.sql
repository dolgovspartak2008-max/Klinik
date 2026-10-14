-- Имя клиента: обязательное, проверяется на «каракули», подтверждается самим клиентом
-- (в том числе после входа через Telegram, где имя приходит из профиля Telegram).

-- Мягкая проверка имени. Те же правила — в assets/js/sb.js (FZName), держать в согласии.
--  * 2–60 символов, буквы одного алфавита (кириллица или латиница), слова через пробел/дефис/апостроф, не больше 4 слов;
--  * в каждом слове есть гласная; нет 6+ согласных подряд и 3 одинаковых букв подряд;
--  * нет 4 подряд клавиш с одного ряда клавиатуры («фыва», «qwer»), служебных слов («тест», «admin»).
create or replace function app.name_ok(p text) returns boolean
language plpgsql immutable set search_path = '' as $$
declare
  v text := lower(btrim(regexp_replace(coalesce(p, ''), '\s+', ' ', 'g')));
  w text;
  r text;
  i int;
  rows text[] := array['йцукенгшщзхъ', 'фывапролджэ', 'ячсмитьбю', 'qwertyuiop', 'asdfghjkl', 'zxcvbnm'];
begin
  if char_length(v) < 2 or char_length(v) > 60 then return false; end if;
  if v !~ '^[a-zа-яё]+([ ''-][a-zа-яё]+){0,3}$' then return false; end if;
  if v ~ '[a-z]' and v ~ '[а-яё]' then return false; end if;
  if v ~ '(.)\1\1' then return false; end if;
  if v ~ '[бвгджзйклмнпрстфхцчшщъь]{6}' or v ~ '[bcdfghjklmnpqrstvwxz]{6}' then return false; end if;
  foreach w in array regexp_split_to_array(v, '[ ''-]') loop
    if w !~ '[аеёиоуыэюяaeiouy]' then return false; end if;
    if char_length(w) > 20 or w ~ '^[ъьы]' then return false; end if;
  end loop;
  foreach r in array rows loop
    for i in 1 .. char_length(r) - 3 loop
      if position(substr(r, i, 4) in v) > 0 or position(reverse(substr(r, i, 4)) in v) > 0 then return false; end if;
    end loop;
  end loop;
  if v in ('тест', 'test', 'admin', 'админ', 'user', 'имя', 'name', 'нет', 'хз', 'аноним', 'anonymous', 'qwerty', 'asdf')
  then return false; end if;
  return true;
end $$;

alter table app.profiles add column if not exists name_confirmed_at timestamptz;

-- Кто регистрировался по email, имя уже вводил сам; остальные подтвердят его при входе в кабинет.
update app.profiles set name_confirmed_at = created_at
  where name_confirmed_at is null and signup_method = 'email' and app.name_ok(display_name);

-- Новый пользователь: имя из формы регистрации по email считаем подтверждённым, имя из Telegram — нет
create or replace function app.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_email text;
  v_tg boolean := new.email like '%@tg.fiziotera.online';
  v_name text := left(nullif(btrim(new.raw_user_meta_data ->> 'full_name'), ''), 60);
begin
  v_email := case when v_tg then null else lower(new.email) end;
  loop
    begin
      insert into app.profiles (id, display_name, email, ref_code, name_confirmed_at)
      values (new.id, v_name, v_email, app.gen_ref_code(),
              case when not v_tg and app.name_ok(v_name) then now() end);
      exit;
    exception when unique_violation then
      if exists (select 1 from app.profiles where id = new.id) then exit; end if;
      -- совпал промокод (крайне редко) — генерируем заново
    end;
  end loop;
  return new;
end $$;

-- Профиль: имя теперь обязательно и проверяется
create or replace function public.update_my_profile(p_name text, p_phone text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v app.profiles;
  v_name text := left(regexp_replace(btrim(coalesce(p_name, '')), '\s+', ' ', 'g'), 60);
  v_phone text := app.norm_phone(p_phone);
begin
  v := app.require_user();
  if not app.rl_hit('profile:' || v.id, 20, 3600) then raise exception 'rate_limited'; end if;
  if not app.name_ok(v_name) then raise exception 'bad_name'; end if;
  if nullif(btrim(coalesce(p_phone, '')), '') is not null and v_phone is null then raise exception 'bad_phone'; end if;
  if v_phone is distinct from v.phone_norm and exists (
      select 1 from app.redemptions r where r.user_id = v.id and r.status in ('pending', 'confirmed')) then
    raise exception 'phone_locked';
  end if;

  update app.profiles set display_name = v_name,
    name_confirmed_at = coalesce(name_confirmed_at, now()),
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

-- Кабинет: + name_confirmed (кабинет попросит ввести имя, пока оно не подтверждено)
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
