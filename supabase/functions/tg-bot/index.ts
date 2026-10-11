// Физиотера — Telegram-бот (Supabase Edge Function).
//
//   POST /tg-bot                    — вебхук Telegram (проверка X-Telegram-Bot-Api-Secret-Token)
//   POST /tg-bot?task=dispatch      — отправить накопившиеся уведомления (вызывает база, x-internal-secret)
//   POST /tg-bot?task=setup         — зарегистрировать вебхук и команды (x-internal-secret)
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
};
const STATUS: Record<string, string> = {
  available: "доступен", pending: "ожидает подтверждения", used: "использован",
  expired: "истёк", cancelled: "отменён", confirmed: "подтверждён", refunded: "возврат",
  registered: "зарегистрирован", qualified: "получил услугу",
};
const ERR: Record<string, string> = {
  not_found: "не найдено", not_pending: "запрос уже обработан", not_confirmed: "услуга не была подтверждена",
  bonus_cancelled: "бонус отменён", forbidden: "нет доступа",
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
  return { ok: true, sent, failed };
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
  await tg("setMyCommands", { commands: [{ command: "start", description: "Начать" }] });
  const { data: chatsData } = await db.rpc("svc_admin_chats");
  const adminCommands = [
    ["help", "Список команд"], ["stats", "Статистика"], ["pending", "Ожидают подтверждения"],
    ["users", "Поиск клиентов: /users Анна"], ["user", "Клиент по номеру: /user 1042"],
    ["codes", "Лучшие пригласившие"], ["suspicious", "Подозрительные действия"],
    ["rules", "Условия скидок"], ["program", "Программа: /program on|off"], ["diag", "Диагностика: /diag on|off"],
  ].map(([command, description]) => ({ command, description }));
  const scoped: Record<string, unknown> = {};
  for (const chat of (chatsData || []) as number[]) {
    const r = await tg("setMyCommands", { commands: adminCommands, scope: { type: "chat", chat_id: chat } });
    scoped[String(chat)] = r.ok ? "ok" : r.description;
  }
  return { ok: wh.ok, bot: me.result?.username, webhook: wh.description, admin_commands: scoped };
}

// ------------------------------------------------------------------ Команды

const HELP =
  "🛠 <b>Служебный бот «Физиотера»</b>\n\n" +
  "/stats — статистика\n/pending — скидки, ожидающие подтверждения\n/users <i>поиск</i> — клиенты (имя, телефон, email, промокод)\n" +
  "/user <i>номер</i> — карточка клиента\n/codes — лучшие пригласившие\n/suspicious — подозрительные действия\n" +
  "/rules — условия скидок\n/program on|off — включить/выключить реферальную программу\n/diag on|off — расширенная диагностика\n\n" +
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

  const { data: chatsData } = await db.rpc("svc_admin_chats");
  const isAdmin = ((chatsData || []) as number[]).map(Number).includes(Number(msg.from.id));
  if (isAdmin && cmd.startsWith("/")) {
    try {
      return await handleAdminCommand(chatId, msg.from.id, cmd, arg);
    } catch (e) {
      return send(chatId, "Не получилось: " + esc(e instanceof Error ? (ERR[e.message] || e.message) : "ошибка"));
    }
  }

  const s = (await db.rpc("svc_settings")).data as { site_url?: string } | null;
  return send(chatId,
    "Здравствуйте! 👋 Это бот клиники лечения и реабилитации «Физиотера» (Уфа, ул. Энтузиастов, 16).\n\n" +
    `Через него выполняется вход в личный кабинет на сайте: ${esc(s?.site_url || "https://www.fiziotera.online")}\n` +
    "Записаться на приём: +7 (987) 600-00-37");
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
