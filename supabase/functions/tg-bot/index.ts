// Физиотера — Telegram-бот (Supabase Edge Function).
//
//   POST /tg-bot                    — вебхук Telegram (проверка X-Telegram-Bot-Api-Secret-Token)
//   POST /tg-bot?task=dispatch      — отправить накопившиеся уведомления администраторам и очередь сообщений
//                                     клиентам (рассылки, персональные скидки) — вызывает база, x-internal-secret
//   POST /tg-bot?task=setup         — зарегистрировать вебхук и команды (x-internal-secret)
//
// Клиентам: /profile (профиль как в личном кабинете), /mycourses (купленные курсы и прогресс,
// кнопка ведёт на защищённую страницу уроков на сайте). Видео в Telegram не отправляются, курсы в боте
// не продаются (цифровые товары в Telegram — только через Telegram Stars; оплата — на сайте).
//
// Доступ к служебным командам — только у Telegram ID из app.admin_telegram_ids.
// Токен бота и секреты читаются из Supabase Vault.

import { createClient } from "npm:@supabase/supabase-js@2.49.4";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

const TZ = "Asia/Yekaterinburg";
const cache: Record<string, string | null> = {};

async function secret(name: string): Promise<string | null> {
  if (name in cache) return cache[name];
  const { data, error } = await db.rpc("svc_secret", { p_name: name });
  if (error) throw error;
  cache[name] = (data as string | null) ?? null;
  return cache[name];
}

function safeEqual(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

function esc(v: unknown): string {
  return String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Intl.DateTimeFormat("ru-RU", {
    timeZone: TZ, day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit",
  }).format(new Date(iso));
}

function discount(type: unknown, amount: unknown): string {
  const n = Number(amount);
  if (!type || !isFinite(n)) return "—";
  const v = n % 1 === 0 ? n.toFixed(0) : n.toFixed(2);
  return type === "percent" ? `${v}%` : `${Number(v).toLocaleString("ru-RU")} ₽`;
}

const KIND: Record<string, string> = {
  welcome: "Приветственный бонус",
  referral_invitee: "Скидка по приглашению",
  referrer_reward: "Награда за друга",
  manual: "Персональная скидка",
};
const COURSE_STATUS: Record<string, string> = { draft: "черновик", published: "в продаже", archived: "снят с продажи" };
const ORDER_STATUS: Record<string, string> = { pending: "ждёт оплаты", paid: "оплачен", expired: "истёк срок оплаты", refunded: "возврат", cancelled: "отменён" };

function money(v: unknown): string {
  const n = Number(v);
  return isFinite(n) ? `${Math.round(n).toLocaleString("ru-RU")} ₽` : "—";
}

const STATUS: Record<string, string> = {
  available: "доступен", pending: "ожидает подтверждения", used: "использован",
  expired: "истёк", cancelled: "отменён", confirmed: "подтверждён", refunded: "возврат",
  registered: "зарегистрирован", qualified: "получил услугу",
};
const ERR: Record<string, string> = {
  not_found: "не найдено", not_pending: "запрос уже обработан", not_confirmed: "услуга не была подтверждена",
  bonus_cancelled: "бонус отменён", forbidden: "нет доступа",
  owner_only: "выдавать и снимать права может только владелец", no_telegram: "у этого клиента не привязан Telegram — пусть войдёт на сайт через Telegram",
  user_not_active: "аккаунт клиента заблокирован или удалён", already_admin: "уже администратор", not_admin: "не администратор",
  last_owner: "нельзя снять последнего владельца", bad_target: "укажите номер клиента или Telegram ID",
  order_not_payable: "заказ отменён — оплату по нему не принять", amount_mismatch: "сумма не совпадает",
};

// ------------------------------------------------------------------ Telegram API

async function tg(method: string, payload: Record<string, unknown>) {
  const token = await secret("telegram_bot_token");
  if (!token) throw new Error("telegram token missing");
  const r = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const j = await r.json().catch(() => ({}));
  return { ok: r.ok && j.ok, status: r.status, result: j.result, retryAfter: j?.parameters?.retry_after, description: j.description };
}

function send(chatId: number, text: string, extra: Record<string, unknown> = {}) {
  return tg("sendMessage", { chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true, ...extra });
}

// ------------------------------------------------------------------ Уведомления

type Ev = {
  id: number; type: string; severity: string; data: Record<string, any>; created_at: string; actor_tg: number | null;
  user: { client_no: number; name: string | null; email: string | null; ref_code: string } | null;
};

function who(ev: Ev): string {
  const u = ev.user;
  if (!u) return "";
  return `Пользователь: ${esc(u.name || "без имени")}\nID пользователя: ${u.client_no}\n`;
}

function formatEvent(ev: Ev): string {
  const d = ev.data || {};
  const date = `Дата: ${fmtDate(ev.created_at)}`;
  const by = ev.actor_tg ? `\nДействие: через Telegram (${ev.actor_tg})` : "";
  const icon = ev.severity === "alert" ? "🚨" : ev.severity === "warn" ? "⚠️" : ev.severity === "error" ? "❌" : "🔔";
  switch (ev.type) {
    case "user_registered": {
      const inv = d.invited_with
        ? `\nПриглашён по коду: ${esc(d.invited_with)} — ${d.invite_result?.ok ? "применён" : "не применён (" + esc(d.invite_result?.error) + ")"}`
        : "";
      return `🔔 <b>Новая регистрация</b>\n\n${who(ev)}Способ регистрации: ${d.method === "telegram" ? "Telegram" : "Email"}\n` +
        `${date}\nРеферальный код: ${esc(d.ref_code)}${inv}\n` +
        `Приветственный бонус: ${d.welcome ? "выдан" : "не выдан (условия не включены)"}\nСтатус: Аккаунт создан`;
    }
    case "telegram_login":
      return `🔑 <b>Вход через Telegram</b>\n\n${who(ev)}Telegram: ${d.tg_username ? "@" + esc(d.tg_username) : "—"}\n${date}`;
    case "telegram_linked":
      return `🔗 <b>Telegram привязан к аккаунту</b>\n\n${who(ev)}Telegram: ${d.tg_username ? "@" + esc(d.tg_username) : "—"}${d.admin ? "\nЭто администратор — открыт доступ к админ-панели" : ""}\n${date}`;
    case "telegram_link_conflict":
      return `⚠️ <b>Попытка привязать чужой Telegram</b>\n\n${who(ev)}Telegram уже привязан к клиенту № ${esc(d.owner_no)}\n${date}`;
    case "referral_applied":
      return `${d.same_network ? "⚠️" : "🎟"} <b>Применён промокод друга</b>\n\n${who(ev)}Промокод: ${esc(d.code)}\n` +
        `Пригласил: ${esc(d.referrer_name)} (№ ${esc(d.referrer_no)})\n` +
        `Скидка приглашённому: ${d.bonus === "available" ? "доступна" : "не выдана (условия не включены)"}` +
        `${d.same_network ? "\n⚠️ Регистрация из той же сети, что и у пригласившего (не повод блокировать — проверьте при визите)" : ""}\n${date}`;
    case "ref_link_click":
      return `👀 <b>Переход по реферальной ссылке</b>\n\nПромокод: ${esc(d.code)}\n${date}`;
    case "self_referral_attempt":
      return `⚠️ <b>Попытка применить собственный промокод</b>\n\n${who(ev)}Промокод: ${esc(d.code)}\n${date}`;
    case "self_referral_suspected":
      return `🚨 <b>Похоже на приглашение самого себя</b>\n\n${who(ev)}Промокод: ${esc(d.code)}\nПричина: телефон совпадает с телефоном пригласившего\nСкидка не выдана\n${date}`;
    case "repeat_referral_attempt":
      return `⚠️ <b>Повторная попытка ввести промокод</b>\n\n${who(ev)}Промокод: ${esc(d.code)}\nУ клиента уже есть пригласивший\n${date}`;
    case "duplicate_bonus_attempt":
      return `🚨 <b>Попытка повторно получить бонус</b>\n\n${who(ev)}Бонус: ${esc(KIND[d.kind] || d.kind)}\nТелефон: ${esc(d.phone)}\n` +
        `${d.other_client_no ? `Этот телефон уже использован клиентом № ${esc(d.other_client_no)}\n` : ""}Скидка не выдана\n${date}`;
    case "duplicate_phone":
      return `⚠️ <b>Телефон уже есть у другого аккаунта</b>\n\n${who(ev)}Телефон: ${esc(d.phone)}\n${date}`;
    case "suspicious_signups":
      return `⚠️ <b>Много регистраций из одной сети</b>\n\n${who(ev)}За сутки: ${esc(d.count_24h)}\nЭто может быть семья или офис — проверьте при визите\n${date}`;
    case "bonus_requested":
      return `🧾 <b>Запрос на использование скидки</b>\n\n${who(ev)}Телефон: ${esc(d.phone)}\nБонус: ${esc(d.bonus)} — ${discount(d.discount_type, d.amount)}\n` +
        `Услуга: ${esc(d.service)}${d.invited_by ? `\nПриглашён по коду: ${esc(d.invited_by)}` : ""}\nСтатус: ожидает подтверждения\n${date}\n\n` +
        `Подтвердите после оказания услуги — кнопки ниже или /pending`;
    case "bonus_confirmed":
      return `✅ <b>Скидка подтверждена</b>\n\n${who(ev)}Бонус: ${esc(d.bonus)} — ${discount(d.discount_type, d.amount)}\nУслуга: ${esc(d.service)}\n${date}${by}`;
    case "bonus_request_cancelled":
      return `↩️ <b>Запрос на скидку отменён</b>\n\n${who(ev)}Бонус: ${esc(d.bonus)}\nКем: ${d.by === "client" ? "клиентом" : "администратором"}${d.note ? `\nКомментарий: ${esc(d.note)}` : ""}\nБонус снова доступен\n${date}${by}`;
    case "bonus_refunded":
      return `↩️ <b>Возврат за услугу со скидкой</b>\n\n${who(ev)}Бонус: ${esc(d.bonus)} — отменён${d.note ? `\nКомментарий: ${esc(d.note)}` : ""}\nНаграда пригласившему (если была) отменена\n${date}${by}`;
    case "bonus_cancelled":
      return `🚫 <b>Бонус отменён администратором</b>\n\n${who(ev)}Бонус: ${esc(d.bonus)}\nПричина: ${esc(d.reason || "—")}\n${date}${by}`;
    case "bonus_granted":
      return `🎁 <b>Начислена персональная скидка</b>\n\n${who(ev)}«${esc(d.title)}»: ${discount(d.discount_type, d.amount)} на ${esc(d.valid_days)} дн.\n` +
        `${d.note ? `Комментарий: ${esc(d.note)}\n` : ""}Клиенту в Telegram: ${d.client_notified ? "отправлено" : "не отправлено (Telegram не привязан или выключено)"}\n` +
        `Начислил: ${esc(d.by_name || "администратор")}\n${date}${by}`;
    case "broadcast_sent":
      return `📣 <b>Запущена рассылка</b>\n\nПолучателей: ${esc(d.recipients)}\nАвтор: ${esc(d.by_name || "администратор")}\n\n«${esc(d.preview)}${String(d.preview || "").length >= 120 ? "…" : ""}»\n${date}`;
    case "bonus_issued":
      return `🎁 <b>Начислен бонус</b>\n\n${who(ev)}${esc(KIND[d.kind] || d.title)}: ${discount(d.discount_type, d.amount)}\n${date}`;
    case "referral_qualified":
      return `🤝 <b>Приглашённый клиент получил услугу</b>\n\nПромокод: ${esc(d.code)}\nПригласивший: № ${esc(d.referrer_no)}\nПриглашённый: № ${esc(d.invitee_no)}\n` +
        `Награда пригласившему: ${d.reward === "issued" ? "начислена" : "выключена"}\n${date}`;
    case "reward_used_before_refund":
      return `🚨 <b>Награда за друга уже использована, а у друга — возврат</b>\n\nПригласивший: № ${esc(d.referrer_no)}\nПриглашённый: № ${esc(d.invitee_no)}\nРешите вручную\n${date}`;
    case "user_blocked":
    case "user_unblocked":
      return `${ev.type === "user_blocked" ? "⛔️ <b>Аккаунт заблокирован</b>" : "✅ <b>Аккаунт разблокирован</b>"}\n\n${who(ev)}Причина: ${esc(d.reason || "—")}\n${date}${by}`;
    case "user_deleted":
      return `🗑 <b>Клиент удалил аккаунт</b>\n\nID пользователя: ${esc(d.client_no)}\nПраво на подарки не восстанавливается\n${date}`;
    case "rules_changed": {
      const a = d.after || {};
      return `⚙️ <b>Изменены условия: ${esc(d.title)}</b>\n\nВключено: ${a.enabled ? "да" : "нет"}\nСкидка: ${discount(a.discount_type, a.amount)}\n` +
        `Услуги: ${a.all_services ? "все" : esc((a.service_ids || []).length + " шт.")}\nСрок: ${a.valid_days ? esc(a.valid_days) + " дн." : "—"}\n` +
        `Использований: ${esc(a.max_uses)}\nСовмещение с акциями: ${a.stackable ? "да" : "нет"}\n${date}${by}`;
    }
    case "settings_changed":
      return `⚙️ <b>Изменены настройки программы</b>\n\nРеферальная программа: ${d.referral_enabled?.[1] ? "включена" : "выключена"}\n` +
        `Расширенная диагностика: ${d.diagnostics?.[1] ? "включена" : "выключена"}\n${date}${by}`;
    case "service_toggled":
      return `⚙️ <b>Услуга ${d.active ? "включена в" : "исключена из"} программы</b>\n\n${esc(d.service)}\n${date}${by}`;
    case "login_bruteforce":
      return `🚨 <b>Много неудачных попыток входа</b>\n\nEmail: ${esc(d.email_hint)}\nВход временно ограничен на 15 минут\n${date}`;
    case "blocked_login_attempt":
      return `⛔️ <b>Попытка входа в заблокированный аккаунт</b>\n\n${who(ev)}${d.email_hint ? `Email: ${esc(d.email_hint)}\n` : ""}${date}`;
    case "admin_granted":
    case "admin_revoked":
      return `${ev.type === "admin_granted" ? "🛡 <b>Выданы права администратора</b>" : "🚫 <b>Сняты права администратора</b>"}\n\n` +
        `${personLine(d)}\nКем: Telegram ID ${esc(d.by_tg)}\n${date}`;
    case "course_order_created":
      return `🛒 <b>Новый заказ курса № ${esc(d.order_no)}</b>\n\n${who(ev)}Курс: ${esc(d.title)}${d.gift ? " (в подарок)" : ""}\n` +
        `Сумма: ${money(d.total)}${Number(d.discount) ? ` (скидка ${money(d.discount)}${d.promo ? ", промокод " + esc(d.promo) : ""})` : ""}\n` +
        `Телефон: ${esc(d.phone || "—")}\nEmail: ${esc(d.email || "—")}\nTelegram: ${d.telegram ? "@" + esc(d.telegram) : "—"}\n${date}\n\n` +
        `Свяжитесь с клиентом для оплаты. Когда деньги получены — нажмите «Оплата получена», доступ откроется автоматически.`;
    case "course_order_paid":
      return `✅ <b>Заказ курса № ${esc(d.order_no)} оплачен</b>\n\n${who(ev)}${esc(d.title)} — ${money(d.total)}\n` +
        `Способ: ${esc(d.method || d.provider)}${d.gift ? "\nПодарок: клиенту отправлен подарочный код" : `\nВыдано курсов: ${esc(d.granted)}`}\n${date}${by}`;
    case "course_refund":
      return `↩️ <b>Возврат за курс</b>\n\n${who(ev)}Заказ № ${esc(d.order_no)}: ${money(d.amount)}${d.full ? " (полный)" : ""}\nПричина: ${esc(d.reason)}\n` +
        `Доступ: ${d.revoke ? "закрыт" : "оставлен"}\n${date}${by}`;
    case "course_access_granted":
      return `🎓 <b>Курс выдан вручную</b>\n\n${who(ev)}Курс: ${esc(d.course)}\nПричина: ${esc(d.note)}\n${date}${by}`;
    case "course_access_revoked":
      return `🚫 <b>Доступ к курсу отозван</b>\n\n${who(ev)}Курс: ${esc(d.course)}\nПричина: ${esc(d.reason)}\n${date}${by}`;
    case "courses_blocked":
    case "courses_unblocked":
      return `${ev.type === "courses_blocked" ? "⛔️ <b>Клиенту заблокированы курсы</b>" : "✅ <b>Клиенту разблокированы курсы</b>"}\n\n${who(ev)}${d.reason ? "Причина: " + esc(d.reason) + "\n" : ""}${date}${by}`;
    case "gift_activated":
      return `🎁 <b>Активирован подарочный курс</b>\n\n${who(ev)}${esc(d.title)}\nКупил: клиент № ${esc(d.buyer_no)}\n${date}`;
    case "gift_reuse_attempt":
      return `⚠️ <b>Попытка активировать уже использованный подарок</b>\n\n${who(ev)}${esc(d.title)}\n${date}`;
    case "gift_bruteforce":
      return `🚨 <b>Перебор подарочных кодов</b>\n\n${who(ev)}Активация подарков для аккаунта временно ограничена\n${date}`;
    case "video_url_flood":
      return `🚨 <b>Подозрительно много запросов видео</b>\n\n${who(ev)}Урок: ${esc(d.lesson)}\nВозможна попытка выкачать видео — проверьте карточку клиента в админке (просмотры, устройства)\n${date}`;
    case "many_devices":
      return `⚠️ <b>Курсы смотрят с многих устройств</b>\n\n${who(ev)}Устройств за сутки: ${esc(d.devices_24h)}\nВозможна передача доступа другим людям\n${date}`;
    case "payment_amount_mismatch":
      return `🚨 <b>Сумма оплаты не совпала с заказом</b>\n\nЗаказ № ${esc(d.order_no)}: ожидалось ${money(d.expected)}, пришло ${money(d.got)}\nДоступ не выдан\n${date}`;
    case "course_price_changed":
      return `💰 <b>Изменена цена</b>\n\n${esc(d.course)}: ${money(d.before)} → ${money(d.after)}${d.old_price ? ` (старая цена ${money(d.old_price)})` : ""}\n${date}`;
    case "course_status_changed":
      return `📚 <b>${esc(d.course)}</b>: ${esc(COURSE_STATUS[d.before] || d.before)} → ${esc(COURSE_STATUS[d.after] || d.after)}\n${date}`;
    case "lesson_published":
      return `🎬 <b>Опубликован новый урок</b>\n\n${esc(d.course)}: «${esc(d.lesson)}»\nУчеников курса: ${esc(d.students)} — им отправлено уведомление\n${date}`;
    case "course_promo_saved":
      return `🏷 <b>Промокод на курсы сохранён</b>\n\n${esc(d.code)} — ${esc(d.discount)}\n${date}`;
    case "system_error":
      return `❌ <b>Ошибка в работе системы</b>\n\nГде: ${esc(d.where)}\n${esc(d.message)}\n${date}`;
    default: {
      const lines = Object.entries(d).slice(0, 8).map(([k, v]) => `${esc(k)}: ${esc(typeof v === "object" ? JSON.stringify(v) : v)}`).join("\n");
      return `${icon} <b>${esc(ev.type)}</b>\n\n${who(ev)}${lines}\n${date}`;
    }
  }
}

function eventButtons(ev: Ev) {
  if (ev.type === "bonus_requested" && ev.data?.redemption_id) {
    return { reply_markup: { inline_keyboard: [[
      { text: "✅ Услуга оказана", callback_data: `rd:${ev.data.redemption_id}:c` },
      { text: "✖️ Не состоялась", callback_data: `rd:${ev.data.redemption_id}:x` },
    ]] } };
  }
  if (ev.type === "course_order_created" && ev.data?.order_id) {
    return { reply_markup: { inline_keyboard: [[
      { text: "✅ Оплата получена", callback_data: `co:${ev.data.order_id}:p` },
      { text: "✖️ Отменить заказ", callback_data: `co:${ev.data.order_id}:x` },
    ]] } };
  }
  return {};
}

async function dispatch(): Promise<Record<string, unknown>> {
  const { data: chatsData } = await db.rpc("svc_admin_chats");
  const chats = (chatsData || []) as number[];
  let sent = 0, failed = 0;
  for (let round = 0; round < 3; round++) {
    const { data, error } = await db.rpc("svc_claim_notifications", { p_limit: 20 });
    if (error) throw error;
    const events = (data || []) as Ev[];
    if (!events.length) break;
    for (const ev of events) {
      const text = formatEvent(ev);
      let delivered = false;
      let lastErr = "";
      for (const chat of chats) {
        const r = await send(chat, text, eventButtons(ev));
        if (r.ok) delivered = true;
        else {
          lastErr = `${r.status} ${r.description || ""}`;
          if (r.retryAfter) await new Promise((res) => setTimeout(res, Math.min(r.retryAfter, 5) * 1000));
        }
      }
      await db.rpc("svc_mark_notified", { p_ids: [ev.id], p_ok: delivered, p_error: delivered ? null : lastErr || "no admin chats" });
      delivered ? sent++ : failed++;
    }
  }
  const out = await sendOutbox(Date.now() + 25_000);
  return { ok: true, sent, failed, outbox: out };
}

// ------------------------------------------------------------------ Сообщения клиентам (очередь app.tg_outbox)

type Out = { id: number; telegram_id: number; kind: string; text: string; button_text: string | null; button_url: string | null };

const NEWS_FOOTER = "\n\n—\nВы получили это сообщение, потому что включили новости клиники. Отписаться: /stop";

async function sendOutbox(deadline: number): Promise<{ sent: number; failed: number }> {
  let sent = 0, failed = 0;
  while (Date.now() < deadline) {
    const { data, error } = await db.rpc("svc_claim_outbox", { p_limit: 25 });
    if (error) throw error;
    const items = (data || []) as Out[];
    if (!items.length) break;
    for (const m of items) {
      if (Date.now() > deadline) {
        // не успели — вернём в очередь без штрафа по времени
        await db.rpc("svc_outbox_result", { p_id: m.id, p_result: "retry", p_error: "deferred", p_wait: 5 });
        continue;
      }
      const text = esc(m.text) + (m.kind === "broadcast" ? esc(NEWS_FOOTER) : m.kind === "test" ? "\n\n<i>Это проверочная отправка — видите её только вы.</i>" : "");
      const extra = m.button_text && m.button_url
        ? { reply_markup: { inline_keyboard: [[{ text: m.button_text, url: m.button_url }]] } } : {};
      const r = await send(m.telegram_id, text, extra);
      let result = "sent", wait = 0;
      if (!r.ok) {
        const desc = String(r.description || "");
        if (r.status === 429) { result = "retry"; wait = Number(r.retryAfter) || 30; }
        else if (r.status === 403 || /blocked|deactivated|chat not found/i.test(desc)) result = "blocked";
        else if (r.status >= 500 || r.status === 0) { result = "retry"; wait = 60; }
        else result = "failed";
      }
      await db.rpc("svc_outbox_result", { p_id: m.id, p_result: result, p_error: r.ok ? null : `${r.status} ${r.description || ""}`, p_wait: wait });
      if (result === "sent") sent++; else if (result !== "retry") failed++;
      if (r.status === 429) {
        // Telegram просит подождать — вернём остальное в очередь и продолжим при следующем запуске
        for (const rest of items.slice(items.indexOf(m) + 1)) {
          await db.rpc("svc_outbox_result", { p_id: rest.id, p_result: "retry", p_error: "rate limited", p_wait: wait });
        }
        return { sent, failed };
      }
      await new Promise((res) => setTimeout(res, 45)); // не больше ~20 сообщений в секунду
    }
  }
  return { sent, failed };
}

// ------------------------------------------------------------------ Меню команд администратора

const ADMIN_COMMANDS = [
  ["help", "Список команд"], ["profile", "Мой профиль"], ["mycourses", "Мои курсы"], ["stats", "Статистика"], ["pending", "Ожидают подтверждения"],
  ["users", "Поиск клиентов: /users Анна"], ["user", "Клиент по номеру: /user 1042"],
  ["codes", "Лучшие пригласившие"], ["suspicious", "Подозрительные действия"],
  ["rules", "Условия скидок"], ["program", "Программа: /program on|off"], ["diag", "Диагностика: /diag on|off"],
  ["admins", "Администраторы"], ["addadmin", "Выдать права: /addadmin 1042"], ["removeadmin", "Снять права: /removeadmin 1042"],
].map(([command, description]) => ({ command, description }));

// Показать (или убрать) служебные команды в меню конкретного чата
function adminMenu(chatId: number, on: boolean) {
  return on
    ? tg("setMyCommands", { commands: ADMIN_COMMANDS, scope: { type: "chat", chat_id: chatId } })
    : tg("deleteMyCommands", { scope: { type: "chat", chat_id: chatId } });
}

// Строка о человеке: имя, номер клиента, Telegram
function personLine(p: any): string {
  const name = p?.name || p?.first_name || "без имени";
  return `👤 ${esc(name)}${p?.client_no ? ` · клиент № ${p.client_no}` : " · аккаунта на сайте нет"}\n` +
    `Telegram: ${p?.username ? "@" + esc(p.username) + " · " : ""}<code>${esc(p?.telegram_id)}</code>`;
}

async function manage(tgId: number, action: string, args: Record<string, unknown> = {}) {
  const { data, error } = await db.rpc("svc_admin_manage", { p_tg: tgId, p_action: action, p_args: args });
  if (error) throw new Error(error.message);
  return data as any;
}

// ------------------------------------------------------------------ Настройка вебхука

async function setup() {
  const base = await secret("functions_url");
  const hook = await secret("telegram_webhook");
  if (!base || !hook) throw new Error("functions_url / telegram_webhook missing");
  const me = await tg("getMe", {});
  if (me.ok && me.result?.username) await db.rpc("svc_set_bot_username", { p_username: me.result.username });
  const wh = await tg("setWebhook", {
    url: `${base}/tg-bot`, secret_token: hook, allowed_updates: ["message", "callback_query"],
    drop_pending_updates: true, max_connections: 10,
  });
  await tg("setMyCommands", { commands: [{ command: "start", description: "Начать" }, ...CLIENT_COMMANDS] });
  const { data: chatsData } = await db.rpc("svc_admin_chats");
  const scoped: Record<string, unknown> = {};
  for (const chat of (chatsData || []) as number[]) {
    const r = await adminMenu(chat, true);
    scoped[String(chat)] = r.ok ? "ok" : r.description;
  }
  return { ok: wh.ok, bot: me.result?.username, webhook: wh.description, admin_commands: scoped };
}

// ------------------------------------------------------------------ Клиент: профиль и курсы

const CLIENT_COMMANDS = [
  { command: "profile", description: "Мой профиль" },
  { command: "mycourses", description: "Мои курсы" },
  { command: "news", description: "Подписаться на новости" },
  { command: "stop", description: "Отписаться от новостей" },
];

const MENU = (site: string) => ({ reply_markup: { inline_keyboard: [
  [{ text: "👤 Мой профиль", callback_data: "m:profile" }, { text: "🎓 Мои курсы", callback_data: "m:courses" }],
  [{ text: "📚 Каталог курсов", url: `${site}/kursy/` }],
] } });

async function siteUrl(): Promise<string> {
  const s = (await db.rpc("svc_settings")).data as { site_url?: string } | null;
  return (s?.site_url || "https://www.fiziotera.online").replace(/\/+$/, "");
}

type Profile = {
  client_no: number; name: string | null; email: string | null; phone: string | null; status: string; courses_blocked: boolean;
  created_at: string; ref_code: string; news_opt_in: boolean; course_news: boolean; invites: number;
  bonuses: { title: string; discount_type: string; amount: number; status: string; expires_at: string }[];
  courses: { title: string; slug: string; progress: { percent: number; completed: number; total: number } }[];
  orders: { order_no: number; title: string; total: number; status: string; created_at: string; is_gift: boolean }[];
};

async function clientProfile(tgId: number): Promise<Profile | null> {
  const { data, error } = await db.rpc("svc_tg_profile", { p_tg: tgId });
  if (error) throw new Error(error.message);
  return data as Profile | null;
}

function notLinked(chatId: number, site: string) {
  return send(chatId,
    "Этот Telegram пока не привязан к личному кабинету.\n\nОткройте сайт, нажмите «Войти» → «Войти через Telegram» и подтвердите вход здесь, в боте. После этого профиль и купленные курсы появятся в боте.",
    { reply_markup: { inline_keyboard: [[{ text: "Открыть сайт", url: `${site}/kabinet/` }]] } });
}

function bar(p: number): string {
  const n = Math.max(0, Math.min(10, Math.round((p || 0) / 10)));
  return "▓".repeat(n) + "░".repeat(10 - n);
}

async function showProfile(chatId: number, tgId: number) {
  const site = await siteUrl();
  const p = await clientProfile(tgId);
  if (!p) return notLinked(chatId, site);
  const state = p.status !== "active" ? "заблокирован" : p.courses_blocked ? "активен, доступ к курсам приостановлен" : "активен";
  const bonuses = p.bonuses.length
    ? p.bonuses.map((b) => `• ${esc(b.title)} — ${discount(b.discount_type, b.amount)}, ${STATUS[b.status] || b.status}, до ${fmtDate(b.expires_at).slice(0, 10)}`).join("\n")
    : "нет активных";
  const courses = p.courses.length
    ? p.courses.map((c) => `• ${esc(c.title)} — ${c.progress?.percent || 0}%`).join("\n") : "пока нет";
  const orders = p.orders.length
    ? p.orders.map((o) => `• № ${o.order_no} · ${esc(o.title)}${o.is_gift ? " (подарок)" : ""} · ${money(o.total)} · ${ORDER_STATUS[o.status] || o.status}`).join("\n") : "";
  return send(chatId,
    `👤 <b>${esc(p.name || "Без имени")}</b> · клиент № ${p.client_no}\n\n` +
    `Email: ${esc(p.email || "не указан")}\nТелефон: ${esc(p.phone || "не указан")}\nАккаунт: ${state}\nС нами с ${fmtDate(p.created_at).slice(0, 10)}\n\n` +
    `🎁 <b>Скидки в клинике</b>\n${bonuses}\n\n🔗 <b>Промокод для друзей</b>: <code>${esc(p.ref_code)}</code> · приглашено: ${p.invites}\n\n` +
    `🎓 <b>Курсы</b>\n${courses}` + (orders ? `\n\n🧾 <b>Последние заказы</b>\n${orders}` : "") +
    `\n\n📣 Новости клиники: ${p.news_opt_in ? "подписаны (/stop — отписаться)" : "не подписаны (/news — подписаться)"}`,
    { reply_markup: { inline_keyboard: [
      [{ text: "🎓 Мои курсы", callback_data: "m:courses" }, { text: "Личный кабинет", url: `${site}/kabinet/` }],
    ] } });
}

async function showCourses(chatId: number, tgId: number) {
  const site = await siteUrl();
  const p = await clientProfile(tgId);
  if (!p) return notLinked(chatId, site);
  if (p.courses_blocked) return send(chatId, "Доступ к курсам на вашем аккаунте приостановлен. Если это ошибка — позвоните в клинику: +7 (987) 600-00-37.");
  if (!p.courses.length) {
    const pending = p.orders.filter((o) => o.status === "pending");
    return send(chatId, "У вас пока нет онлайн-курсов." +
      (pending.length ? `\n\nЗаказ ${pending.map((o) => "№ " + o.order_no).join(", ")} ждёт оплаты — администратор свяжется с вами. Доступ откроется автоматически после подтверждения.` : ""),
      { reply_markup: { inline_keyboard: [[{ text: "📚 Каталог курсов", url: `${site}/kursy/` }]] } });
  }
  return send(chatId, "🎓 <b>Мои курсы</b>\n\n" + p.courses.map((c) => {
    const pr = c.progress || { percent: 0, completed: 0, total: 0 };
    return `<b>${esc(c.title)}</b>\n${bar(pr.percent)} ${pr.percent || 0}% · пройдено ${pr.completed} из ${pr.total}`;
  }).join("\n\n") + "\n\nУроки открываются на сайте — нажмите кнопку под курсом. Если попросит войти, выберите «Войти через Telegram».",
    { reply_markup: { inline_keyboard: p.courses.map((c) => [{
      text: `▶️ ${(c.progress?.completed ? "Продолжить: " : "Начать: ") + c.title}`.slice(0, 60),
      url: `${site}/kursy/${encodeURIComponent(c.slug)}/uroki/`,
    }]) } });
}

// ------------------------------------------------------------------ Команды

const HELP =
  "🛠 <b>Служебный бот «Физиотера»</b>\n\n" +
  "/stats — статистика\n/pending — скидки, ожидающие подтверждения\n/users <i>поиск</i> — клиенты (имя, телефон, email, промокод)\n" +
  "/user <i>номер</i> — карточка клиента\n/codes — лучшие пригласившие\n/suspicious — подозрительные действия\n" +
  "/rules — условия скидок\n/program on|off — включить/выключить реферальную программу\n/diag on|off — расширенная диагностика\n\n" +
  "<b>Администраторы</b>\n/admins — список\n/addadmin <i>номер клиента или Telegram ID</i> — выдать права (только владелец)\n" +
  "/removeadmin <i>номер или ID</i> — снять права (только владелец)\n\n" +
  "<b>Онлайн-курсы</b>\nНовые заказы приходят сюда с кнопкой «Оплата получена» — она открывает клиенту доступ.\n" +
  "/profile, /mycourses — ваш собственный профиль и курсы\n\n" +
  "Полная админ-панель: сайт → Войти через Telegram → Админ-панель.";

async function bot(tgId: number, cmd: string, args: Record<string, unknown> = {}) {
  const { data, error } = await db.rpc("svc_bot", { p_tg: tgId, p_cmd: cmd, p_args: args });
  if (error) throw new Error(error.message);
  return data as any;
}

async function handleAdminCommand(chatId: number, tgId: number, cmd: string, arg: string) {
  switch (cmd) {
    case "/start":
    case "/help":
      return send(chatId, HELP);
    case "/stats": {
      const s = await bot(tgId, "stats");
      const b = s.bonuses || {};
      return send(chatId,
        `📊 <b>Статистика</b>\n\nКлиентов: ${s.users_total} (сегодня ${s.users_today}, за 7 дней ${s.users_7d})\n` +
        `Заблокировано: ${s.blocked}\nПривязали Telegram: ${s.telegram_linked}\n\n` +
        `Приглашений: ${s.referrals_total}, получили услугу: ${s.referrals_qualified}\n\n` +
        `Бонусы — доступны: ${b.available || 0}, ждут подтверждения: ${b.pending || 0}, использованы: ${b.used || 0}, ` +
        `истекли: ${b.expired || 0}, отменены: ${b.cancelled || 0}\n` +
        `Подтверждённых скидок: ${s.redemptions_confirmed}\n\nПодозрительных событий за 7 дней: ${s.suspicious_7d}\n` +
        `Реферальная программа: ${s.settings?.referral_enabled ? "включена" : "выключена"}`);
    }
    case "/pending": {
      const list = await bot(tgId, "pending") as any[];
      if (!list.length) return send(chatId, "Нет запросов, ожидающих подтверждения ✅");
      for (const r of list) {
        await send(chatId,
          `🧾 <b>${esc(r.bonus.title)}</b> — ${discount(r.bonus.discount_type, r.bonus.amount)}\n` +
          `Клиент: ${esc(r.user.name || "без имени")} (№ ${r.user.client_no})\nТелефон: ${esc(r.phone)}\nУслуга: ${esc(r.service)}\n` +
          `Запрошено: ${fmtDate(r.requested_at)}${r.invited_by ? `\nПриглашён по коду: ${esc(r.invited_by)}` : ""}`,
          { reply_markup: { inline_keyboard: [[
            { text: "✅ Услуга оказана", callback_data: `rd:${r.id}:c` },
            { text: "✖️ Не состоялась", callback_data: `rd:${r.id}:x` },
          ]] } });
      }
      return;
    }
    case "/users": {
      const res = await bot(tgId, "users", { q: arg });
      const items = res.items as any[];
      if (!items.length) return send(chatId, "Никого не нашлось");
      return send(chatId, `👥 <b>Клиенты</b> (найдено ${res.total})\n\n` + items.map((u) =>
        `№ ${u.client_no} · ${esc(u.name || "без имени")}${u.status !== "active" ? ` · <b>${esc(u.status)}</b>` : ""}\n` +
        `${esc(u.phone || "тел. не указан")} · ${esc(u.ref_code)}${u.telegram?.username ? " · @" + esc(u.telegram.username) : ""}\n` +
        `Приглашено: ${u.invites}${u.invited_by ? ` · пришёл по ${esc(u.invited_by)}` : ""}`).join("\n\n") +
        (res.total > items.length ? "\n\nУточните поиск, чтобы увидеть остальных" : ""));
    }
    case "/user": {
      const no = Number(arg.replace(/\D/g, ""));
      if (!no) return send(chatId, "Укажите номер клиента: /user 1042");
      const d = await bot(tgId, "user", { client_no: no });
      if (!d) return send(chatId, "Клиент не найден");
      const u = d.user;
      const bonuses = (d.bonuses as any[]).map((b) =>
        `• ${esc(b.title)} — ${discount(b.discount_type, b.amount)}, ${STATUS[b.status] || b.status}, до ${fmtDate(b.expires_at)}`).join("\n") || "нет";
      return send(chatId,
        `👤 <b>${esc(u.name || "без имени")}</b> · № ${u.client_no}\nСтатус: ${esc(u.status)}${u.status_reason ? ` (${esc(u.status_reason)})` : ""}\n` +
        `Телефон: ${esc(u.phone || "—")}\nEmail: ${esc(u.email || "—")}\nTelegram: ${u.telegram?.username ? "@" + esc(u.telegram.username) : "—"}\n` +
        `Промокод: ${esc(u.ref_code)}\nРегистрация: ${fmtDate(u.created_at)} (${u.signup_method === "telegram" ? "Telegram" : "Email"})\n` +
        `${d.referrer ? `Пригласил: № ${d.referrer.client_no} (${esc(d.referrer.code)})\n` : ""}Пригласил сам: ${(d.invited as any[]).length}\n\n` +
        `<b>Бонусы</b>\n${bonuses}`);
    }
    case "/codes": {
      const list = await bot(tgId, "codes") as any[];
      if (!list.length) return send(chatId, "Пока никто никого не пригласил");
      return send(chatId, "🏆 <b>Лучшие пригласившие</b>\n\n" + list.map((r, i) =>
        `${i + 1}. ${esc(r.name || "без имени")} (№ ${r.client_no}) · ${esc(r.code)}\n   приглашено ${r.invited}, получили услугу ${r.qualified}`).join("\n"));
    }
    case "/suspicious": {
      const list = await bot(tgId, "suspicious") as any[];
      if (!list.length) return send(chatId, "Подозрительных действий нет ✅");
      return send(chatId, "🕵️ <b>Последние подозрительные действия</b>\n\n" + list.map((e) =>
        `${e.severity === "alert" ? "🚨" : "⚠️"} ${fmtDate(e.created_at)} · ${esc(e.type)}${e.user ? ` · № ${e.user.client_no}` : ""}`).join("\n"));
    }
    case "/rules": {
      const rules = await bot(tgId, "rules") as Record<string, any>;
      return send(chatId, "📋 <b>Условия скидок</b>\n\n" + Object.values(rules).map((r) =>
        `<b>${esc(r.title)}</b> — ${r.enabled ? "включено" : "выключено"}\nСкидка: ${discount(r.discount_type, r.amount)} · срок ${r.valid_days ?? "—"} дн. · ` +
        `использований ${r.max_uses} · ${r.stackable ? "совмещается" : "не совмещается"}\nУслуги: ${r.all_services ? "все" : (r.services as any[]).map((s) => esc(s.title)).join(", ")}`).join("\n\n") +
        "\n\nИзменить условия — в админ-панели на сайте.");
    }
    case "/program":
    case "/diag": {
      const on = /^(on|вкл|1|да)$/i.test(arg) ? true : /^(off|выкл|0|нет)$/i.test(arg) ? false : null;
      if (on === null) return send(chatId, `Укажите on или off: ${cmd} on`);
      const key = cmd === "/program" ? "referral_enabled" : "diagnostics";
      await bot(tgId, "settings", { [key]: on });
      return send(chatId, `Готово: ${cmd === "/program" ? "реферальная программа" : "расширенная диагностика"} ${on ? "включена" : "выключена"}`);
    }
    case "/admins": {
      const list = await manage(tgId, "list") as any[];
      return send(chatId, "🛡 <b>Администраторы</b>\n\n" + list.map((a) =>
        `${a.role === "owner" ? "👑 Владелец" : "🛡 Админ"}\n${personLine(a)}\nДобавлен: ${fmtDate(a.added_at)}`).join("\n\n") +
        "\n\nВыдать права: /addadmin <i>номер клиента</i>\nСнять: /removeadmin <i>номер</i>");
    }
    case "/addadmin":
    case "/removeadmin": {
      const grant = cmd === "/addadmin";
      const q = arg.replace(/[\s№#]/g, "");
      if (!q) {
        return send(chatId, grant
          ? "Укажите номер клиента с сайта или Telegram ID:\n/addadmin 1042\n/addadmin 123456789\n\nЧеловек должен хотя бы раз написать боту /start."
          : "Укажите номер клиента или Telegram ID: /removeadmin 1042");
      }
      const t = await manage(tgId, "resolve", { q });
      if (grant && t.role) return send(chatId, `${personLine(t)}\n\nУже ${t.role === "owner" ? "владелец" : "администратор"}.`);
      if (!grant && !t.role) return send(chatId, `${personLine(t)}\n\nЭтот человек не администратор.`);
      if (Number(t.telegram_id) === tgId && !grant) return send(chatId, "Снять права с самого себя через бота нельзя.");
      const text = grant
        ? `🛡 <b>Выдать права администратора?</b>\n\n${personLine(t)}\n\nПолучит: служебные команды бота, уведомления, полную админ-панель сайта (клиенты, скидки, рассылки). Управлять админами не сможет.`
        : `🚫 <b>Снять права администратора?</b>\n\n${personLine(t)}`;
      return send(chatId, text, { reply_markup: { inline_keyboard: [[
        { text: grant ? "✅ Выдать" : "✅ Снять", callback_data: `${grant ? "ag" : "ar"}:${t.telegram_id}` },
        { text: "✖️ Отмена", callback_data: "ax" },
      ]] } });
    }
    default:
      return send(chatId, "Неизвестная команда. /help — список команд");
  }
}

async function handleLoginStart(chatId: number, nonce: string) {
  const { data } = await db.rpc("svc_tg_login_peek", { p_nonce: nonce });
  const r = data as { code: string; mode: string; status: string; expired: boolean } | null;
  if (!r || r.expired || r.status !== "pending") {
    return send(chatId, "⏱ Ссылка для входа устарела. Нажмите «Войти через Telegram» на сайте ещё раз.");
  }
  const what = r.mode === "link" ? "привязать этот Telegram к аккаунту" : "войти в личный кабинет";
  return send(chatId,
    `🔐 <b>Вход на сайт клиники «Физиотера»</b>\n\nВы хотите ${what} на www.fiziotera.online.\n\n` +
    `На сайте должен быть показан код: <b>${esc(r.code)}</b>\n\n` +
    "Подтверждайте, только если вы сами нажали кнопку на сайте и код совпадает. Никому не пересылайте это сообщение.",
    { reply_markup: { inline_keyboard: [[
      { text: "✅ Подтвердить", callback_data: `lc:${nonce}` },
      { text: "✖️ Это не я", callback_data: `lx:${nonce}` },
    ]] } });
}

async function handleUpdate(update: any) {
  if (update.callback_query) {
    const cq = update.callback_query;
    const from = cq.from;
    const chatId = cq.message?.chat?.id;
    const msgId = cq.message?.message_id;
    const data = String(cq.data || "");
    if (data.startsWith("lc:") || data.startsWith("lx:")) {
      const nonce = data.slice(3);
      if (data.startsWith("lx:")) {
        await db.rpc("svc_tg_login_reject", { p_nonce: nonce });
        await tg("answerCallbackQuery", { callback_query_id: cq.id, text: "Вход отменён" });
        if (chatId && msgId) await tg("editMessageText", { chat_id: chatId, message_id: msgId, text: "✖️ Вход отменён. Если это были не вы — ничего делать не нужно." });
        return;
      }
      const { data: res } = await db.rpc("svc_tg_login_confirm", {
        p_nonce: nonce, p_tg: from.id, p_username: from.username || null,
        p_first: [from.first_name, from.last_name].filter(Boolean).join(" ") || null,
      });
      const ok = (res as { ok: boolean } | null)?.ok;
      await tg("answerCallbackQuery", { callback_query_id: cq.id, text: ok ? "Готово!" : "Ссылка устарела" });
      if (chatId && msgId) {
        await tg("editMessageText", {
          chat_id: chatId, message_id: msgId,
          text: ok ? "✅ Подтверждено! Вернитесь на сайт — вход выполнится автоматически."
                   : "⏱ Ссылка устарела. Нажмите «Войти через Telegram» на сайте ещё раз.",
        });
      }
      return;
    }
    if (data === "ax" || data.startsWith("ag:") || data.startsWith("ar:")) {
      const done = (t: string) => chatId && msgId
        ? tg("editMessageText", { chat_id: chatId, message_id: msgId, text: t, parse_mode: "HTML" }) : null;
      if (data === "ax") {
        await tg("answerCallbackQuery", { callback_query_id: cq.id, text: "Отменено" });
        await done("✖️ Отменено");
        return;
      }
      const grant = data.startsWith("ag:");
      const target = Number(data.slice(3));
      try {
        const t = await manage(from.id, grant ? "grant" : "revoke", { telegram_id: target });
        await tg("answerCallbackQuery", { callback_query_id: cq.id, text: grant ? "Права выданы" : "Права сняты" });
        // меню команд и сообщение самому человеку
        await adminMenu(target, grant);
        const r = await send(target, grant
          ? "🛡 Вам выданы права администратора клиники «Физиотера».\n\n/help — служебные команды. Админ-панель: сайт → «Войти через Telegram» → «Админ-панель»."
          : "Ваши права администратора клиники «Физиотера» сняты.");
        await done(`${grant ? "✅ <b>Права выданы</b>" : "✅ <b>Права сняты</b>"}\n\n${personLine(t)}` +
          (r.ok ? "" : "\n\n⚠️ Не удалось написать ему в Telegram — пусть откроет бота и нажмёт /start, после этого команды появятся."));
      } catch (e) {
        const code = e instanceof Error ? e.message : "";
        await tg("answerCallbackQuery", { callback_query_id: cq.id, text: "Не получилось: " + (ERR[code] || code).slice(0, 150), show_alert: true });
      }
      return;
    }
    if (data === "m:profile" || data === "m:courses") {
      await tg("answerCallbackQuery", { callback_query_id: cq.id });
      if (chatId) await (data === "m:profile" ? showProfile(chatId, from.id) : showCourses(chatId, from.id));
      return;
    }
    if (data.startsWith("co:")) {
      const [, id, act] = data.split(":");
      try {
        const r = await db.rpc(act === "p" ? "svc_order_paid_tg" : "svc_order_cancel_tg", { p_tg: from.id, p_order: id });
        if (r.error) throw new Error(r.error.message);
        const res = r.data as { already?: boolean; gift_code?: string; ok?: boolean; error?: string };
        if (res && res.ok === false) throw new Error(res.error || "error");
        await tg("answerCallbackQuery", { callback_query_id: cq.id, text: act === "p" ? (res.already ? "Уже оплачен" : "Доступ выдан") : "Заказ отменён" });
        if (chatId && msgId) {
          await tg("editMessageReplyMarkup", { chat_id: chatId, message_id: msgId, reply_markup: { inline_keyboard: [] } });
          await send(chatId, act === "p"
            ? (res.already ? "Этот заказ уже был оплачен ранее." : "✅ Оплата отмечена, доступ выдан. Клиент получит уведомление." + (res.gift_code ? `\nПодарочный код: <code>${esc(res.gift_code)}</code>` : ""))
            : "↩️ Заказ отменён", { reply_to_message_id: msgId });
        }
      } catch (e) {
        const code = e instanceof Error ? e.message : "";
        await tg("answerCallbackQuery", { callback_query_id: cq.id, text: "Не получилось: " + (ERR[code] || code).slice(0, 150), show_alert: true });
      }
      return;
    }
    if (data.startsWith("rd:")) {
      const [, id, act] = data.split(":");
      try {
        await bot(from.id, "decide", { id, decision: act === "c" ? "confirm" : "cancel" });
        await tg("answerCallbackQuery", { callback_query_id: cq.id, text: act === "c" ? "Подтверждено" : "Отменено" });
        if (chatId && msgId) {
          await tg("editMessageReplyMarkup", { chat_id: chatId, message_id: msgId, reply_markup: { inline_keyboard: [] } });
          await send(chatId, act === "c" ? "✅ Скидка подтверждена" : "↩️ Запрос отменён, бонус снова доступен клиенту",
            { reply_to_message_id: msgId });
        }
      } catch (e) {
        const code = e instanceof Error ? e.message : "";
        await tg("answerCallbackQuery", { callback_query_id: cq.id, text: "Не получилось: " + (ERR[code] || code).slice(0, 150), show_alert: true });
      }
      return;
    }
    await tg("answerCallbackQuery", { callback_query_id: cq.id });
    return;
  }

  const msg = update.message;
  if (!msg || !msg.from || msg.chat?.type !== "private") return;
  const chatId = msg.chat.id;
  const text = String(msg.text || "").trim();
  const [rawCmd, ...rest] = text.split(/\s+/);
  const cmd = rawCmd.split("@")[0].toLowerCase();
  const arg = rest.join(" ").slice(0, 100);

  if (cmd === "/start" && /^L[A-Za-z0-9_-]{20,40}$/.test(arg)) return handleLoginStart(chatId, arg.slice(1));

  if (cmd === "/stop" || cmd === "/news") {
    const on = cmd === "/news";
    const { data: r } = await db.rpc("svc_news_opt", { p_tg: msg.from.id, p_on: on });
    if (!(r as { ok: boolean } | null)?.ok) {
      return send(chatId, "Этот Telegram не привязан к личному кабинету на сайте — рассылки ему не приходят.");
    }
    return send(chatId, on
      ? "✅ Готово! Будем присылать новости и акции клиники. Отписаться в любой момент: /stop"
      : "Вы отписались от новостей клиники. Сообщения о ваших скидках и входе на сайт по-прежнему будут приходить.\nВключить снова: /news");
  }

  if (cmd === "/profile" || cmd === "/mycourses" || cmd === "/menu") {
    try {
      if (cmd === "/menu") return send(chatId, "Меню:", MENU(await siteUrl()));
      return await (cmd === "/profile" ? showProfile(chatId, msg.from.id) : showCourses(chatId, msg.from.id));
    } catch (e) {
      console.error("client cmd", e instanceof Error ? e.message : e);
      return send(chatId, "Не получилось загрузить данные. Попробуйте через минуту.");
    }
  }

  const { data: chatsData } = await db.rpc("svc_admin_chats");
  const isAdmin = ((chatsData || []) as number[]).map(Number).includes(Number(msg.from.id));
  if (isAdmin && cmd.startsWith("/")) {
    try {
      return await handleAdminCommand(chatId, msg.from.id, cmd, arg);
    } catch (e) {
      return send(chatId, "Не получилось: " + esc(e instanceof Error ? (ERR[e.message] || e.message) : "ошибка"));
    }
  }

  const site = await siteUrl();
  return send(chatId,
    "Здравствуйте! 👋 Это бот клиники лечения и реабилитации «Физиотера» (Уфа, ул. Энтузиастов, 16).\n\n" +
    `Через него выполняется вход в личный кабинет на сайте ${esc(site)}, здесь же — ваш профиль и онлайн-курсы.\n` +
    "Записаться на приём: +7 (987) 600-00-37\n\n" +
    "/profile — мой профиль\n/mycourses — мои курсы\n/news — подписаться на новости, /stop — отписаться", MENU(site));
}

// ------------------------------------------------------------------ HTTP

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("ok", { status: 200 });
  const url = new URL(req.url);
  const task = url.searchParams.get("task");

  try {
    if (task) {
      const expected = await secret("internal_secret");
      const got = req.headers.get("x-internal-secret") || "";
      if (!expected || !safeEqual(got, expected)) return new Response("forbidden", { status: 403 });
      const result = task === "dispatch" ? await dispatch() : task === "setup" ? await setup() : { ok: false };
      return Response.json(result);
    }

    const expected = await secret("telegram_webhook");
    const got = req.headers.get("x-telegram-bot-api-secret-token") || "";
    if (!expected || !safeEqual(got, expected)) return new Response("forbidden", { status: 403 });

    const update = await req.json().catch(() => null);
    if (update) await handleUpdate(update);
    return new Response("ok");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("tg-bot error", msg);
    try {
      const { data: allowed } = await db.rpc("svc_rate", { p_key: "err:tg-bot", p_max: 3, p_window: 600 });
      if (allowed) {
        await db.rpc("svc_log", { p_type: "system_error", p_severity: "error", p_user: null,
          p_data: { where: task ? `tg-bot/${task}` : "tg-bot/webhook", message: msg.slice(0, 200) }, p_notify: true });
      }
    } catch { /* ignore */ }
    // Telegram получает 200, чтобы не повторять один и тот же сбойный апдейт бесконечно
    return new Response("ok");
  }
});
