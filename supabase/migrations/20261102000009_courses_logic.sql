-- =====================================================================
-- Онлайн-курсы: серверная логика.
--   app.*            — внутренние функции (недоступны из API)
--   public.*         — API сайта (каждая функция сама проверяет пользователя)
--   public.admin_*   — API админ-панели (app.require_admin внутри)
--   public.svc_*     — только для серверных функций (service_role)
-- Ошибки — коды в тексте исключения, сайт переводит их (assets/js/sb.js).
-- =====================================================================

-- ---------------------------------------------------------------------
-- Вспомогательные
-- ---------------------------------------------------------------------

create or replace function app.txt(p jsonb, k text, maxlen int) returns text
language sql immutable set search_path = '' as $$
  select left(btrim(coalesce(p ->> k, '')), maxlen)
$$;

create or replace function app.money(p numeric) returns text
language sql immutable set search_path = '' as $$
  select case when p is null then '—'
    else replace(to_char(p, 'FM999G999G990'), ',', ' ') || ' ₽' end
$$;

-- Действующий доступ к курсу
create or replace function app.course_has_access(p_user uuid, p_course uuid) returns boolean
language sql stable set search_path = '' as $$
  select exists (
    select 1 from app.course_access a
    join app.profiles p on p.id = a.user_id
    where a.user_id = p_user and a.course_id = p_course and a.revoked_at is null
      and (a.expires_at is null or a.expires_at > now())
      and p.status = 'active' and not p.courses_blocked)
$$;

-- Видимые уроки курса: не скрыты и с видео
create or replace function app.course_stats(p_course uuid) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'lessons', count(*),
    'duration_sec', coalesce(sum(l.duration_sec), 0),
    'has_free', coalesce(bool_or(l.is_free), false))
  from app.lessons l where l.course_id = p_course and not l.hidden and l.video_path is not null
$$;

-- Прогресс пользователя по курсу
create or replace function app.course_progress(p_user uuid, p_course uuid) returns jsonb
language sql stable set search_path = '' as $$
  with ls as (
    select l.id, l.sort, l.title from app.lessons l
    where l.course_id = p_course and not l.hidden and l.video_path is not null
  ), pr as (
    select p.* from app.lesson_progress p join ls on ls.id = p.lesson_id where p.user_id = p_user
  )
  select jsonb_build_object(
    'total', (select count(*) from ls),
    'completed', (select count(*) from pr where completed_at is not null),
    'percent', case when (select count(*) from ls) = 0 then 0
                    else round(100.0 * (select count(*) from pr where completed_at is not null) / (select count(*) from ls)) end,
    'last_lesson_id', (select lesson_id from pr order by updated_at desc limit 1),
    'last_activity', (select max(updated_at) from pr))
$$;

create or replace function app.course_card(c app.courses, p_user uuid) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'id', c.id, 'slug', c.slug, 'title', c.title, 'short', c.short, 'direction', c.direction,
    'cover_url', c.cover_url, 'price', c.price, 'old_price', c.old_price, 'access_days', c.access_days,
    'category', (select jsonb_build_object('id', k.id, 'slug', k.slug, 'title', k.title) from app.course_categories k where k.id = c.category_id),
    'stats', app.course_stats(c.id),
    'owned', p_user is not null and app.course_has_access(p_user, c.id),
    'status', c.status)
$$;

create or replace function app.bundle_card(b app.bundles, p_user uuid) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'id', b.id, 'slug', b.slug, 'title', b.title, 'description', b.description, 'cover_url', b.cover_url,
    'price', b.price, 'old_price', b.old_price, 'overlap_mode', b.overlap_mode, 'status', b.status,
    'courses_price', (select sum(c.price) from app.bundle_courses bc join app.courses c on c.id = bc.course_id where bc.bundle_id = b.id),
    'courses', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'slug', c.slug, 'title', c.title, 'price', c.price,
        'owned', p_user is not null and app.course_has_access(p_user, c.id), 'stats', app.course_stats(c.id)) order by c.sort, c.title)
      from app.bundle_courses bc join app.courses c on c.id = bc.course_id where bc.bundle_id = b.id), '[]'::jsonb))
$$;

-- Подпись для водяного знака: номер клиента и частично скрытый email/телефон
create or replace function app.watermark(p_user uuid) returns text
language sql stable set search_path = '' as $$
  select '№ ' || p.client_no || ' · ' || coalesce(
    case when p.email is not null then
      left(split_part(p.email, '@', 1), 2) || '•••@' || split_part(p.email, '@', 2) end,
    app.mask_phone(p.phone_norm),
    coalesce(app.mask_name(p.display_name), 'клиент'))
  from app.profiles p where p.id = p_user
$$;

-- Сообщение клиенту в Telegram (если привязан) и на email (если указан).
-- p_key защищает от дублей: повторный вызов с тем же ключом ничего не отправит.
create or replace function app.notify_user(
  p_user uuid, p_key text, p_text text, p_button_text text default null, p_button_url text default null,
  p_mail_subject text default null
) returns void
language plpgsql set search_path = '' as $$
declare v_tg bigint; v_email text; v_site text;
begin
  select telegram_id into v_tg from app.telegram_identities where user_id = p_user;
  select email into v_email from app.profiles where id = p_user and status = 'active';
  select site_url into v_site from app.settings;
  if v_tg is not null then
    insert into app.tg_outbox (telegram_id, user_id, kind, text, button_text, button_url, dedupe_key)
    values (v_tg, p_user, 'personal', p_text, p_button_text,
            case when p_button_url like '/%' then v_site || p_button_url else p_button_url end, 'tg:' || p_key)
    on conflict do nothing;
  end if;
  if v_email is not null and p_mail_subject is not null then
    insert into app.mail_outbox (to_email, subject, body, dedupe_key)
    values (v_email, p_mail_subject,
            p_text || case when p_button_url is not null then E'\n\n' ||
              case when p_button_url like '/%' then v_site || p_button_url else p_button_url end else '' end
              || E'\n\n—\nКлиника «Физиотера», ' || v_site,
            'mail:' || p_key)
    on conflict do nothing;
  end if;
end $$;

create or replace function app.call_fn(p_fn text, p_task text) returns void
language plpgsql security definer set search_path = '' as $$
declare v_url text; v_secret text;
begin
  select decrypted_secret into v_url from vault.decrypted_secrets where name = 'functions_url';
  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'internal_secret';
  if v_url is null or v_secret is null then return; end if;
  perform net.http_post(
    url := v_url || '/' || p_fn || '?task=' || p_task,
    body := '{}'::jsonb,
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-internal-secret', v_secret),
    timeout_milliseconds := 15000);
exception when others then null;
end $$;

-- ---------------------------------------------------------------------
-- Расчёт цены (единственное место, где считается сумма к оплате)
-- ---------------------------------------------------------------------

create or replace function app.price_quote(p_user uuid, p_type text, p_id uuid, p_promo text, p_gift boolean)
returns jsonb
language plpgsql stable set search_path = '' as $$
declare
  c app.courses; b app.bundles; pr app.course_promos;
  v_title text; v_base numeric; v_list numeric; v_disc numeric := 0;
  v_courses uuid[]; v_owned uuid[] := '{}'; v_owned_titles text[] := '{}';
  v_note text; v_code text := upper(btrim(coalesce(p_promo, '')));
  v_used int; v_user_used int; v_all numeric; v_rest numeric;
begin
  p_gift := coalesce(p_gift, false);
  if p_type = 'course' then
    select * into c from app.courses where id = p_id and status = 'published';
    if not found then raise exception 'course_unavailable'; end if;
    v_title := c.title; v_base := c.price; v_list := c.price; v_courses := array[c.id];
    if not p_gift and app.course_has_access(p_user, c.id) then raise exception 'already_owned'; end if;
  elsif p_type = 'bundle' then
    select * into b from app.bundles where id = p_id and status = 'published';
    if not found then raise exception 'course_unavailable'; end if;
    select array_agg(bc.course_id) into v_courses from app.bundle_courses bc where bc.bundle_id = b.id;
    if v_courses is null then raise exception 'course_unavailable'; end if;
    v_title := 'Комплект «' || b.title || '»'; v_base := b.price; v_list := b.price;
    if not p_gift then
      select coalesce(array_agg(x.id), '{}'), coalesce(array_agg(x.title), '{}') into v_owned, v_owned_titles
      from app.courses x where x.id = any (v_courses) and app.course_has_access(p_user, x.id);
      if cardinality(v_owned) = cardinality(v_courses) then raise exception 'already_owned'; end if;
      if cardinality(v_owned) > 0 then
        if b.overlap_mode = 'block' then raise exception 'bundle_overlap'; end if;
        if b.overlap_mode = 'prorate' then
          select sum(coalesce(x.price, 0)) into v_all from app.courses x where x.id = any (v_courses);
          select sum(coalesce(x.price, 0)) into v_rest from app.courses x where x.id = any (v_courses) and not (x.id = any (v_owned));
          if coalesce(v_all, 0) > 0 then
            v_base := round(b.price * v_rest / v_all, -1);
          end if;
          v_note := 'Цена уменьшена: у вас уже есть ' || array_to_string(v_owned_titles, ', ');
        else
          v_note := 'У вас уже есть ' || array_to_string(v_owned_titles, ', ') || ' — комплект продаётся по полной цене';
        end if;
      end if;
    end if;
  else
    raise exception 'bad_item';
  end if;

  if v_code <> '' then
    select * into pr from app.course_promos where code = v_code;
    if not found or not pr.active then raise exception 'promo_invalid'; end if;
    if pr.valid_from is not null and pr.valid_from > now() then raise exception 'promo_not_started'; end if;
    if pr.valid_until is not null and pr.valid_until < now() then raise exception 'promo_expired'; end if;
    if not pr.applies_all and not ((p_type = 'course' and p_id = any (pr.course_ids))
                                   or (p_type = 'bundle' and p_id = any (pr.bundle_ids))) then
      raise exception 'promo_not_applicable';
    end if;
    select count(*) into v_used from app.course_orders o where o.promo_id = pr.id and o.status in ('pending', 'paid')
      and o.user_id <> p_user;
    select count(*) into v_user_used from app.course_orders o where o.promo_id = pr.id and o.status = 'paid' and o.user_id = p_user;
    if pr.max_uses is not null and v_used + v_user_used >= pr.max_uses then raise exception 'promo_exhausted'; end if;
    if v_user_used >= pr.per_user then raise exception 'promo_used'; end if;
    v_disc := case when pr.discount_type = 'percent' then round(v_base * pr.amount / 100, 0) else least(pr.amount, v_base) end;
  end if;

  return jsonb_build_object(
    'item_type', p_type, 'item_id', p_id, 'title', v_title, 'is_gift', p_gift,
    'list_price', v_list, 'base_price', v_base, 'discount', v_disc, 'total', v_base - v_disc,
    'promo_id', pr.id, 'promo_code', case when pr.id is not null then pr.code end,
    'course_ids', to_jsonb(v_courses), 'owned_ids', to_jsonb(v_owned), 'note', v_note,
    'courses', (select jsonb_agg(jsonb_build_object('id', x.id, 'title', x.title, 'owned', x.id = any (v_owned)) order by x.sort)
                from app.courses x where x.id = any (v_courses)));
end $$;

-- ---------------------------------------------------------------------
-- Выдача и отзыв доступа
-- ---------------------------------------------------------------------

create or replace function app.grant_access(p_user uuid, p_course uuid, p_source text, p_order uuid, p_gift uuid,
  p_by uuid, p_note text, p_days int) returns boolean
language plpgsql set search_path = '' as $$
declare v_days int; v_id uuid;
begin
  v_days := coalesce(p_days, (select access_days from app.courses where id = p_course));
  insert into app.course_access (user_id, course_id, source, order_id, gift_id, granted_by, grant_note, expires_at)
  values (p_user, p_course, p_source, p_order, p_gift, p_by, left(p_note, 300),
          case when v_days is not null then now() + make_interval(days => v_days) end)
  on conflict (user_id, course_id) where revoked_at is null do nothing
  returning id into v_id;
  return v_id is not null;
end $$;

create or replace function app.revoke_access_row(p_access uuid, p_reason text, p_by uuid) returns void
language plpgsql set search_path = '' as $$
declare v app.course_access;
begin
  update app.course_access set revoked_at = now(), revoked_by = p_by, revoke_reason = left(p_reason, 500)
  where id = p_access and revoked_at is null returning * into v;
  if not found then return; end if;
  -- текущий просмотр прерывается
  update app.playback_sessions set ended_at = now(), end_reason = 'revoked'
  where user_id = v.user_id and ended_at is null;
end $$;

create or replace function app.gen_gift_code() returns text
language plpgsql volatile set search_path = '' as $$
declare alphabet constant text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; v text; b bytea; i int;
begin
  loop
    b := extensions.gen_random_bytes(8); v := 'FZG-';
    for i in 0..7 loop
      v := v || substr(alphabet, (get_byte(b, i) % 31) + 1, 1);
      if i = 3 then v := v || '-'; end if;
    end loop;
    exit when not exists (select 1 from app.course_gifts where code = v);
  end loop;
  return v;
end $$;

-- ---------------------------------------------------------------------
-- Оплата заказа. ЕДИНСТВЕННАЯ точка выдачи доступа после оплаты.
-- Идемпотентна: повторный вызов (повтор вебхука, двойной клик) ничего не удвоит.
-- ---------------------------------------------------------------------

create or replace function app.order_mark_paid(
  p_order uuid, p_provider text, p_payment_id text, p_amount numeric, p_method text, p_note text,
  p_actor uuid, p_actor_tg bigint
) returns jsonb
language plpgsql set search_path = '' as $$
declare
  o app.course_orders; v_course uuid; v_gift text; v_gift_id uuid; v_granted int := 0; v_slug text;
begin
  select * into o from app.course_orders where id = p_order for update;
  if not found then raise exception 'not_found'; end if;
  if o.status = 'paid' then
    return jsonb_build_object('ok', true, 'already', true, 'order_no', o.order_no);
  end if;
  if o.status not in ('pending', 'expired') then raise exception 'order_not_payable'; end if;
  if p_amount is not null and p_amount <> o.total then
    perform app.log_event('payment_amount_mismatch', 'alert', o.user_id, jsonb_build_object(
      'order_no', o.order_no, 'expected', o.total, 'got', p_amount, 'provider', p_provider), true, p_actor, p_actor_tg);
    return jsonb_build_object('ok', false, 'error', 'amount_mismatch');
  end if;

  insert into app.course_payments (order_id, provider, provider_payment_id, amount, method, note, created_by, created_by_tg)
  values (o.id, p_provider, p_payment_id, o.total, left(p_method, 100), left(p_note, 500), p_actor, p_actor_tg);

  update app.course_orders set status = 'paid', provider = p_provider, provider_payment_id = p_payment_id,
    paid_at = now(), paid_amount = o.total, updated_at = now()
  where id = o.id;

  if o.is_gift then
    v_gift := app.gen_gift_code();
    insert into app.course_gifts (code, order_id, buyer_id, title, course_ids)
    values (v_gift, o.id, o.user_id, o.title, o.course_ids) returning id into v_gift_id;
    perform app.notify_user(o.user_id, 'order_paid:' || o.id,
      'Оплата заказа № ' || o.order_no || ' получена. Спасибо!' || E'\n\n' ||
      'Подарочный код на «' || o.title || '»: ' || v_gift || E'\n\n' ||
      'Передайте код получателю. Он войдёт на сайт и введёт код в личном кабинете (раздел «Мои курсы» → «Активировать подарок»). Код действует один раз.',
      'Мои курсы', '/kabinet/#courses', 'Подарочный код — заказ № ' || o.order_no);
  else
    foreach v_course in array o.course_ids loop
      if app.grant_access(o.user_id, v_course, case when o.item_type = 'bundle' then 'bundle'
                          when o.provider = 'free' or p_provider = 'free' then 'promo' else 'purchase' end,
                          o.id, null, p_actor, null, null) then
        v_granted := v_granted + 1;
      end if;
    end loop;
    select slug into v_slug from app.courses where id = o.course_ids[1];
    perform app.notify_user(o.user_id, 'order_paid:' || o.id,
      'Оплата заказа № ' || o.order_no || ' получена — доступ к «' || o.title || '» открыт.' || E'\n\n' ||
      'Курс уже в разделе «Мои курсы» на сайте. Перед занятиями прочитайте противопоказания на странице курса.',
      'Перейти к обучению', case when o.item_type = 'course' then '/kursy/' || v_slug || '/' else '/kabinet/#courses' end,
      'Доступ к курсу открыт — заказ № ' || o.order_no);
  end if;

  perform app.log_event('course_order_paid', 'info', o.user_id, jsonb_build_object(
    'order_no', o.order_no, 'title', o.title, 'total', o.total, 'provider', p_provider, 'method', p_method,
    'gift', o.is_gift, 'granted', v_granted, 'promo', o.promo_code), true, p_actor, p_actor_tg);
  return jsonb_build_object('ok', true, 'order_no', o.order_no, 'gift_code', v_gift, 'granted', v_granted);
end $$;

-- ---------------------------------------------------------------------
-- Кабинет и каталог (public)
-- ---------------------------------------------------------------------

create or replace function public.courses_catalog() returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'categories', coalesce((select jsonb_agg(jsonb_build_object('id', k.id, 'slug', k.slug, 'title', k.title,
        'description', k.description) order by k.sort, k.title)
      from app.course_categories k where not k.hidden
        and exists (select 1 from app.courses c where c.category_id = k.id and c.status = 'published')), '[]'::jsonb),
    'courses', coalesce((select jsonb_agg(app.course_card(c, auth.uid()) order by c.sort, c.title)
      from app.courses c join app.course_categories k on k.id = c.category_id
      where c.status = 'published' and not k.hidden), '[]'::jsonb),
    'bundles', coalesce((select jsonb_agg(app.bundle_card(b, auth.uid()) order by b.sort, b.title)
      from app.bundles b where b.status = 'published'), '[]'::jsonb),
    'signed_in', auth.uid() is not null)
$$;

create or replace function public.course_detail(p_slug text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare c app.courses; v_uid uuid := auth.uid(); v_owned boolean;
begin
  select * into c from app.courses where slug = lower(btrim(coalesce(p_slug, '')));
  -- снятый с продажи курс видят только те, у кого есть доступ
  if not found or (c.status <> 'published' and not (v_uid is not null and app.course_has_access(v_uid, c.id))) then
    raise exception 'not_found';
  end if;
  v_owned := v_uid is not null and app.course_has_access(v_uid, c.id);
  return app.course_card(c, v_uid) || jsonb_build_object(
    'for_whom', c.for_whom, 'tasks', c.tasks, 'program', c.program, 'results', c.results,
    'recommendations', c.recommendations, 'author', c.author, 'contraindications', c.contraindications,
    'access_terms', c.access_terms, 'on_sale', c.status = 'published',
    'lessons', coalesce((select jsonb_agg(jsonb_build_object('id', l.id, 'title', l.title, 'duration_sec', l.duration_sec,
        'is_free', l.is_free, 'description', l.description,
        'completed', v_uid is not null and exists (select 1 from app.lesson_progress p where p.user_id = v_uid and p.lesson_id = l.id and p.completed_at is not null))
        order by l.sort, l.created_at)
      from app.lessons l where l.course_id = c.id and not l.hidden and l.video_path is not null), '[]'::jsonb),
    'progress', case when v_owned then app.course_progress(v_uid, c.id) end,
    'bundles', coalesce((select jsonb_agg(jsonb_build_object('id', b.id, 'slug', b.slug, 'title', b.title, 'price', b.price, 'old_price', b.old_price))
      from app.bundles b join app.bundle_courses bc on bc.bundle_id = b.id where bc.course_id = c.id and b.status = 'published'), '[]'::jsonb),
    'signed_in', v_uid is not null);
end $$;

create or replace function public.course_quote(p_item_type text, p_item_id uuid, p_promo text default null, p_gift boolean default false)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v app.profiles;
begin
  v := app.require_user();
  if v.courses_blocked then raise exception 'courses_blocked'; end if;
  if not app.rl_hit('cquote:' || v.id, 60, 600) then raise exception 'rate_limited'; end if;
  return app.price_quote(v.id, p_item_type, p_item_id, p_promo, p_gift);
end $$;

create or replace function public.course_order_create(p_item_type text, p_item_id uuid, p_promo text, p_gift boolean, p_key text)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v app.profiles; q jsonb; o app.course_orders; v_key text := left(btrim(coalesce(p_key, '')), 64);
begin
  v := app.require_user();
  if v.courses_blocked then raise exception 'courses_blocked'; end if;
  if v_key !~ '^[A-Za-z0-9_-]{8,64}$' then raise exception 'bad_request'; end if;

  -- повтор того же запроса (двойной клик, повторная отправка) — тот же заказ
  select * into o from app.course_orders where user_id = v.id and idempotency_key = v_key;
  if found then return jsonb_build_object('ok', true, 'order', public.course_order_json(o)); end if;

  if not app.rl_hit('corder:' || v.id, 10, 3600) then raise exception 'rate_limited'; end if;
  q := app.price_quote(v.id, p_item_type, p_item_id, p_promo, p_gift);

  -- открытый заказ на тот же товар заменяется новым (могли поменять промокод)
  update app.course_orders set status = 'cancelled', cancel_reason = 'Заменён новым заказом', updated_at = now()
  where user_id = v.id and status = 'pending' and item_type = p_item_type
    and coalesce(course_id, bundle_id) = p_item_id and is_gift = coalesce(p_gift, false);

  insert into app.course_orders (user_id, item_type, course_id, bundle_id, is_gift, title, course_ids,
    base_price, discount, total, promo_id, promo_code, quote_note, idempotency_key)
  values (v.id, p_item_type,
    case when p_item_type = 'course' then p_item_id end, case when p_item_type = 'bundle' then p_item_id end,
    coalesce(p_gift, false), q ->> 'title',
    array(select jsonb_array_elements_text(q -> 'course_ids')::uuid),
    (q ->> 'base_price')::numeric, (q ->> 'discount')::numeric, (q ->> 'total')::numeric,
    nullif(q ->> 'promo_id', '')::uuid, q ->> 'promo_code', q ->> 'note', v_key)
  returning * into o;

  if o.total = 0 then
    -- 100% промокод: оплата не нужна, доступ выдаётся сразу (тем же путём, что и после оплаты)
    perform app.order_mark_paid(o.id, 'free', null, 0, 'промокод 100%', null, null, null);
    select * into o from app.course_orders where id = o.id;
  else
    perform app.log_event('course_order_created', 'info', v.id, jsonb_build_object(
      'order_no', o.order_no, 'order_id', o.id, 'title', o.title, 'total', o.total, 'base', o.base_price,
      'discount', o.discount, 'promo', o.promo_code, 'gift', o.is_gift, 'phone', v.phone, 'email', v.email,
      'telegram', (select username from app.telegram_identities where user_id = v.id)), true);
  end if;
  return jsonb_build_object('ok', true, 'order', public.course_order_json(o));
end $$;

create or replace function public.course_order_json(o app.course_orders) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('id', o.id, 'order_no', o.order_no, 'title', o.title, 'item_type', o.item_type,
    'is_gift', o.is_gift, 'base_price', o.base_price, 'discount', o.discount, 'total', o.total,
    'promo_code', o.promo_code, 'note', o.quote_note, 'status', o.status, 'provider', o.provider,
    'created_at', o.created_at, 'paid_at', o.paid_at, 'expires_at', o.expires_at,
    'course_slug', (select slug from app.courses where id = o.course_id),
    'gift', (select jsonb_build_object('code', g.code, 'status', g.status, 'activated_at', g.activated_at)
             from app.course_gifts g where g.order_id = o.id),
    'refunded', (select coalesce(sum(r.amount), 0) from app.course_refunds r where r.order_id = o.id))
$$;

create or replace function public.course_order_cancel(p_order uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v app.profiles; o app.course_orders;
begin
  v := app.require_user();
  update app.course_orders set status = 'cancelled', cancel_reason = 'Отменён клиентом', updated_at = now()
  where id = p_order and user_id = v.id and status = 'pending' returning * into o;
  if not found then raise exception 'not_pending'; end if;
  perform app.log_event('course_order_cancelled', 'info', v.id, jsonb_build_object('order_no', o.order_no, 'by', 'client'), null);
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.my_courses() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v app.profiles;
begin
  v := app.require_user();
  return jsonb_build_object(
    'blocked', v.courses_blocked,
    'course_news', v.course_news,
    'courses', coalesce((select jsonb_agg(app.course_card(c, v.id) || jsonb_build_object(
        'granted_at', a.granted_at, 'source', a.source, 'expires_at', a.expires_at,
        'progress', app.course_progress(v.id, c.id),
        'last_lesson_title', (select l.title from app.lesson_progress p join app.lessons l on l.id = p.lesson_id
           where p.user_id = v.id and p.course_id = c.id order by p.updated_at desc limit 1))
        order by coalesce((select max(p.updated_at) from app.lesson_progress p where p.user_id = v.id and p.course_id = c.id), a.granted_at) desc)
      from app.course_access a join app.courses c on c.id = a.course_id
      where a.user_id = v.id and a.revoked_at is null and (a.expires_at is null or a.expires_at > now())), '[]'::jsonb),
    'orders', coalesce((select jsonb_agg(public.course_order_json(o) order by o.created_at desc)
      from app.course_orders o where o.user_id = v.id and o.status <> 'cancelled'), '[]'::jsonb));
end $$;

-- Экран урока: список уроков, право смотреть, водяной знак. Ссылку на видео выдаёт функция courses.
create or replace function public.course_player(p_slug text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v app.profiles; c app.courses; v_access boolean;
begin
  v := app.require_user();
  select * into c from app.courses where slug = lower(btrim(coalesce(p_slug, '')));
  if not found then raise exception 'not_found'; end if;
  v_access := app.course_has_access(v.id, c.id);
  if c.status <> 'published' and not v_access then raise exception 'not_found'; end if;
  return jsonb_build_object(
    'course', jsonb_build_object('id', c.id, 'slug', c.slug, 'title', c.title, 'recommendations', c.recommendations,
      'contraindications', c.contraindications, 'price', c.price, 'on_sale', c.status = 'published'),
    'access', v_access, 'blocked', v.courses_blocked,
    'watermark', app.watermark(v.id),
    'progress', app.course_progress(v.id, c.id),
    'lessons', coalesce((select jsonb_agg(jsonb_build_object('id', l.id, 'title', l.title, 'description', l.description,
        'recommendations', l.recommendations, 'duration_sec', l.duration_sec, 'is_free', l.is_free, 'poster_url', l.poster_url,
        'can_watch', (v_access or l.is_free) and not v.courses_blocked,
        'position_sec', p.position_sec, 'completed', p.completed_at is not null) order by l.sort, l.created_at)
      from app.lessons l left join app.lesson_progress p on p.lesson_id = l.id and p.user_id = v.id
      where l.course_id = c.id and not l.hidden and l.video_path is not null), '[]'::jsonb));
end $$;

create or replace function public.course_progress_save(p_lesson uuid, p_position numeric, p_duration numeric, p_completed boolean default false)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v app.profiles; l app.lessons; v_done boolean; v_dur numeric;
begin
  v := app.require_user();
  if not app.rl_hit('cprog:' || v.id, 240, 600) then raise exception 'rate_limited'; end if;
  select * into l from app.lessons where id = p_lesson and not hidden and video_path is not null;
  if not found then raise exception 'not_found'; end if;
  if not (app.course_has_access(v.id, l.course_id) or (l.is_free and not v.courses_blocked)) then raise exception 'no_access'; end if;
  v_dur := coalesce(l.duration_sec, nullif(p_duration, 0));
  p_position := greatest(0, least(coalesce(p_position, 0), coalesce(v_dur, 36000)));
  v_done := coalesce(p_completed, false) or (v_dur is not null and p_position >= v_dur * 0.9);
  insert into app.lesson_progress as x (user_id, lesson_id, course_id, position_sec, duration_sec, completed_at)
  values (v.id, l.id, l.course_id, p_position, v_dur, case when v_done then now() end)
  on conflict (user_id, lesson_id) do update set
    position_sec = excluded.position_sec, duration_sec = excluded.duration_sec, updated_at = now(),
    completed_at = coalesce(x.completed_at, excluded.completed_at);
  return jsonb_build_object('ok', true, 'completed', v_done, 'progress', app.course_progress(v.id, l.course_id));
end $$;

-- Пульс плеера: сессия ещё действует?
create or replace function public.course_heartbeat(p_session uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v app.profiles; s app.playback_sessions;
begin
  v := app.require_user();
  select * into s from app.playback_sessions where id = p_session and user_id = v.id for update;
  if not found then raise exception 'not_found'; end if;
  if s.ended_at is not null then
    return jsonb_build_object('ok', false, 'reason', s.end_reason);
  end if;
  if v.courses_blocked then
    update app.playback_sessions set ended_at = now(), end_reason = 'revoked' where id = s.id;
    return jsonb_build_object('ok', false, 'reason', 'revoked');
  end if;
  update app.playback_sessions set last_seen_at = now() where id = s.id;
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.course_session_stop(p_session uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v app.profiles;
begin
  v := app.require_user();
  update app.playback_sessions set ended_at = now(), end_reason = 'stopped'
  where id = p_session and user_id = v.id and ended_at is null;
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.gift_activate(p_code text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v app.profiles; g app.course_gifts; v_code text := upper(regexp_replace(coalesce(p_code, ''), '\s', '', 'g'));
  v_course uuid; v_n int := 0; v_all_owned boolean;
begin
  v := app.require_user();
  if v.courses_blocked then raise exception 'courses_blocked'; end if;
  -- ошибки возвращаются, а не выбрасываются: иначе откатится счётчик попыток (защита от перебора)
  if not app.rl_hit('gift:' || v.id, 8, 3600) then
    if app.rl_hit('gift-alert:' || v.id, 1, 3600) then
      perform app.log_event('gift_bruteforce', 'alert', v.id, jsonb_build_object('client_no', v.client_no), true);
    end if;
    return jsonb_build_object('ok', false, 'error', 'rate_limited');
  end if;
  if v_code !~ '^FZG-[A-Z0-9]{4}-[A-Z0-9]{4}$' then return jsonb_build_object('ok', false, 'error', 'gift_invalid'); end if;
  select * into g from app.course_gifts where code = v_code for update;
  if not found then
    perform app.log_event('gift_invalid_attempt', 'warn', v.id, jsonb_build_object('client_no', v.client_no), null);
    return jsonb_build_object('ok', false, 'error', 'gift_invalid');
  end if;
  if g.status = 'activated' then
    perform app.log_event('gift_reuse_attempt', 'warn', v.id, jsonb_build_object('client_no', v.client_no, 'title', g.title,
      'own', g.activated_by = v.id), g.activated_by <> v.id);
    return jsonb_build_object('ok', false, 'error', 'gift_used');
  end if;
  if g.status <> 'issued' then return jsonb_build_object('ok', false, 'error', 'gift_cancelled'); end if;
  select bool_and(app.course_has_access(v.id, x)) into v_all_owned from unnest(g.course_ids) x;
  if v_all_owned then return jsonb_build_object('ok', false, 'error', 'already_owned'); end if;

  update app.course_gifts set status = 'activated', activated_by = v.id, activated_at = now() where id = g.id;
  foreach v_course in array g.course_ids loop
    if app.grant_access(v.id, v_course, 'gift', g.order_id, g.id, null, null, null) then v_n := v_n + 1; end if;
  end loop;
  perform app.log_event('gift_activated', 'info', v.id, jsonb_build_object('client_no', v.client_no, 'title', g.title,
    'buyer_no', (select client_no from app.profiles where id = g.buyer_id), 'granted', v_n), true);
  perform app.notify_user(g.buyer_id, 'gift_activated:' || g.id,
    'Ваш подарок «' || g.title || '» активирован получателем. Спасибо, что выбрали «Физиотеру»!', null, null, null);
  return jsonb_build_object('ok', true, 'title', g.title, 'granted', v_n);
end $$;

create or replace function public.set_course_news(p_on boolean) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v app.profiles;
begin
  v := app.require_user();
  update app.profiles set course_news = coalesce(p_on, false), updated_at = now() where id = v.id;
  return jsonb_build_object('ok', true, 'course_news', coalesce(p_on, false));
end $$;

-- ---------------------------------------------------------------------
-- Для серверной функции courses (service_role)
-- ---------------------------------------------------------------------

-- Начать просмотр: право на урок + единственная активная сессия аккаунта.
create or replace function public.svc_course_play(p_user uuid, p_lesson uuid, p_device text, p_force boolean,
  p_session uuid, p_ip text, p_ua text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v app.profiles; l app.lessons; s app.playback_sessions; v_new uuid;
begin
  select * into v from app.profiles where id = p_user;
  if not found or v.status <> 'active' then raise exception 'account_inactive'; end if;
  if v.courses_blocked then raise exception 'courses_blocked'; end if;
  select * into l from app.lessons where id = p_lesson and not hidden and video_path is not null;
  if not found then raise exception 'not_found'; end if;
  if not (app.course_has_access(v.id, l.course_id) or l.is_free) then
    perform app.log_event('video_access_denied', 'warn', v.id, jsonb_build_object('client_no', v.client_no, 'lesson', l.title), null, null, null, p_ip);
    return jsonb_build_object('ok', false, 'error', 'no_access');
  end if;
  if p_device !~ '^[A-Za-z0-9_-]{16,64}$' then raise exception 'bad_request'; end if;

  -- слишком частые запросы ссылок — признак выкачивания (ошибка возвращается, чтобы счётчик не откатился)
  if not app.rl_hit('vurl:' || v.id, 40, 600) then
    if app.rl_hit('vurl-alert:' || v.id, 1, 3600) then
      perform app.log_event('video_url_flood', 'alert', v.id, jsonb_build_object('client_no', v.client_no, 'lesson', l.title), true, null, null, p_ip);
    end if;
    return jsonb_build_object('ok', false, 'error', 'rate_limited');
  end if;

  select * into s from app.playback_sessions where user_id = v.id and ended_at is null for update;
  if found then
    if s.last_seen_at < now() - interval '90 seconds' then
      update app.playback_sessions set ended_at = now(), end_reason = 'expired' where id = s.id;
    elsif s.device_id = p_device then
      update app.playback_sessions set lesson_id = l.id, last_seen_at = now(), urls_issued = urls_issued + 1 where id = s.id;
      return jsonb_build_object('ok', true, 'session_id', s.id, 'video_path', l.video_path, 'duration_sec', l.duration_sec);
    elsif coalesce(p_force, false) then
      update app.playback_sessions set ended_at = now(), end_reason = 'replaced' where id = s.id;
      perform app.log_event('playback_takeover', 'info', v.id, jsonb_build_object('client_no', v.client_no), null, null, null, p_ip);
    else
      return jsonb_build_object('ok', false, 'error', 'other_device',
        'since', s.started_at, 'device_hint', left(coalesce(s.user_agent, ''), 60));
    end if;
  end if;

  insert into app.playback_sessions (user_id, device_id, lesson_id, ip_hash, user_agent, urls_issued)
  values (v.id, p_device, l.id, p_ip, left(p_ua, 200), 1) returning id into v_new;

  -- много разных устройств за сутки — сигнал для администратора
  if (select count(distinct device_id) from app.playback_sessions where user_id = v.id and started_at > now() - interval '24 hours') >= 4
     and app.rl_hit('vdev-alert:' || v.id, 1, 86400) then
    perform app.log_event('many_devices', 'warn', v.id, jsonb_build_object('client_no', v.client_no,
      'devices_24h', (select count(distinct device_id) from app.playback_sessions where user_id = v.id and started_at > now() - interval '24 hours')),
      true, null, null, p_ip);
  end if;
  return jsonb_build_object('ok', true, 'session_id', v_new, 'video_path', l.video_path, 'duration_sec', l.duration_sec);
end $$;

create or replace function public.svc_is_admin(p_user uuid) returns boolean
language sql security definer set search_path = '' as $$ select app.is_admin(p_user) $$;

-- Привязать загруженное видео к уроку (после проверки, что файл лежит в бакете)
create or replace function public.svc_lesson_set_video(p_admin uuid, p_lesson uuid, p_path text, p_size bigint, p_duration int,
  p_poster text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare l app.lessons; v_old text;
begin
  if not app.is_admin(p_admin) then raise exception 'forbidden'; end if;
  select * into l from app.lessons where id = p_lesson for update;
  if not found then raise exception 'not_found'; end if;
  if p_path not like 'lessons/' || l.id || '/%' then raise exception 'bad_path'; end if;
  if not exists (select 1 from storage.objects where bucket_id = 'course-videos' and name = p_path) then
    raise exception 'file_missing';
  end if;
  v_old := l.video_path;
  update app.lessons set video_path = p_path, video_size = p_size,
    duration_sec = coalesce(nullif(p_duration, 0), duration_sec),
    poster_url = coalesce(p_poster, poster_url), updated_at = now()
  where id = l.id;
  perform app.log_event('lesson_video_replaced', 'info', null, jsonb_build_object('lesson', l.title,
    'course', (select title from app.courses where id = l.course_id), 'size_mb', round(p_size / 1048576.0, 1),
    'replaced', v_old is not null), null, p_admin, null);
  return jsonb_build_object('ok', true, 'old_path', v_old);
end $$;

create or replace function public.svc_set_cover(p_admin uuid, p_kind text, p_id uuid, p_url text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_old text;
begin
  if not app.is_admin(p_admin) then raise exception 'forbidden'; end if;
  if p_url !~ '^/sb/storage/v1/object/public/course-media/' then raise exception 'bad_path'; end if;
  if p_kind = 'course' then
    select cover_url into v_old from app.courses where id = p_id;
    update app.courses set cover_url = p_url, updated_at = now() where id = p_id;
  elsif p_kind = 'bundle' then
    select cover_url into v_old from app.bundles where id = p_id;
    update app.bundles set cover_url = p_url, updated_at = now() where id = p_id;
  elsif p_kind = 'lesson' then
    select poster_url into v_old from app.lessons where id = p_id;
    update app.lessons set poster_url = p_url, updated_at = now() where id = p_id;
  else raise exception 'bad_request'; end if;
  if not found then raise exception 'not_found'; end if;
  perform app.log_event('course_cover_changed', 'info', null, jsonb_build_object('kind', p_kind), null, p_admin, null);
  return jsonb_build_object('ok', true, 'old_url', v_old);
end $$;

create or replace function public.svc_claim_mail(p_limit int) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v jsonb;
begin
  with picked as (
    select m.id from app.mail_outbox m where m.status = 'queued' and m.next_try_at <= now()
    order by m.id limit least(greatest(coalesce(p_limit, 10), 1), 30) for update skip locked
  ), upd as (
    update app.mail_outbox m set attempts = m.attempts + 1, next_try_at = now() + interval '10 minutes'
    from picked where m.id = picked.id returning m.*
  )
  select coalesce(jsonb_agg(jsonb_build_object('id', u.id, 'to', u.to_email, 'subject', u.subject, 'body', u.body)), '[]'::jsonb)
  into v from upd u;
  return v;
end $$;

create or replace function public.svc_mail_result(p_id bigint, p_ok boolean, p_error text) returns void
language sql security definer set search_path = '' as $$
  update app.mail_outbox set
    status = case when p_ok then 'sent' when attempts >= 5 then 'failed' else 'queued' end,
    sent_at = case when p_ok then now() end, error = case when p_ok then null else left(p_error, 300) end
  where id = p_id
$$;

-- ---- Для Telegram-бота ----

create or replace function app.tg_user(p_tg bigint) returns app.profiles
language sql stable set search_path = '' as $$
  select p.* from app.telegram_identities t join app.profiles p on p.id = t.user_id where t.telegram_id = p_tg
$$;

create or replace function public.svc_tg_profile(p_tg bigint) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v app.profiles;
begin
  v := app.tg_user(p_tg);
  if v.id is null then return null; end if;
  perform app.refresh_bonus(b.id) from app.bonuses b where b.user_id = v.id and b.status in ('available', 'pending');
  return jsonb_build_object(
    'client_no', v.client_no, 'name', v.display_name, 'email', v.email, 'phone', v.phone,
    'status', v.status, 'courses_blocked', v.courses_blocked, 'created_at', v.created_at,
    'ref_code', v.ref_code, 'news_opt_in', v.news_opt_in, 'course_news', v.course_news,
    'site_url', (select site_url from app.settings),
    'bonuses', coalesce((select jsonb_agg(jsonb_build_object('title', b.title, 'discount_type', b.discount_type, 'amount', b.amount,
        'status', b.status, 'expires_at', b.expires_at) order by b.created_at desc)
      from app.bonuses b where b.user_id = v.id and b.status in ('available', 'pending')), '[]'::jsonb),
    'invites', (select count(*) from app.referrals r where r.referrer_id = v.id),
    'courses', coalesce((select jsonb_agg(jsonb_build_object('title', c.title, 'slug', c.slug,
        'progress', app.course_progress(v.id, c.id)) order by a.granted_at desc)
      from app.course_access a join app.courses c on c.id = a.course_id
      where a.user_id = v.id and a.revoked_at is null and (a.expires_at is null or a.expires_at > now())), '[]'::jsonb),
    'orders', coalesce((select jsonb_agg(x order by (x ->> 'created_at') desc) from (
        select jsonb_build_object('order_no', o.order_no, 'title', o.title, 'total', o.total, 'status', o.status,
          'created_at', o.created_at, 'is_gift', o.is_gift) x
        from app.course_orders o where o.user_id = v.id and o.status <> 'cancelled' order by o.created_at desc limit 5) t), '[]'::jsonb));
end $$;

-- Подтверждение оплаты администратором из бота
create or replace function public.svc_order_paid_tg(p_tg bigint, p_order uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_actor uuid;
begin
  if not app.is_admin_tg(p_tg) then raise exception 'forbidden'; end if;
  select user_id into v_actor from app.telegram_identities where telegram_id = p_tg;
  return app.order_mark_paid(p_order, 'manual', null, null, 'подтверждено в Telegram', null, v_actor, p_tg);
end $$;

create or replace function public.svc_order_cancel_tg(p_tg bigint, p_order uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare o app.course_orders; v_actor uuid;
begin
  if not app.is_admin_tg(p_tg) then raise exception 'forbidden'; end if;
  select user_id into v_actor from app.telegram_identities where telegram_id = p_tg;
  update app.course_orders set status = 'cancelled', cancel_reason = 'Отменён администратором', updated_at = now()
  where id = p_order and status = 'pending' returning * into o;
  if not found then raise exception 'not_pending'; end if;
  perform app.log_event('course_order_cancelled', 'info', o.user_id, jsonb_build_object('order_no', o.order_no, 'by', 'admin'), null, v_actor, p_tg);
  return jsonb_build_object('ok', true, 'order_no', o.order_no);
end $$;

-- ---------------------------------------------------------------------
-- Админ-панель
-- ---------------------------------------------------------------------

create or replace function public.admin_courses_overview() returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  perform app.require_admin();
  return jsonb_build_object(
    'categories', coalesce((select jsonb_agg(jsonb_build_object('id', k.id, 'slug', k.slug, 'title', k.title,
        'description', k.description, 'sort', k.sort, 'hidden', k.hidden,
        'courses', (select count(*) from app.courses c where c.category_id = k.id)) order by k.sort, k.title)
      from app.course_categories k), '[]'::jsonb),
    'courses', coalesce((select jsonb_agg(app.course_card(c, null) || jsonb_build_object('sort', c.sort,
        'lessons_all', (select count(*) from app.lessons l where l.course_id = c.id),
        'lessons_no_video', (select count(*) from app.lessons l where l.course_id = c.id and l.video_path is null),
        'students', (select count(*) from app.course_access a where a.course_id = c.id and a.revoked_at is null),
        'sales', (select count(*) from app.course_orders o where o.status = 'paid' and c.id = any (o.course_ids) and not o.is_gift))
        order by c.sort, c.title) from app.courses c), '[]'::jsonb),
    'bundles', coalesce((select jsonb_agg(app.bundle_card(b, null) || jsonb_build_object('sort', b.sort,
        'sales', (select count(*) from app.course_orders o where o.status = 'paid' and o.bundle_id = b.id)) order by b.sort, b.title)
      from app.bundles b), '[]'::jsonb),
    'promos', coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'code', p.code, 'discount_type', p.discount_type,
        'amount', p.amount, 'max_uses', p.max_uses, 'per_user', p.per_user, 'valid_from', p.valid_from,
        'valid_until', p.valid_until, 'applies_all', p.applies_all, 'course_ids', to_jsonb(p.course_ids),
        'bundle_ids', to_jsonb(p.bundle_ids), 'active', p.active, 'note', p.note,
        'used', (select count(*) from app.course_orders o where o.promo_id = p.id and o.status = 'paid'),
        'reserved', (select count(*) from app.course_orders o where o.promo_id = p.id and o.status = 'pending'))
        order by p.created_at desc) from app.course_promos p), '[]'::jsonb),
    'pending_orders', (select count(*) from app.course_orders where status = 'pending'));
end $$;

create or replace function public.admin_category_save(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_admin uuid; v_id uuid := nullif(p ->> 'id', '')::uuid; v_title text := app.txt(p, 'title', 120);
  v_slug text := lower(app.txt(p, 'slug', 60));
begin
  v_admin := app.require_admin();
  if char_length(v_title) < 2 then raise exception 'bad_title'; end if;
  if v_slug !~ '^[a-z0-9][a-z0-9-]{1,59}$' then raise exception 'bad_slug'; end if;
  if v_id is null then
    insert into app.course_categories (slug, title, description, sort, hidden)
    values (v_slug, v_title, app.txt(p, 'description', 1000), coalesce((p ->> 'sort')::int, 0), coalesce((p ->> 'hidden')::boolean, false))
    returning id into v_id;
  else
    update app.course_categories set slug = v_slug, title = v_title, description = app.txt(p, 'description', 1000),
      sort = coalesce((p ->> 'sort')::int, sort), hidden = coalesce((p ->> 'hidden')::boolean, hidden), updated_at = now()
    where id = v_id;
    if not found then raise exception 'not_found'; end if;
  end if;
  perform app.log_event('course_category_saved', 'info', null, jsonb_build_object('title', v_title), null, v_admin);
  return jsonb_build_object('ok', true, 'id', v_id);
exception when unique_violation then raise exception 'slug_taken';
end $$;

create or replace function public.admin_category_delete(p_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_admin uuid; v_title text;
begin
  v_admin := app.require_admin();
  if exists (select 1 from app.courses where category_id = p_id) then raise exception 'category_not_empty'; end if;
  delete from app.course_categories where id = p_id returning title into v_title;
  if not found then raise exception 'not_found'; end if;
  perform app.log_event('course_category_deleted', 'warn', null, jsonb_build_object('title', v_title), null, v_admin);
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.admin_course_get(p_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare c app.courses;
begin
  perform app.require_admin();
  select * into c from app.courses where id = p_id;
  if not found then raise exception 'not_found'; end if;
  return to_jsonb(c) || jsonb_build_object(
    'stats', app.course_stats(c.id),
    'lessons', coalesce((select jsonb_agg(jsonb_build_object('id', l.id, 'sort', l.sort, 'title', l.title, 'description', l.description,
        'recommendations', l.recommendations, 'has_video', l.video_path is not null, 'video_size', l.video_size,
        'duration_sec', l.duration_sec, 'poster_url', l.poster_url, 'is_free', l.is_free, 'hidden', l.hidden,
        'published_at', l.published_at,
        'viewers', (select count(*) from app.lesson_progress p where p.lesson_id = l.id),
        'completed', (select count(*) from app.lesson_progress p where p.lesson_id = l.id and p.completed_at is not null))
        order by l.sort, l.created_at) from app.lessons l where l.course_id = c.id), '[]'::jsonb),
    'students', (select count(*) from app.course_access a where a.course_id = c.id and a.revoked_at is null),
    'avg_progress', (select round(avg((app.course_progress(a.user_id, c.id) ->> 'percent')::numeric))
                     from app.course_access a where a.course_id = c.id and a.revoked_at is null));
end $$;

create or replace function public.admin_course_save(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_admin uuid; v_id uuid := nullif(p ->> 'id', '')::uuid; old app.courses; c app.courses;
  v_title text := app.txt(p, 'title', 120); v_slug text := lower(app.txt(p, 'slug', 60));
  v_price numeric := nullif(p ->> 'price', '')::numeric; v_old numeric := nullif(p ->> 'old_price', '')::numeric;
  v_days int := nullif(p ->> 'access_days', '')::int; v_cat uuid := nullif(p ->> 'category_id', '')::uuid;
begin
  v_admin := app.require_admin();
  if char_length(v_title) < 3 then raise exception 'bad_title'; end if;
  if v_slug !~ '^[a-z0-9][a-z0-9-]{1,59}$' then raise exception 'bad_slug'; end if;
  if v_cat is null or not exists (select 1 from app.course_categories where id = v_cat) then raise exception 'bad_category'; end if;
  if v_price is not null and (v_price < 0 or v_price > 1000000) then raise exception 'bad_price'; end if;
  if v_old is not null and (v_price is null or v_old <= v_price) then raise exception 'bad_old_price'; end if;
  if v_days is not null and (v_days < 1 or v_days > 3650) then raise exception 'bad_days'; end if;

  if v_id is not null then
    select * into old from app.courses where id = v_id for update;
    if not found then raise exception 'not_found'; end if;
    if old.status = 'published' and v_price is null then raise exception 'price_required'; end if;
    update app.courses set slug = v_slug, category_id = v_cat, title = v_title,
      short = app.txt(p, 'short', 400), direction = app.txt(p, 'direction', 120),
      for_whom = app.txt(p, 'for_whom', 4000), tasks = app.txt(p, 'tasks', 4000), program = app.txt(p, 'program', 4000),
      results = app.txt(p, 'results', 4000), recommendations = app.txt(p, 'recommendations', 4000),
      author = app.txt(p, 'author', 4000), contraindications = app.txt(p, 'contraindications', 6000),
      access_terms = app.txt(p, 'access_terms', 3000), price = v_price, old_price = v_old, access_days = v_days,
      sort = coalesce((p ->> 'sort')::int, sort), updated_at = now()
    where id = v_id returning * into c;
    if old.price is distinct from c.price or old.old_price is distinct from c.old_price then
      perform app.log_event('course_price_changed', 'warn', null, jsonb_build_object('course', c.title,
        'before', old.price, 'after', c.price, 'old_price', c.old_price), true, v_admin);
    end if;
  else
    insert into app.courses (slug, category_id, title, short, direction, for_whom, tasks, program, results, recommendations,
      author, contraindications, access_terms, price, old_price, access_days, sort)
    values (v_slug, v_cat, v_title, app.txt(p, 'short', 400), app.txt(p, 'direction', 120), app.txt(p, 'for_whom', 4000),
      app.txt(p, 'tasks', 4000), app.txt(p, 'program', 4000), app.txt(p, 'results', 4000), app.txt(p, 'recommendations', 4000),
      app.txt(p, 'author', 4000), app.txt(p, 'contraindications', 6000), app.txt(p, 'access_terms', 3000),
      v_price, v_old, v_days, coalesce((p ->> 'sort')::int, 0))
    returning * into c;
  end if;
  perform app.log_event('course_saved', 'info', null, jsonb_build_object('course', c.title, 'new', v_id is null), null, v_admin);
  return jsonb_build_object('ok', true, 'id', c.id);
exception when unique_violation then raise exception 'slug_taken';
end $$;

create or replace function public.admin_course_set_status(p_id uuid, p_status text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_admin uuid; c app.courses;
begin
  v_admin := app.require_admin();
  if p_status not in ('draft', 'published', 'archived') then raise exception 'bad_request'; end if;
  select * into c from app.courses where id = p_id for update;
  if not found then raise exception 'not_found'; end if;
  if p_status = 'published' then
    if c.price is null then raise exception 'price_required'; end if;
    if (app.course_stats(c.id) ->> 'lessons')::int = 0 then raise exception 'no_lessons'; end if;
  end if;
  -- снятие с продажи НЕ отзывает доступ у купивших
  update app.courses set status = p_status, updated_at = now(),
    published_at = case when p_status = 'published' then coalesce(published_at, now()) else published_at end
  where id = c.id;
  if p_status <> 'published' then
    update app.course_orders set status = 'cancelled', cancel_reason = 'Курс снят с продажи', updated_at = now()
    where status = 'pending' and course_id = c.id;
  end if;
  perform app.log_event('course_status_changed', 'warn', null, jsonb_build_object('course', c.title,
    'before', c.status, 'after', p_status), true, v_admin);
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.admin_lesson_save(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_admin uuid; v_id uuid := nullif(p ->> 'id', '')::uuid; l app.lessons; old app.lessons;
  v_course uuid := nullif(p ->> 'course_id', '')::uuid; v_title text := app.txt(p, 'title', 160);
  v_hidden boolean := coalesce((p ->> 'hidden')::boolean, true); c app.courses;
begin
  v_admin := app.require_admin();
  if char_length(v_title) < 2 then raise exception 'bad_title'; end if;
  if v_id is null then
    if v_course is null or not exists (select 1 from app.courses where id = v_course) then raise exception 'not_found'; end if;
    insert into app.lessons (course_id, sort, title, description, recommendations, is_free, hidden)
    values (v_course, coalesce((p ->> 'sort')::int, (select coalesce(max(sort), 0) + 1 from app.lessons where course_id = v_course)),
      v_title, app.txt(p, 'description', 4000), app.txt(p, 'recommendations', 4000),
      coalesce((p ->> 'is_free')::boolean, false), true)
    returning * into l;
  else
    select * into old from app.lessons where id = v_id for update;
    if not found then raise exception 'not_found'; end if;
    if not v_hidden and old.video_path is null then raise exception 'no_video'; end if;
    update app.lessons set title = v_title, description = app.txt(p, 'description', 4000),
      recommendations = app.txt(p, 'recommendations', 4000), is_free = coalesce((p ->> 'is_free')::boolean, is_free),
      hidden = v_hidden, published_at = case when not v_hidden then coalesce(published_at, now()) else published_at end,
      updated_at = now()
    where id = v_id returning * into l;
    -- первая публикация урока в курсе, который уже продаётся, — сообщаем ученикам
    if old.published_at is null and l.published_at is not null then
      select * into c from app.courses where id = l.course_id;
      if c.status = 'published' or exists (select 1 from app.course_access a where a.course_id = c.id and a.revoked_at is null) then
        perform app.notify_user(a.user_id, 'new_lesson:' || l.id || ':' || a.user_id,
          'В курсе «' || c.title || '» новый урок: «' || l.title || '».', 'Смотреть', '/kursy/' || c.slug || '/', null)
        from app.course_access a join app.profiles pr on pr.id = a.user_id
        where a.course_id = c.id and a.revoked_at is null and pr.course_news and pr.status = 'active';
        perform app.log_event('lesson_published', 'info', null, jsonb_build_object('course', c.title, 'lesson', l.title,
          'students', (select count(*) from app.course_access a where a.course_id = c.id and a.revoked_at is null)), true, v_admin);
        perform app.call_bot('dispatch');
      end if;
    end if;
  end if;
  perform app.log_event('lesson_saved', 'info', null, jsonb_build_object('lesson', l.title, 'hidden', l.hidden, 'free', l.is_free), null, v_admin);
  return jsonb_build_object('ok', true, 'id', l.id);
end $$;

create or replace function public.admin_lesson_reorder(p_course uuid, p_ids uuid[]) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_admin uuid; i int;
begin
  v_admin := app.require_admin();
  for i in 1 .. coalesce(array_length(p_ids, 1), 0) loop
    update app.lessons set sort = i, updated_at = now() where id = p_ids[i] and course_id = p_course;
  end loop;
  perform app.log_event('lessons_reordered', 'info', null, jsonb_build_object('course', (select title from app.courses where id = p_course)), null, v_admin);
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.admin_lesson_delete(p_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_admin uuid; l app.lessons;
begin
  v_admin := app.require_admin();
  select * into l from app.lessons where id = p_id for update;
  if not found then raise exception 'not_found'; end if;
  -- урок, который уже смотрели, не удаляем (прогресс учеников) — только скрываем
  if exists (select 1 from app.lesson_progress where lesson_id = l.id) or l.published_at is not null then
    raise exception 'lesson_has_progress';
  end if;
  update app.playback_sessions set lesson_id = null where lesson_id = l.id;
  delete from app.lessons where id = l.id;
  perform app.log_event('lesson_deleted', 'warn', null, jsonb_build_object('lesson', l.title), null, v_admin);
  return jsonb_build_object('ok', true, 'video_path', l.video_path);
end $$;

create or replace function public.admin_bundle_save(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_admin uuid; v_id uuid := nullif(p ->> 'id', '')::uuid; old app.bundles; b app.bundles;
  v_title text := app.txt(p, 'title', 120); v_slug text := lower(app.txt(p, 'slug', 60));
  v_price numeric := nullif(p ->> 'price', '')::numeric; v_old numeric := nullif(p ->> 'old_price', '')::numeric;
  v_courses uuid[] := array(select jsonb_array_elements_text(coalesce(p -> 'course_ids', '[]'::jsonb))::uuid);
  v_mode text := coalesce(nullif(p ->> 'overlap_mode', ''), 'prorate');
begin
  v_admin := app.require_admin();
  if char_length(v_title) < 3 then raise exception 'bad_title'; end if;
  if v_slug !~ '^[a-z0-9][a-z0-9-]{1,59}$' then raise exception 'bad_slug'; end if;
  if cardinality(v_courses) < 2 then raise exception 'bundle_min_courses'; end if;
  if v_price is not null and (v_price < 0 or v_price > 1000000) then raise exception 'bad_price'; end if;
  if v_old is not null and (v_price is null or v_old <= v_price) then raise exception 'bad_old_price'; end if;
  if v_mode not in ('prorate', 'full', 'block') then raise exception 'bad_request'; end if;
  if v_id is null then
    insert into app.bundles (slug, title, description, price, old_price, overlap_mode, sort)
    values (v_slug, v_title, app.txt(p, 'description', 4000), v_price, v_old, v_mode, coalesce((p ->> 'sort')::int, 0))
    returning * into b;
  else
    select * into old from app.bundles where id = v_id for update;
    if not found then raise exception 'not_found'; end if;
    if old.status = 'published' and v_price is null then raise exception 'price_required'; end if;
    update app.bundles set slug = v_slug, title = v_title, description = app.txt(p, 'description', 4000), price = v_price,
      old_price = v_old, overlap_mode = v_mode, sort = coalesce((p ->> 'sort')::int, sort), updated_at = now()
    where id = v_id returning * into b;
    delete from app.bundle_courses where bundle_id = b.id;
    if old.price is distinct from b.price then
      perform app.log_event('course_price_changed', 'warn', null, jsonb_build_object('course', 'Комплект «' || b.title || '»',
        'before', old.price, 'after', b.price), true, v_admin);
    end if;
  end if;
  insert into app.bundle_courses (bundle_id, course_id) select b.id, x from unnest(v_courses) x
    where exists (select 1 from app.courses c where c.id = x) on conflict do nothing;
  perform app.log_event('bundle_saved', 'info', null, jsonb_build_object('bundle', b.title, 'courses', cardinality(v_courses)), null, v_admin);
  return jsonb_build_object('ok', true, 'id', b.id);
exception when unique_violation then raise exception 'slug_taken';
end $$;

create or replace function public.admin_bundle_set_status(p_id uuid, p_status text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_admin uuid; b app.bundles;
begin
  v_admin := app.require_admin();
  if p_status not in ('draft', 'published', 'archived') then raise exception 'bad_request'; end if;
  select * into b from app.bundles where id = p_id for update;
  if not found then raise exception 'not_found'; end if;
  if p_status = 'published' and b.price is null then raise exception 'price_required'; end if;
  if p_status = 'published' and exists (select 1 from app.bundle_courses bc join app.courses c on c.id = bc.course_id
      where bc.bundle_id = b.id and c.status <> 'published') then raise exception 'bundle_courses_unpublished'; end if;
  update app.bundles set status = p_status, updated_at = now() where id = b.id;
  if p_status <> 'published' then
    update app.course_orders set status = 'cancelled', cancel_reason = 'Комплект снят с продажи', updated_at = now()
    where status = 'pending' and bundle_id = b.id;
  end if;
  perform app.log_event('course_status_changed', 'warn', null, jsonb_build_object('course', 'Комплект «' || b.title || '»',
    'before', b.status, 'after', p_status), true, v_admin);
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.admin_promo_save(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_admin uuid; v_id uuid := nullif(p ->> 'id', '')::uuid; v_code text := upper(app.txt(p, 'code', 30));
  v_type text := p ->> 'discount_type'; v_amount numeric := nullif(p ->> 'amount', '')::numeric;
  v_all boolean := coalesce((p ->> 'applies_all')::boolean, true);
  v_courses uuid[] := array(select jsonb_array_elements_text(coalesce(p -> 'course_ids', '[]'::jsonb))::uuid);
  v_bundles uuid[] := array(select jsonb_array_elements_text(coalesce(p -> 'bundle_ids', '[]'::jsonb))::uuid);
begin
  v_admin := app.require_admin();
  if v_code !~ '^[A-Z0-9][A-Z0-9-]{2,29}$' or v_code ~ '^GIFT-' then raise exception 'bad_promo_code'; end if;
  if v_type not in ('percent', 'fixed') or v_amount is null or v_amount <= 0
     or (v_type = 'percent' and v_amount > 100) or v_amount > 1000000 then raise exception 'bad_amount'; end if;
  if not v_all and cardinality(v_courses) + cardinality(v_bundles) = 0 then raise exception 'no_services'; end if;
  if v_id is null then
    insert into app.course_promos (code, discount_type, amount, max_uses, per_user, valid_from, valid_until,
      applies_all, course_ids, bundle_ids, active, note, created_by)
    values (v_code, v_type, v_amount, nullif(p ->> 'max_uses', '')::int, coalesce(nullif(p ->> 'per_user', '')::int, 1),
      nullif(p ->> 'valid_from', '')::timestamptz, nullif(p ->> 'valid_until', '')::timestamptz,
      v_all, v_courses, v_bundles, coalesce((p ->> 'active')::boolean, true), nullif(app.txt(p, 'note', 300), ''), v_admin)
    returning id into v_id;
  else
    update app.course_promos set code = v_code, discount_type = v_type, amount = v_amount,
      max_uses = nullif(p ->> 'max_uses', '')::int, per_user = coalesce(nullif(p ->> 'per_user', '')::int, 1),
      valid_from = nullif(p ->> 'valid_from', '')::timestamptz, valid_until = nullif(p ->> 'valid_until', '')::timestamptz,
      applies_all = v_all, course_ids = v_courses, bundle_ids = v_bundles,
      active = coalesce((p ->> 'active')::boolean, active), note = nullif(app.txt(p, 'note', 300), ''), updated_at = now()
    where id = v_id;
    if not found then raise exception 'not_found'; end if;
  end if;
  perform app.log_event('course_promo_saved', 'warn', null, jsonb_build_object('code', v_code,
    'discount', case when v_type = 'percent' then v_amount || '%' else app.money(v_amount) end), true, v_admin);
  return jsonb_build_object('ok', true, 'id', v_id);
exception when unique_violation then raise exception 'promo_taken';
end $$;

create or replace function public.admin_course_orders(p_status text default '', p_q text default '', p_limit int default 50, p_offset int default 0)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_q text := btrim(coalesce(p_q, ''));
begin
  perform app.require_admin();
  return coalesce((select jsonb_agg(public.course_order_json(o) || jsonb_build_object(
      'user', jsonb_build_object('id', p.id, 'client_no', p.client_no, 'name', p.display_name, 'phone', p.phone, 'email', p.email),
      'payment', (select jsonb_build_object('provider', y.provider, 'method', y.method, 'note', y.note, 'created_at', y.created_at)
                  from app.course_payments y where y.order_id = o.id),
      'refunds', coalesce((select jsonb_agg(jsonb_build_object('amount', r.amount, 'reason', r.reason, 'created_at', r.created_at,
                  'revoke_access', r.revoke_access)) from app.course_refunds r where r.order_id = o.id), '[]'::jsonb),
      'cancel_reason', o.cancel_reason) order by o.created_at desc)
    from (select * from app.course_orders o
          where (coalesce(p_status, '') = '' or o.status = p_status)
            and (v_q = '' or o.order_no::text = v_q or o.title ilike '%' || v_q || '%' or o.promo_code = upper(v_q)
                 or exists (select 1 from app.profiles x where x.id = o.user_id and (x.client_no::text = v_q
                   or x.display_name ilike '%' || v_q || '%' or x.email ilike '%' || v_q || '%' or x.phone_norm like '%' || regexp_replace(v_q, '\D', '', 'g') || '%' and regexp_replace(v_q, '\D', '', 'g') <> '')))
          order by o.created_at desc limit least(greatest(p_limit, 1), 200) offset greatest(p_offset, 0)) o
    join app.profiles p on p.id = o.user_id), '[]'::jsonb);
end $$;

create or replace function public.admin_order_mark_paid(p_order uuid, p_method text, p_note text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_admin uuid; r jsonb;
begin
  v_admin := app.require_admin();
  if char_length(btrim(coalesce(p_method, ''))) < 2 then raise exception 'method_required'; end if;
  r := app.order_mark_paid(p_order, 'manual', null, null, btrim(p_method), p_note, v_admin, null);
  perform app.call_bot('dispatch');
  return r;
end $$;

create or replace function public.admin_order_cancel(p_order uuid, p_reason text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_admin uuid; o app.course_orders;
begin
  v_admin := app.require_admin();
  update app.course_orders set status = 'cancelled', cancel_reason = left(coalesce(nullif(btrim(p_reason), ''), 'Отменён администратором'), 300),
    updated_at = now()
  where id = p_order and status in ('pending', 'expired') returning * into o;
  if not found then raise exception 'not_pending'; end if;
  perform app.log_event('course_order_cancelled', 'info', o.user_id, jsonb_build_object('order_no', o.order_no, 'by', 'admin',
    'reason', o.cancel_reason), null, v_admin);
  return jsonb_build_object('ok', true);
end $$;

-- Возврат: фиксирует сумму и причину; при отзыве доступа закрывает курсы этого заказа
-- (и подарок — если ещё не активирован, он аннулируется; если активирован — доступ получателя отзывается).
create or replace function public.admin_order_refund(p_order uuid, p_amount numeric, p_reason text, p_revoke boolean) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_admin uuid; o app.course_orders; v_done numeric; a record; g app.course_gifts; v_full boolean;
begin
  v_admin := app.require_admin();
  if char_length(btrim(coalesce(p_reason, ''))) < 3 then raise exception 'reason_required'; end if;
  select * into o from app.course_orders where id = p_order for update;
  if not found then raise exception 'not_found'; end if;
  if o.status not in ('paid', 'refunded') then raise exception 'order_not_paid'; end if;
  select coalesce(sum(amount), 0) into v_done from app.course_refunds where order_id = o.id;
  if p_amount is null or p_amount <= 0 or p_amount > o.total - v_done then raise exception 'bad_amount'; end if;
  insert into app.course_refunds (order_id, amount, reason, revoke_access, created_by)
  values (o.id, p_amount, btrim(p_reason), coalesce(p_revoke, false), v_admin);
  v_full := v_done + p_amount >= o.total;
  if v_full then update app.course_orders set status = 'refunded', updated_at = now() where id = o.id; end if;
  if coalesce(p_revoke, false) then
    for a in select id from app.course_access where order_id = o.id and revoked_at is null loop
      perform app.revoke_access_row(a.id, 'Возврат по заказу № ' || o.order_no || ': ' || btrim(p_reason), v_admin);
    end loop;
    update app.course_gifts set status = 'cancelled' where order_id = o.id and status = 'issued';
  end if;
  perform app.notify_user(o.user_id, 'refund:' || o.id || ':' || (v_done + p_amount),
    'По заказу № ' || o.order_no || ' оформлен возврат ' || app.money(p_amount) || '.' ||
    case when coalesce(p_revoke, false) then E'\nДоступ к «' || o.title || '» закрыт.' else '' end ||
    E'\nСрок зачисления зависит от банка. Вопросы — по телефону клиники.', null, null, 'Возврат по заказу № ' || o.order_no);
  perform app.log_event('course_refund', 'warn', o.user_id, jsonb_build_object('order_no', o.order_no, 'amount', p_amount,
    'reason', btrim(p_reason), 'revoke', coalesce(p_revoke, false), 'full', v_full), true, v_admin);
  return jsonb_build_object('ok', true, 'full', v_full);
end $$;

create or replace function public.admin_user_courses(p_user uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v app.profiles;
begin
  perform app.require_admin();
  select * into v from app.profiles where id = p_user;
  if not found then raise exception 'not_found'; end if;
  return jsonb_build_object(
    'courses_blocked', v.courses_blocked, 'courses_block_reason', v.courses_block_reason,
    'access', coalesce((select jsonb_agg(jsonb_build_object('id', a.id, 'course_id', c.id, 'title', c.title, 'source', a.source,
        'granted_at', a.granted_at, 'expires_at', a.expires_at, 'revoked_at', a.revoked_at, 'revoke_reason', a.revoke_reason,
        'note', a.grant_note, 'order_no', (select order_no from app.course_orders o where o.id = a.order_id),
        'progress', app.course_progress(v.id, c.id)) order by a.revoked_at nulls first, a.granted_at desc)
      from app.course_access a join app.courses c on c.id = a.course_id where a.user_id = v.id), '[]'::jsonb),
    'orders', coalesce((select jsonb_agg(public.course_order_json(o) order by o.created_at desc)
      from app.course_orders o where o.user_id = v.id), '[]'::jsonb),
    'sessions', coalesce((select jsonb_agg(jsonb_build_object('started_at', s.started_at, 'last_seen_at', s.last_seen_at,
        'ended_at', s.ended_at, 'end_reason', s.end_reason, 'device', left(s.user_agent, 80), 'urls', s.urls_issued,
        'lesson', (select title from app.lessons l where l.id = s.lesson_id)) order by s.started_at desc)
      from (select * from app.playback_sessions where user_id = v.id order by started_at desc limit 10) s), '[]'::jsonb),
    'all_courses', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'title', c.title) order by c.sort, c.title)
      from app.courses c), '[]'::jsonb));
end $$;

create or replace function public.admin_access_grant(p_user uuid, p_course uuid, p_note text, p_days int default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_admin uuid; v app.profiles; c app.courses;
begin
  v_admin := app.require_admin();
  if char_length(btrim(coalesce(p_note, ''))) < 3 then raise exception 'reason_required'; end if;
  select * into v from app.profiles where id = p_user and status = 'active';
  if not found then raise exception 'user_not_active'; end if;
  select * into c from app.courses where id = p_course;
  if not found then raise exception 'not_found'; end if;
  if p_days is not null and (p_days < 1 or p_days > 3650) then raise exception 'bad_days'; end if;
  if not app.grant_access(v.id, c.id, 'manual', null, null, v_admin, btrim(p_note), p_days) then raise exception 'already_owned'; end if;
  perform app.notify_user(v.id, 'manual_access:' || v.id || ':' || c.id || ':' || extract(epoch from now())::bigint,
    'Вам открыт доступ к курсу «' || c.title || '». Он уже в разделе «Мои курсы».', 'Перейти к курсу', '/kursy/' || c.slug || '/',
    'Доступ к курсу «' || c.title || '»');
  perform app.log_event('course_access_granted', 'warn', v.id, jsonb_build_object('client_no', v.client_no, 'course', c.title,
    'note', btrim(p_note), 'days', p_days), true, v_admin);
  perform app.call_bot('dispatch');
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.admin_access_revoke(p_access uuid, p_reason text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_admin uuid; a app.course_access;
begin
  v_admin := app.require_admin();
  if char_length(btrim(coalesce(p_reason, ''))) < 3 then raise exception 'reason_required'; end if;
  select * into a from app.course_access where id = p_access and revoked_at is null;
  if not found then raise exception 'not_found'; end if;
  perform app.revoke_access_row(a.id, btrim(p_reason), v_admin);
  perform app.log_event('course_access_revoked', 'warn', a.user_id, jsonb_build_object(
    'client_no', (select client_no from app.profiles where id = a.user_id),
    'course', (select title from app.courses where id = a.course_id), 'reason', btrim(p_reason)), true, v_admin);
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.admin_courses_block(p_user uuid, p_on boolean, p_reason text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_admin uuid; v app.profiles;
begin
  v_admin := app.require_admin();
  if p_on and char_length(btrim(coalesce(p_reason, ''))) < 3 then raise exception 'reason_required'; end if;
  update app.profiles set courses_blocked = coalesce(p_on, false),
    courses_block_reason = case when p_on then left(btrim(p_reason), 300) end, updated_at = now()
  where id = p_user returning * into v;
  if not found then raise exception 'not_found'; end if;
  if p_on then
    update app.playback_sessions set ended_at = now(), end_reason = 'admin' where user_id = v.id and ended_at is null;
    perform app.notify_user(v.id, 'cblock:' || v.id || ':' || extract(epoch from now())::bigint,
      'Доступ к онлайн-курсам на вашем аккаунте приостановлен. Если считаете это ошибкой — позвоните в клинику: +7 (987) 600-00-37.',
      null, null, 'Доступ к курсам приостановлен');
  end if;
  perform app.log_event(case when p_on then 'courses_blocked' else 'courses_unblocked' end, 'warn', v.id,
    jsonb_build_object('client_no', v.client_no, 'reason', btrim(coalesce(p_reason, ''))), true, v_admin);
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.admin_session_kill(p_user uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_admin uuid; v_n int;
begin
  v_admin := app.require_admin();
  update app.playback_sessions set ended_at = now(), end_reason = 'admin' where user_id = p_user and ended_at is null;
  get diagnostics v_n = row_count;
  perform app.log_event('playback_killed', 'warn', p_user, jsonb_build_object('client_no',
    (select client_no from app.profiles where id = p_user), 'sessions', v_n), null, v_admin);
  return jsonb_build_object('ok', true, 'ended', v_n);
end $$;

create or replace function public.admin_course_analytics() returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  perform app.require_admin();
  return jsonb_build_object(
    'revenue', (select coalesce(sum(paid_amount), 0) from app.course_orders where status in ('paid', 'refunded')),
    'refunded', (select coalesce(sum(amount), 0) from app.course_refunds),
    'sales', (select count(*) from app.course_orders where status in ('paid', 'refunded') and total > 0),
    'free_orders', (select count(*) from app.course_orders where status = 'paid' and total = 0),
    'gifts', (select count(*) from app.course_orders where status = 'paid' and is_gift),
    'buyers', (select count(distinct user_id) from app.course_orders where status in ('paid', 'refunded')),
    'students', (select count(distinct user_id) from app.course_access where revoked_at is null),
    'pending', (select count(*) from app.course_orders where status = 'pending'),
    'avg_progress', (select round(avg((app.course_progress(a.user_id, a.course_id) ->> 'percent')::numeric))
                     from app.course_access a where a.revoked_at is null),
    'by_course', coalesce((select jsonb_agg(x order by (x ->> 'sales')::int desc) from (
        select jsonb_build_object('title', c.title, 'status', c.status,
          'sales', (select count(*) from app.course_orders o where o.status in ('paid', 'refunded') and o.item_type = 'course' and o.course_id = c.id),
          'revenue', (select coalesce(sum(o.paid_amount), 0) from app.course_orders o where o.status in ('paid', 'refunded') and o.item_type = 'course' and o.course_id = c.id),
          'students', (select count(*) from app.course_access a where a.course_id = c.id and a.revoked_at is null),
          'avg_progress', (select round(avg((app.course_progress(a.user_id, c.id) ->> 'percent')::numeric))
                           from app.course_access a where a.course_id = c.id and a.revoked_at is null)) x
        from app.courses c) t), '[]'::jsonb),
    'by_bundle', coalesce((select jsonb_agg(jsonb_build_object('title', b.title,
          'sales', (select count(*) from app.course_orders o where o.status in ('paid', 'refunded') and o.bundle_id = b.id),
          'revenue', (select coalesce(sum(o.paid_amount), 0) from app.course_orders o where o.status in ('paid', 'refunded') and o.bundle_id = b.id)))
        from app.bundles b), '[]'::jsonb),
    'payments', coalesce((select jsonb_agg(t.x order by t.at desc) from (
        select y.created_at as at, jsonb_build_object('at', y.created_at, 'kind', 'payment', 'amount', y.amount, 'order_no', o.order_no,
          'title', o.title, 'method', y.method, 'client_no', p.client_no) as x
        from app.course_payments y join app.course_orders o on o.id = y.order_id join app.profiles p on p.id = o.user_id
        union all
        select r.created_at, jsonb_build_object('at', r.created_at, 'kind', 'refund', 'amount', r.amount, 'order_no', o.order_no,
          'title', o.title, 'method', r.reason, 'client_no', p.client_no)
        from app.course_refunds r join app.course_orders o on o.id = r.order_id join app.profiles p on p.id = o.user_id
        order by 1 desc limit 100) t), '[]'::jsonb));
end $$;

-- ---------------------------------------------------------------------
-- Обслуживание
-- ---------------------------------------------------------------------

create or replace function app.courses_maintenance() returns void
language plpgsql security definer set search_path = '' as $$
begin
  update app.course_orders set status = 'expired', updated_at = now() where status = 'pending' and expires_at < now();
  update app.playback_sessions set ended_at = now(), end_reason = 'expired'
  where ended_at is null and last_seen_at < now() - interval '10 minutes';
  delete from app.mail_outbox where created_at < now() - interval '90 days' and status <> 'queued';
end $$;

select cron.schedule('fiziotera-courses', '17 * * * *', $$select app.courses_maintenance()$$);
select cron.schedule('fiziotera-mail', '* * * * *',
  $$select app.call_fn('courses', 'mail') where exists (select 1 from app.mail_outbox where status = 'queued' and next_try_at <= now())$$);

-- ---------------------------------------------------------------------
-- Права на функции
-- ---------------------------------------------------------------------

do $$
declare f record;
begin
  for f in
    select p.oid::regprocedure as sig, n.nspname, p.proname
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where (n.nspname = 'app' and p.proname in ('txt', 'money', 'course_has_access', 'course_stats', 'course_progress', 'course_card',
             'bundle_card', 'watermark', 'notify_user', 'call_fn', 'price_quote', 'grant_access', 'revoke_access_row', 'gen_gift_code',
             'order_mark_paid', 'tg_user', 'courses_maintenance'))
       or (n.nspname = 'public' and p.proname in ('courses_catalog', 'course_detail', 'course_quote', 'course_order_create',
             'course_order_json', 'course_order_cancel', 'my_courses', 'course_player', 'course_progress_save', 'course_heartbeat',
             'course_session_stop', 'gift_activate', 'set_course_news', 'svc_course_play', 'svc_is_admin', 'svc_lesson_set_video',
             'svc_set_cover', 'svc_claim_mail', 'svc_mail_result', 'svc_tg_profile', 'svc_order_paid_tg', 'svc_order_cancel_tg',
             'admin_courses_overview', 'admin_category_save', 'admin_category_delete', 'admin_course_get', 'admin_course_save',
             'admin_course_set_status', 'admin_lesson_save', 'admin_lesson_reorder', 'admin_lesson_delete', 'admin_bundle_save',
             'admin_bundle_set_status', 'admin_promo_save', 'admin_course_orders', 'admin_order_mark_paid', 'admin_order_cancel',
             'admin_order_refund', 'admin_user_courses', 'admin_access_grant', 'admin_access_revoke', 'admin_courses_block',
             'admin_session_kill', 'admin_course_analytics'))
  loop
    execute format('revoke all on function %s from public, anon, authenticated', f.sig);
    if f.nspname = 'public' and f.proname like 'svc\_%' then
      execute format('grant execute on function %s to service_role', f.sig);
    elsif f.nspname = 'public' and f.proname in ('courses_catalog', 'course_detail') then
      execute format('grant execute on function %s to anon, authenticated, service_role', f.sig);
    elsif f.nspname = 'public' and f.proname <> 'course_order_json' then
      execute format('grant execute on function %s to authenticated', f.sig);
    end if;
  end loop;
end $$;
