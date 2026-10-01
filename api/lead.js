/*
 * Приём заявок с сайта (Vercel Serverless Function).
 *
 * GET  /api/lead  → { configured: true|false } — сайт проверяет, включена ли автоотправка.
 * POST /api/lead  → отправляет заявку во все настроенные каналы.
 *
 * Каналы включаются переменными окружения в Vercel (Settings → Environment Variables):
 *
 *   WhatsApp через GREEN-API (green-api.com):
 *     GREEN_API_ID      — idInstance
 *     GREEN_API_TOKEN   — apiTokenInstance
 *     GREEN_API_URL     — apiUrl из личного кабинета (по умолчанию https://api.green-api.com)
 *     WHATSAPP_TO       — номер, куда присылать заявки, только цифры: 79173816478
 *
 *   Telegram (запасной/дополнительный канал):
 *     TELEGRAM_BOT_TOKEN — токен бота от @BotFather
 *     TELEGRAM_CHAT_ID   — id чата/группы, куда бот пишет заявки
 *
 * Если ни один канал не настроен, сайт сам откроет у пациента WhatsApp с готовым текстом заявки.
 */

function clean(v, max) {
  return String(v == null ? "" : v).replace(/[\u0000-\u001f<>]/g, " ").trim().slice(0, max);
}

function channels() {
  var env = process.env;
  return {
    whatsapp: !!(env.GREEN_API_ID && env.GREEN_API_TOKEN && env.WHATSAPP_TO),
    telegram: !!(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID)
  };
}

async function sendWhatsApp(text) {
  var env = process.env;
  var base = (env.GREEN_API_URL || "https://api.green-api.com").replace(/\/+$/, "");
  var url = base + "/waInstance" + env.GREEN_API_ID + "/sendMessage/" + env.GREEN_API_TOKEN;
  var r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chatId: String(env.WHATSAPP_TO).replace(/\D/g, "") + "@c.us", message: text })
  });
  if (!r.ok) throw new Error("whatsapp " + r.status);
}

async function sendTelegram(text) {
  var env = process.env;
  var r = await fetch("https://api.telegram.org/bot" + env.TELEGRAM_BOT_TOKEN + "/sendMessage", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text: text, disable_web_page_preview: true })
  });
  if (!r.ok) throw new Error("telegram " + r.status);
}

module.exports = async function handler(req, res) {
  var ch = channels();
  var configured = ch.whatsapp || ch.telegram;

  if (req.method === "GET") {
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({ configured: configured });
  }
  if (req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ ok: false });
  }

  var b = req.body || {};
  if (typeof b === "string") { try { b = JSON.parse(b); } catch (e) { b = {}; } }
  if (b.website) return res.status(200).json({ ok: true }); // бот заполнил скрытое поле

  var name = clean(b.name, 60);
  var phone = clean(b.phone, 20).replace(/\D/g, "");
  var service = clean(b.service, 120);
  if (service === "promo") service = "Бесплатная консультация + процедура (акция)";
  if (name.length < 2 || phone.length < 10 || phone.length > 12) {
    return res.status(400).json({ ok: false, error: "bad_input" });
  }
  if (!configured) return res.status(200).json({ ok: false, error: "not_configured" });

  var time = new Date().toLocaleString("ru-RU", { timeZone: "Asia/Yekaterinburg" });
  var text =
    "🆕 Заявка с сайта — Центр здоровья, Салават\n" +
    "Имя: " + name + "\n" +
    "Телефон: +" + phone + "\n" +
    "Интересует: " + (service || "—") + "\n" +
    "Время: " + time;

  var jobs = [];
  if (ch.whatsapp) jobs.push(sendWhatsApp(text));
  if (ch.telegram) jobs.push(sendTelegram(text));
  var results = await Promise.allSettled(jobs);
  var sent = results.some(function (r) { return r.status === "fulfilled"; });
  results.forEach(function (r) { if (r.status === "rejected") console.error(r.reason); });

  return res.status(sent ? 200 : 502).json({ ok: sent });
};
