-- =====================================================================
-- Фоновые задачи: уведомления в Telegram и обслуживание.
-- События сначала сохраняются в app.events (даже если Telegram недоступен),
-- затем функция tg-bot отправляет их администраторам. Неотправленные
-- повторяются раз в минуту (до 8 попыток).
--
-- Нужные секреты в Supabase Vault (vault.create_secret):
--   telegram_bot_token  — токен бота
--   telegram_webhook    — секрет вебхука Telegram (случайная строка)
--   internal_secret     — секрет для вызова tg-bot из базы (случайная строка)
--   functions_url       — https://<project-ref>.supabase.co/functions/v1
-- =====================================================================

create extension if not exists pg_net;
create extension if not exists pg_cron;

create or replace function app.call_bot(p_task text) returns void
language plpgsql security definer set search_path = '' as $$
declare v_url text; v_secret text;
begin
  select decrypted_secret into v_url from vault.decrypted_secrets where name = 'functions_url';
  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'internal_secret';
  if v_url is null or v_secret is null then return; end if;
  perform net.http_post(
    url := v_url || '/tg-bot?task=' || p_task,
    body := '{}'::jsonb,
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-internal-secret', v_secret),
    timeout_milliseconds := 15000);
exception when others then
  -- уведомление не должно ломать основную операцию; событие уже сохранено
  null;
end $$;

create or replace function app.events_notify_trigger() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if exists (select 1 from new_rows where notify) then
    perform app.call_bot('dispatch');
  end if;
  return null;
end $$;

drop trigger if exists events_notify on app.events;
create trigger events_notify after insert on app.events
  referencing new table as new_rows
  for each statement execute function app.events_notify_trigger();

revoke all on function app.call_bot(text) from public, anon, authenticated;
revoke all on function app.events_notify_trigger() from public, anon, authenticated;

select cron.schedule('fiziotera-dispatch', '* * * * *', $$select app.call_bot('dispatch')$$);
select cron.schedule('fiziotera-expire', '7 * * * *', $$select app.expire_bonuses()$$);
