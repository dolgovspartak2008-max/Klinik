-- =====================================================================
-- Проверка сценариев онлайн-курсов прямо в базе. Всё выполняется в одной
-- транзакции и в конце откатывается (raise exception с отчётом) — данные,
-- уведомления и очереди не остаются. Запуск: выполнить файл целиком в SQL-редакторе.
-- =====================================================================
do $t$
declare
  u1 uuid := gen_random_uuid(); u2 uuid := gen_random_uuid(); u3 uuid := gen_random_uuid(); adm uuid := gen_random_uuid();
  knees uuid := '7b2e1d0f-2c3b-4d4e-9f50-000000000001'; hips uuid := '7b2e1d0f-2c3b-4d4e-9f50-000000000002';
  elbow uuid := '7b2e1d0f-2c3b-4d4e-9f50-000000000003'; bundle uuid := '9d4a3f21-4e5d-4f60-b172-000000000001';
  l1 uuid := '8c3f2e10-3d4c-4e5f-a061-000000000001'; l3 uuid := '8c3f2e10-3d4c-4e5f-a061-000000000003';
  r jsonb; q jsonb; o1 uuid; o2 uuid; s1 uuid; code text; n int; ok boolean; log text[] := '{}'; err text;
begin
  -- тестовые пользователи (профили создаёт триггер)
  insert into auth.users (id, email, aud, role, instance_id) values
    (u1, 'test1@example.test', 'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000'),
    (u2, 'test2@example.test', 'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000'),
    (u3, 'test3@example.test', 'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000'),
    (adm, 'admin@example.test', 'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000');
  update app.profiles set role = 'admin', display_name = 'Тест Админ' where id = adm;
  insert into app.telegram_identities (telegram_id, user_id) values (111000111, u1);  -- уведомления в очередь (не отправятся: откат)

  -- 0. каталог для гостя
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  r := public.courses_catalog();
  log := log || format('0 каталог: курсов %s, комплектов %s, owned=%s', jsonb_array_length(r->'courses'), jsonb_array_length(r->'bundles'),
    (r->'courses'->0->>'owned'));

  -- 1. новый пользователь покупает первый курс
  perform set_config('request.jwt.claims', json_build_object('sub', u1, 'role', 'authenticated')::text, true);
  q := public.course_quote('course', knees, null, false);
  r := public.course_order_create('course', knees, null, false, 'key-aaaaaaaa1');
  o1 := (r->'order'->>'id')::uuid;
  r := public.course_order_create('course', knees, null, false, 'key-aaaaaaaa1');
  log := log || format('1 цена %s, заказ %s, повтор с тем же ключом -> тот же заказ: %s', q->>'total', r->'order'->>'status', (r->'order'->>'id')::uuid = o1);
  -- 14. до оплаты видео не выдаётся
  r := public.svc_course_play(u1, l1, 'devAAAAAAAAAAAAAAAAA', false, null, null, 'test');
  log := log || format('14 видео до оплаты: %s', r->>'error');
  -- оплата подтверждена (дважды — повтор вебхука/двойной клик)
  r := app.order_mark_paid(o1, 'manual', null, null, 'тест', null, adm, null);
  r := app.order_mark_paid(o1, 'manual', null, null, 'тест', null, adm, null);
  select count(*) into n from app.course_access where user_id = u1 and course_id = knees and revoked_at is null;
  log := log || format('1 оплата: повтор=%s, доступов=%s, платежей=%s, уведомлений в очереди=%s', r->>'already', n,
    (select count(*) from app.course_payments where order_id = o1), (select count(*) from app.mail_outbox where dedupe_key like '%' || o1));
  -- повторная покупка того же курса
  begin perform public.course_quote('course', knees, null, false); exception when others then err := sqlerrm; end;
  log := log || ('1 повторная покупка: ' || err);

  -- 2/3/4. существующий пользователь покупает комплект, часть курсов уже есть
  q := public.course_quote('bundle', bundle, null, false);
  log := log || format('4 комплект при наличии 1 курса: список %s -> %s (%s)', q->>'list_price', q->>'total', q->>'note');
  r := public.course_order_create('bundle', bundle, null, false, 'key-bbbbbbbb1');
  r := app.order_mark_paid((r->'order'->>'id')::uuid, 'manual', null, null, 'тест', null, adm, null);
  select count(*) into n from app.course_access where user_id = u1 and revoked_at is null;
  log := log || format('3 комплект оплачен: выдано %s, всего курсов у клиента %s (без дублей)', r->>'granted', n);

  -- 5/6. промокоды
  perform set_config('request.jwt.claims', json_build_object('sub', adm, 'role', 'authenticated')::text, true);
  r := public.admin_promo_save('{"code":"TEST10","discount_type":"percent","amount":"10","max_uses":"1","per_user":"1","applies_all":true,"active":true}'::jsonb);
  r := public.admin_promo_save('{"code":"FREE100","discount_type":"percent","amount":"100","applies_all":false,"course_ids":["7b2e1d0f-2c3b-4d4e-9f50-000000000003"],"active":true}'::jsonb);
  perform set_config('request.jwt.claims', json_build_object('sub', u2, 'role', 'authenticated')::text, true);
  q := public.course_quote('course', hips, 'test10', false);
  log := log || format('5 промокод TEST10: %s - %s = %s', q->>'base_price', q->>'discount', q->>'total');
  r := public.course_order_create('course', hips, 'TEST10', false, 'key-cccccccc1');
  r := app.order_mark_paid((r->'order'->>'id')::uuid, 'manual', null, null, 'тест', null, adm, null);
  perform set_config('request.jwt.claims', json_build_object('sub', u3, 'role', 'authenticated')::text, true);
  err := null; begin perform public.course_quote('course', hips, 'TEST10', false); exception when others then err := sqlerrm; end;
  log := log || ('6 исчерпанный промокод: ' || err);
  err := null; begin perform public.course_quote('course', hips, 'NOSUCH', false); exception when others then err := sqlerrm; end;
  log := log || ('6 несуществующий промокод: ' || err);
  err := null; begin perform public.course_quote('course', hips, 'FREE100', false); exception when others then err := sqlerrm; end;
  log := log || ('6 промокод не на этот курс: ' || err);
  -- 100% промокод: доступ сразу, без оплаты
  r := public.course_order_create('course', elbow, 'FREE100', false, 'key-dddddddd1');
  log := log || format('6 промокод 100%%: статус %s, провайдер %s, доступ %s', r->'order'->>'status', r->'order'->>'provider', app.course_has_access(u3, elbow));

  -- 7/8. подарок
  perform set_config('request.jwt.claims', json_build_object('sub', u1, 'role', 'authenticated')::text, true);
  r := public.course_order_create('course', knees, null, true, 'key-eeeeeeee1');
  r := app.order_mark_paid((r->'order'->>'id')::uuid, 'manual', null, null, 'тест', null, adm, null);
  code := r->>'gift_code';
  perform set_config('request.jwt.claims', json_build_object('sub', u2, 'role', 'authenticated')::text, true);
  r := public.gift_activate(lower(code));
  log := log || format('7 подарок %s: активирован=%s, доступ у получателя=%s', code, r->>'ok', app.course_has_access(u2, knees));
  r := public.gift_activate(code);
  log := log || format('8 повторная активация тем же: %s', r->>'error');
  perform set_config('request.jwt.claims', json_build_object('sub', u3, 'role', 'authenticated')::text, true);
  r := public.gift_activate(code);
  log := log || format('8 активация другим: %s', r->>'error');
  r := public.gift_activate('FZG-AAAA-BBBB');
  log := log || format('8 неверный код: %s', r->>'error');

  -- 9. отменённый платёж / 10. подтверждение с задержкой
  r := public.course_order_create('course', knees, null, false, 'key-ffffffff1');
  o2 := (r->'order'->>'id')::uuid;
  r := public.course_order_cancel(o2);
  err := null; begin perform app.order_mark_paid(o2, 'manual', null, null, 'тест', null, adm, null); exception when others then err := sqlerrm; end;
  log := log || ('9 оплата отменённого заказа: ' || err);
  r := public.course_order_create('course', knees, null, false, 'key-gggggggg1');
  o2 := (r->'order'->>'id')::uuid;
  update app.course_orders set expires_at = now() - interval '1 hour' where id = o2;
  perform app.courses_maintenance();
  r := app.order_mark_paid(o2, 'yookassa', 'pay-test-1', 1490, 'тест', null, null, null);
  log := log || format('10 оплата просроченного заказа: ok=%s, доступ=%s', r->>'ok', app.course_has_access(u3, knees));
  -- 11/12. повтор платежа провайдера, неверная сумма
  r := app.order_mark_paid(o2, 'yookassa', 'pay-test-1', 1490, 'тест', null, null, null);
  log := log || format('11 повтор уведомления: already=%s, платежей=%s', r->>'already', (select count(*) from app.course_payments where order_id = o2));
  perform set_config('request.jwt.claims', json_build_object('sub', u3, 'role', 'authenticated')::text, true);
  r := public.course_order_create('course', hips, null, false, 'key-hhhhhhhh1');
  r := app.order_mark_paid((r->'order'->>'id')::uuid, 'yookassa', 'pay-test-2', 1, 'тест', null, null, null);
  log := log || format('12 сумма не совпала: %s, доступ=%s', r->>'error', app.course_has_access(u3, hips));

  -- 13. возврат с закрытием доступа
  perform set_config('request.jwt.claims', json_build_object('sub', adm, 'role', 'authenticated')::text, true);
  r := public.admin_order_refund(o2, 1490, 'тестовый возврат', true);
  log := log || format('13 возврат: полный=%s, доступ после=%s, статус=%s', r->>'full', app.course_has_access(u3, knees),
    (select status from app.course_orders where id = o2));
  err := null; begin perform public.admin_order_refund(o2, 10, 'ещё раз', true); exception when others then err := sqlerrm; end;
  log := log || ('13 повторный возврат сверх суммы: ' || err);

  -- 15. чужой курс
  r := public.svc_course_play(u3, l3, 'devCCCCCCCCCCCCCCCCC', false, null, null, 'test');
  log := log || format('15 урок чужого курса: %s', r->>'error');
  perform set_config('request.jwt.claims', json_build_object('sub', u3, 'role', 'authenticated')::text, true);
  r := public.course_player('tazobedrennye-sustavy');
  log := log || format('15 плеер без покупки: access=%s, can_watch=%s', r->>'access', r->'lessons'->0->>'can_watch');

  -- 16/17. одна сессия просмотра, переключение устройств
  r := public.svc_course_play(u1, l1, 'devPHONEAAAAAAAAAAAA', false, null, null, 'phone');
  s1 := (r->>'session_id')::uuid;
  r := public.svc_course_play(u1, l1, 'devLAPTOPAAAAAAAAAAA', false, null, null, 'laptop');
  log := log || format('16 второе устройство: %s', r->>'error');
  r := public.svc_course_play(u1, l1, 'devLAPTOPAAAAAAAAAAA', true, null, null, 'laptop');
  perform set_config('request.jwt.claims', json_build_object('sub', u1, 'role', 'authenticated')::text, true);
  q := public.course_heartbeat(s1);
  log := log || format('17 перенос на ноутбук: новая сессия=%s, старая -> %s', r->>'ok', q->>'reason');

  -- 18. прогресс
  r := public.course_progress_save(l1, 40, 78, false);
  r := public.course_progress_save(l1, 72, 78, false);
  log := log || format('18 прогресс: урок пройден=%s, по курсу %s%%', r->>'completed', r->'progress'->>'percent');
  r := public.course_player('kolennye-sustavy');
  log := log || format('18 восстановление позиции: %s сек, последний урок совпадает=%s', r->'lessons'->0->>'position_sec',
    (r->'progress'->>'last_lesson_id')::uuid = l1);

  -- 21/22. админ добавляет урок, снимает курс с продажи
  perform set_config('request.jwt.claims', json_build_object('sub', adm, 'role', 'authenticated')::text, true);
  r := public.admin_lesson_save(jsonb_build_object('course_id', knees, 'title', 'Тестовый урок'));
  err := null; begin perform public.admin_lesson_save(jsonb_build_object('id', r->>'id', 'title', 'Тестовый урок', 'hidden', false)); exception when others then err := sqlerrm; end;
  log := log || ('21 публикация урока без видео: ' || err);
  update app.lessons set video_path = 'lessons/' || (r->>'id') || '/testtesttest.mp4' where id = (r->>'id')::uuid;
  perform public.admin_lesson_save(jsonb_build_object('id', r->>'id', 'title', 'Тестовый урок', 'hidden', false));
  log := log || format('21 урок опубликован, уведомлений ученикам в очереди: %s', (select count(*) from app.tg_outbox where dedupe_key like 'tg:new_lesson:' || (r->>'id') || '%'));
  r := public.admin_course_set_status(knees, 'archived');
  perform set_config('request.jwt.claims', json_build_object('sub', u1, 'role', 'authenticated')::text, true);
  log := log || format('22 снят с продажи: в каталоге=%s, у купившего доступ=%s, страница открывается=%s',
    (select count(*) from jsonb_array_elements(public.courses_catalog()->'courses') x where x->>'slug' = 'kolennye-sustavy'),
    app.course_has_access(u1, knees), (public.course_detail('kolennye-sustavy')->>'title') is not null);
  perform set_config('request.jwt.claims', json_build_object('sub', u2, 'role', 'authenticated')::text, true);
  err := null; begin perform public.course_quote('course', knees, null, true); exception when others then err := sqlerrm; end;
  log := log || ('22 покупка снятого курса: ' || err);

  -- безопасность: обычный пользователь не может вызвать админ-функции
  err := null; begin perform public.admin_order_mark_paid(o1, 'взлом', null); exception when others then err := sqlerrm; end;
  log := log || ('sec: админ-функция от клиента: ' || err);
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  err := null; begin perform public.my_courses(); exception when others then err := sqlerrm; end;
  log := log || ('sec: «Мои курсы» без входа: ' || err);

  raise exception E'ROLLBACK_REPORT\n%', array_to_string(log, E'\n');
end $t$;
