// Физиотера — серверная функция аккаунтов (Supabase Edge Function).
//
// Действия (POST JSON { action, ... }):
//   signup     — регистрация по email + пароль (если почта настроена — с кодом из письма)
//   verify     — подтвердить email кодом из письма и войти
//   resend     — прислать код ещё раз (не чаще раза в минуту)
//   login      — вход по email + пароль (с ограничением попыток)
//   tg_start   — начать вход/привязку через Telegram-бота
//   tg_poll    — проверить, подтвердил ли пользователь вход в боте
//   set_email  — добавить email и пароль к аккаунту, созданному через Telegram (код на почту)
//   set_email_confirm — подтвердить привязку email кодом
//   reset      — «Забыли пароль?»: код на почту и в Telegram (если привязан)
//   reset_confirm — новый пароль по коду
//   lead       — заявка с сайта: уходит только администраторам в Telegram-бот
//   ref_click  — отметить переход по реферальной ссылке
//   check_code — проверить промокод друга
//
// Секреты берутся из окружения Supabase (SUPABASE_*) и из Vault — в коде их нет.

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.49.4";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const ALLOWED_ORIGINS = new Set([
  "https://www.fiziotera.online",
  "https://fiziotera.online",
  "http://localhost:8000",
]);
const TG_EMAIL_DOMAIN = "tg.fiziotera.online";
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,24}$/;
const CODE_RE = /^GIFT-[A-Z0-9]{5}$/;
const OTP_RE = /^[0-9]{6,10}$/;
const DEFAULT_MAIL_USER = "fizioteraufa@gmail.com";

const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

function anonClient(): SupabaseClient {
  return createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
}

class HttpError extends Error {
  constructor(public status: number, public code: string) {
    super(code);
  }
}

function cors(origin: string | null): Record<string, string> {
  const h: Record<string, string> = {
    "Vary": "Origin",
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  };
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    h["Access-Control-Allow-Origin"] = origin;
    h["Access-Control-Allow-Headers"] = "authorization, apikey, content-type, x-client-info";
    h["Access-Control-Allow-Methods"] = "POST, OPTIONS";
    h["Access-Control-Max-Age"] = "600";
  }
  return h;
}

function json(body: unknown, status: number, origin: string | null) {
  return new Response(JSON.stringify(body), { status, headers: cors(origin) });
}

// ---------------------------------------------------------------- helpers

// Кэш на минуту: новый секрет (например, пароль почты) подхватывается без передеплоя
const secretCache: Record<string, { v: string | null; at: number }> = {};
async function secret(name: string): Promise<string | null> {
  const c = secretCache[name];
  if (c && Date.now() - c.at < 60_000) return c.v;
  const { data, error } = await admin.rpc("svc_secret", { p_name: name });
  if (error) throw error;
  secretCache[name] = { v: (data as string | null) ?? null, at: Date.now() };
  return secretCache[name].v;
}

function clientIp(req: Request): string {
  const xff = req.headers.get("x-forwarded-for") || "";
  return (xff.split(",")[0] || req.headers.get("x-real-ip") || "unknown").trim().slice(0, 64);
}

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function ipHash(ip: string): Promise<string> {
  const salt = (await secret("ip_salt")) || "fiziotera";
  return (await sha256Hex(salt + "|" + ip)).slice(0, 32);
}

async function allow(key: string, max: number, windowSec: number): Promise<boolean> {
  const { data, error } = await admin.rpc("svc_rate", { p_key: key, p_max: max, p_window: windowSec });
  if (error) throw error;
  return data === true;
}

async function limit(key: string, max: number, windowSec: number) {
  if (!(await allow(key, max, windowSec))) throw new HttpError(429, "rate_limited");
}

async function logEvent(
  type: string,
  severity: "info" | "warn" | "alert" | "error",
  userId: string | null,
  data: Record<string, unknown>,
  notify: boolean | null,
  ip: string | null = null,
) {
  const { error } = await admin.rpc("svc_log", {
    p_type: type, p_severity: severity, p_user: userId, p_data: data, p_notify: notify, p_ip: ip,
  });
  if (error) console.error("log failed", error.message);
}

function str(v: unknown, max: number): string {
  return typeof v === "string" ? v.trim().slice(0, max) : "";
}

function normEmail(v: unknown): string {
  const e = str(v, 254).toLowerCase();
  if (!EMAIL_RE.test(e) || e.endsWith("@" + TG_EMAIL_DOMAIN)) throw new HttpError(400, "bad_email");
  return e;
}

function checkPassword(v: unknown): string {
  const p = typeof v === "string" ? v : "";
  if (p.length < 8 || new TextEncoder().encode(p).length > 72) throw new HttpError(400, "weak_password");
  if (!/[A-Za-zА-Яа-яЁё]/.test(p) || !/[0-9]/.test(p)) throw new HttpError(400, "weak_password");
  return p;
}

function normCode(v: unknown): string {
  const c = str(v, 20).toUpperCase();
  return CODE_RE.test(c) ? c : "";
}

function publicSession(s: { access_token: string; refresh_token: string; expires_at?: number; expires_in?: number }) {
  return { access_token: s.access_token, refresh_token: s.refresh_token, expires_at: s.expires_at, expires_in: s.expires_in };
}

// Сессия для пользователя без пароля (вход через Telegram):
// одноразовая ссылка генерируется и сразу погашается на сервере — письмо не отправляется.
async function sessionForEmail(email: string) {
  const { data, error } = await admin.auth.admin.generateLink({ type: "magiclink", email });
  if (error || !data?.properties?.hashed_token) throw new HttpError(500, "session_failed");
  const { data: v, error: e2 } = await anonClient().auth.verifyOtp({
    type: "magiclink",
    token_hash: data.properties.hashed_token,
  });
  if (e2 || !v.session) throw new HttpError(500, "session_failed");
  return v.session;
}

async function userFromAuthHeader(req: Request): Promise<string> {
  const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!token) throw new HttpError(401, "not_authenticated");
  const { data, error } = await admin.auth.getUser(token);
  if (error || !data.user) throw new HttpError(401, "not_authenticated");
  return data.user.id;
}

async function profile(userId: string) {
  const { data, error } = await admin.rpc("svc_profile", { p_user: userId });
  if (error) throw error;
  return data as { id: string; client_no: number; name: string | null; status: string; email: string | null; telegram_id: number | null } | null;
}

async function settings() {
  const { data } = await admin.rpc("svc_settings");
  return (data || {}) as { site_url?: string; bot_username?: string };
}

async function botUsername(): Promise<string> {
  const s = await settings();
  if (s.bot_username) return s.bot_username;
  const token = await secret("telegram_bot_token");
  if (!token) throw new HttpError(503, "telegram_not_configured");
  const r = await fetch(`https://api.telegram.org/bot${token}/getMe`);
  const j = await r.json().catch(() => null);
  const u = j?.result?.username;
  if (!u) throw new HttpError(503, "telegram_not_configured");
  await admin.rpc("svc_set_bot_username", { p_username: u });
  return u;
}

async function sendTelegram(chatId: number, text: string) {
  const token = await secret("telegram_bot_token");
  if (!token) return false;
  const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true }),
  });
  return r.ok;
}


// ---------------------------------------------------------------- почта

// Письма уходят с ящика клиники через SMTP Gmail (порт 465). Нужны секреты в Vault:
//   smtp_pass — пароль приложения Google; smtp_user — адрес (по умолчанию fizioteraufa@gmail.com).
// Запасной вариант — Resend (resend_api_key, mail_from).
async function mailReady(): Promise<boolean> {
  return !!((await secret("smtp_pass")) || (await secret("resend_api_key")));
}

function escHtml(s: string) {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
}

async function sendMail(to: string, subject: string, text: string, html: string): Promise<boolean> {
  const pass = await secret("smtp_pass");
  if (pass) {
    try {
      const user = (await secret("smtp_user")) || DEFAULT_MAIL_USER;
      const nodemailer = (await import("npm:nodemailer@6.9.16")).default;
      const t = nodemailer.createTransport({
        host: "smtp.gmail.com", port: 465, secure: true,
        auth: { user, pass: pass.replace(/\s+/g, "") },
        connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 15000,
      });
      await t.sendMail({ from: `"Физиотера" <${user}>`, to, subject, text, html });
      return true;
    } catch (e) {
      console.error("smtp failed", e instanceof Error ? e.message : String(e));
      if (await allow("err:smtp", 1, 1800)) {
        await logEvent("system_error", "error", null,
          { where: "account/mail", message: (e instanceof Error ? e.message : String(e)).slice(0, 200) }, true);
      }
    }
  }
  const resendKey = await secret("resend_api_key");
  if (resendKey) {
    const from = (await secret("mail_from")) || "Физиотера <noreply@fiziotera.online>";
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${resendKey}` },
      body: JSON.stringify({ from, to: [to], subject, text, html }),
    });
    return r.ok;
  }
  return false;
}

function codeLetter(code: string, purpose: string) {
  const lines: Record<string, [string, string]> = {
    signup: ["Код подтверждения", "Чтобы завершить регистрацию на сайте «Физиотера», введите код:"],
    login: ["Код для входа", "Чтобы войти в личный кабинет «Физиотера», введите код:"],
    reset: ["Восстановление пароля", "Чтобы задать новый пароль в личном кабинете «Физиотера», введите код:"],
    link: ["Привязка email", "Чтобы привязать этот email к личному кабинету «Физиотера», введите код:"],
  };
  const [title, lead] = lines[purpose] || lines.login;
  const subject = `${code} — ${title.toLowerCase()} · Физиотера`;
  const tail = `Код действует ${purpose === "link" ? "15 минут" : "1 час"}. Никому его не сообщайте — сотрудники клиники никогда его не спрашивают.\n` +
    "Если это были не вы — просто проигнорируйте письмо.";
  const text = `Здравствуйте!\n\n${lead}\n\n${code}\n\n${tail}\n\nКлиника «Физиотера», Уфа, ул. Энтузиастов, 16\nhttps://www.fiziotera.online`;
  const html = `<!doctype html><html lang="ru"><body style="margin:0;background:#f3f5fb;font-family:Arial,Helvetica,sans-serif;color:#0b1742">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f5fb;padding:24px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#fff;border-radius:16px;padding:28px">
<tr><td style="font-size:20px;font-weight:bold;padding-bottom:12px">${escHtml(title)}</td></tr>
<tr><td style="font-size:15px;line-height:1.5;color:#3a4566;padding-bottom:18px">${escHtml(lead)}</td></tr>
<tr><td align="center" style="font-size:32px;font-weight:bold;letter-spacing:8px;background:#eef1fb;border-radius:12px;padding:16px">${escHtml(code)}</td></tr>
<tr><td style="font-size:13px;line-height:1.5;color:#6b7590;padding-top:18px">${escHtml(tail).replace(/\n/g, "<br>")}</td></tr>
<tr><td style="font-size:13px;color:#6b7590;padding-top:18px">Клиника «Физиотера», Уфа, ул. Энтузиастов, 16<br><a href="https://www.fiziotera.online" style="color:#2f3fbf">fiziotera.online</a></td></tr>
</table></td></tr></table></body></html>`;
  return { subject, text, html };
}

async function mailCode(email: string, code: string, purpose: string) {
  const l = codeLetter(code, purpose);
  return await sendMail(email, l.subject, l.text, l.html);
}

type AuthUser = { id: string; confirmed: boolean; status: string | null; onboarded: boolean; client_no: number | null; telegram_id: number | null };
async function authUser(email: string): Promise<AuthUser | null> {
  const { data, error } = await admin.rpc("svc_auth_user", { p_email: email });
  if (error) throw error;
  return (data as AuthUser | null) ?? null;
}

// Код из Supabase Auth (одноразовый, гаснет после использования или нового запроса).
// Не чаще раза в минуту и не больше 5 писем в час на адрес — чтобы ящик не заваливали.
async function sendAuthCode(email: string, purpose: "signup" | "login" | "reset", ipHash: string, tgId?: number | null) {
  const key = await sha256Hex(email);
  if (!(await allow(`mail:cool:${key}`, 1, 60))) throw new HttpError(429, "code_cooldown");
  if (!(await allow(`mail:em:${key}`, 5, 3600))) throw new HttpError(429, "rate_limited");
  await limit(`mail:ip:${ipHash}`, 15, 3600);
  const { data, error } = await admin.auth.admin.generateLink({ type: purpose === "reset" ? "recovery" : "magiclink", email });
  const code = data?.properties?.email_otp;
  if (error || !code) throw new HttpError(500, "code_failed");
  let sent = false;
  if (await mailReady()) sent = await mailCode(email, code, purpose);
  if (tgId && purpose === "reset") {
    const ok = await sendTelegram(tgId,
      "🔐 <b>Восстановление пароля на сайте «Физиотера»</b>\n\n" +
      `Код: <code>${code}</code>\n\nВведите его на сайте в окне «Забыли пароль?». Код действует 1 час. ` +
      "Если вы не запрашивали восстановление — просто проигнорируйте это сообщение.");
    sent = sent || ok;
  }
  return sent;
}

async function verifyCode(email: string, code: string, type: "magiclink" | "recovery", ipHash: string) {
  const key = await sha256Hex(email);
  if (!(await allow(`verify:em:${key}`, 6, 900))) {
    if (await allow(`verify:alert:${key}`, 1, 900)) {
      await logEvent("code_bruteforce", "alert", null, { email_hint: email.replace(/^(.{2}).*(@.*)$/, "$1•••$2") }, true, ipHash);
    }
    throw new HttpError(429, "rate_limited");
  }
  await limit(`verify:ip:${ipHash}`, 30, 900);
  if (!OTP_RE.test(code)) throw new HttpError(400, "bad_code");
  const { data, error } = await anonClient().auth.verifyOtp({ email, token: code, type });
  if (error || !data.session || !data.user) throw new HttpError(400, "bad_code");
  return data;
}

// ---------------------------------------------------------------- actions

type Ctx = { req: Request; body: Record<string, unknown>; ip: string; ipHash: string };

async function signup({ body, ipHash }: Ctx) {
  if (str(body.website, 100)) return { ok: true, status: "verify" }; // ловушка для ботов
  await limit(`signup:ip:${ipHash}`, 6, 3600);
  const email = normEmail(body.email);
  const password = checkPassword(body.password);
  const name = str(body.name, 60);
  if (name.length < 2) throw new HttpError(400, "bad_name");
  if (body.consent !== true) throw new HttpError(400, "consent_required");
  const phone = str(body.phone, 20);
  const ref = normCode(body.ref);
  const meta = { full_name: name, signup_phone: phone || null, signup_ref: ref || null };

  // Почта не настроена — регистрация сразу, как раньше
  if (!(await mailReady())) {
    const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: meta });
    if (error || !data.user) {
      const code = (error as { code?: string } | null)?.code;
      if (code === "email_exists" || /already been registered/i.test(error?.message || "")) throw new HttpError(409, "email_taken");
      throw new HttpError(500, "signup_failed");
    }
    const { data: ob, error: obErr } = await admin.rpc("svc_onboard", {
      p_user: data.user.id, p_method: "email", p_ref: ref || null, p_ip: ipHash, p_phone: phone || null,
    });
    if (obErr) console.error("onboard", obErr.message);
    const { data: s, error: sErr } = await anonClient().auth.signInWithPassword({ email, password });
    if (sErr || !s.session) throw new HttpError(500, "login_failed");
    return { ok: true, session: publicSession(s.session), onboarding: ob };
  }

  await limit(`signup:em:${await sha256Hex(email)}`, 5, 3600);
  const existing = await authUser(email);
  if (existing?.confirmed) throw new HttpError(409, "email_taken");
  if (existing) {
    // Адрес уже вводили, но не подтвердили — обновляем пароль и данные, шлём новый код
    if (existing.status && existing.status !== "active") throw new HttpError(403, "account_blocked");
    const { error } = await admin.auth.admin.updateUserById(existing.id, { password, user_metadata: meta });
    if (error) throw new HttpError(500, "signup_failed");
  } else {
    const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: false, user_metadata: meta });
    if (error || !data.user) {
      if (/already|exists/i.test(error?.message || "")) throw new HttpError(409, "email_taken");
      throw new HttpError(500, "signup_failed");
    }
  }
  try {
    if (!(await sendAuthCode(email, "signup", ipHash))) throw new HttpError(503, "mail_failed");
  } catch (e) {
    // уже отправили код минуту назад — просто просим ввести его
    if (!(e instanceof HttpError && e.code === "code_cooldown")) throw e;
  }
  return { ok: true, status: "verify", email };
}

// Подтверждение email кодом из письма (регистрация или вход в неподтверждённый аккаунт)
async function verify({ body, ipHash }: Ctx) {
  const email = normEmail(body.email);
  const code = str(body.code, 12).replace(/\s+/g, "");
  const d = await verifyCode(email, code, "magiclink", ipHash);
  const uid = d.user!.id;
  const p = await profile(uid);
  if (!p || p.status !== "active") throw new HttpError(403, "account_blocked");
  let onboarding: unknown = null;
  const meta = (d.user!.user_metadata || {}) as { signup_ref?: string; signup_phone?: string };
  const { data: ob, error: obErr } = await admin.rpc("svc_onboard", {
    p_user: uid, p_method: "email", p_ref: normCode(meta.signup_ref) || null, p_ip: ipHash, p_phone: meta.signup_phone || null,
  });
  if (obErr) console.error("onboard", obErr.message);
  else onboarding = ob;
  await logEvent("email_verified", "info", uid, { client_no: p.client_no }, null, ipHash);
  return { ok: true, session: publicSession(d.session!), onboarding };
}

async function resend({ body, ipHash }: Ctx) {
  await limit(`resend:ip:${ipHash}`, 10, 3600);
  const email = normEmail(body.email);
  const purpose = body.purpose === "reset" ? "reset" : "signup";
  const u = await authUser(email);
  // Ответ одинаковый — нельзя узнать, есть ли такой адрес
  if (!u || u.status === "blocked" || u.status === "deleted") return { ok: true };
  if (purpose === "signup" && u.confirmed) return { ok: true };
  await sendAuthCode(email, purpose, ipHash, purpose === "reset" ? u.telegram_id : null);
  return { ok: true };
}

async function login({ body, ipHash }: Ctx) {
  await limit(`login:ip:${ipHash}`, 30, 900);
  const email = normEmail(body.email);
  const password = typeof body.password === "string" ? body.password.slice(0, 200) : "";
  const emailKey = await sha256Hex(email);
  if (!(await allow(`login:em:${emailKey}`, 8, 900))) {
    if (await allow(`login:alert:${emailKey}`, 1, 900)) {
      await logEvent("login_bruteforce", "alert", null, { email_hint: email.replace(/^(.{2}).*(@.*)$/, "$1•••$2") }, true, ipHash);
    }
    throw new HttpError(429, "rate_limited");
  }
  const { data, error } = await anonClient().auth.signInWithPassword({ email, password });
  if (error && /not confirmed/i.test(error.message || "")) {
    // Пароль верный, но email не подтверждён — присылаем код
    try { await sendAuthCode(email, "signup", ipHash); } catch (e) { if (!(e instanceof HttpError && e.code === "code_cooldown")) throw e; }
    throw new HttpError(403, "email_not_verified");
  }
  if (error || !data.session) {
    const banned = /banned/i.test(error?.message || "");
    await logEvent(banned ? "blocked_login_attempt" : "login_failed", banned ? "warn" : "info", null,
      { email_hint: email.replace(/^(.{2}).*(@.*)$/, "$1•••$2") }, banned ? true : null, ipHash);
    throw new HttpError(banned ? 403 : 401, banned ? "account_blocked" : "invalid_credentials");
  }
  const p = await profile(data.user.id);
  if (!p || p.status !== "active") throw new HttpError(403, "account_blocked");
  await logEvent("login", "info", data.user.id, { client_no: p.client_no, method: "email" }, null, ipHash);
  return { ok: true, session: publicSession(data.session) };
}

async function tgStart({ req, body, ipHash }: Ctx) {
  await limit(`tgstart:ip:${ipHash}`, 20, 600);
  const mode = body.mode === "link" ? "link" : "login";
  const linkUser = mode === "link" ? await userFromAuthHeader(req) : null;
  if (linkUser) {
    const p = await profile(linkUser);
    if (!p || p.status !== "active") throw new HttpError(403, "account_blocked");
    if (p.telegram_id) throw new HttpError(409, "other_telegram_linked");
  }
  const bot = await botUsername();
  const { data, error } = await admin.rpc("svc_tg_login_start", {
    p_mode: mode, p_link_user: linkUser, p_ref: normCode(body.ref) || null, p_ip: ipHash,
  });
  if (error) throw error;
  const r = data as { id: string; nonce: string; poll_secret: string; code: string };
  return {
    ok: true,
    id: r.id,
    secret: r.poll_secret,
    code: r.code,
    url: `https://t.me/${bot}?start=L${r.nonce}`,
    expires_in: 600,
  };
}

async function tgPoll({ body, ipHash }: Ctx) {
  await limit(`tgpoll:ip:${ipHash}`, 400, 600);
  const id = str(body.id, 40);
  const sec = str(body.secret, 80);
  if (!/^[0-9a-f-]{36}$/.test(id)) throw new HttpError(400, "bad_request");
  const { data, error } = await admin.rpc("svc_tg_login_consume", { p_id: id, p_secret: sec });
  if (error) throw error;
  const r = data as {
    status: string; mode?: string; link_user_id?: string; tg_id?: number;
    username?: string; first_name?: string; ref_code?: string; ip_hash?: string;
  };
  if (r.status !== "confirmed") return { ok: true, status: r.status };

  const tgId = Number(r.tg_id);
  const username = r.username || null;
  const firstName = r.first_name || null;

  if (r.mode === "link") {
    const { data: l, error: lErr } = await admin.rpc("svc_tg_link", {
      p_user: r.link_user_id, p_tg: tgId, p_username: username, p_first: firstName,
    });
    if (lErr) throw lErr;
    if (!(l as { ok: boolean }).ok) throw new HttpError(409, (l as { error: string }).error);
    return { ok: true, status: "linked" };
  }

  // Вход: ищем аккаунт по Telegram ID, иначе создаём новый — один Telegram = один аккаунт
  const { data: existing } = await admin.rpc("svc_tg_user", { p_tg: tgId });
  let uid = existing as string | null;
  let created = false;
  let email: string;
  let referral: unknown = null;

  if (uid) {
    const p = await profile(uid);
    if (!p || p.status !== "active") {
      await logEvent("blocked_login_attempt", "warn", uid, { client_no: p?.client_no, method: "telegram" }, true, ipHash);
      throw new HttpError(403, "account_blocked");
    }
    const { data: u, error: uErr } = await admin.auth.admin.getUserById(uid);
    if (uErr || !u.user?.email) throw new HttpError(500, "session_failed");
    email = u.user.email;
    await logEvent("telegram_login", "info", uid, { client_no: p.client_no, tg_username: username }, true, ipHash);
    // Промокод, введённый на вкладке «Регистрация», если аккаунт уже был
    if (r.ref_code && normCode(r.ref_code)) {
      const { data: rr } = await admin.rpc("svc_attach_referral", { p_user: uid, p_code: r.ref_code, p_ip: r.ip_hash || ipHash });
      referral = rr;
    }
  } else {
    email = `tg${tgId}@${TG_EMAIL_DOMAIN}`;
    const { data: c, error: cErr } = await admin.auth.admin.createUser({
      email, email_confirm: true,
      user_metadata: { full_name: [firstName].filter(Boolean).join(" ") || null },
    });
    if (cErr || !c.user) throw new HttpError(500, "signup_failed");
    uid = c.user.id;
    created = true;
    const { data: l, error: lErr } = await admin.rpc("svc_tg_link", {
      p_user: uid, p_tg: tgId, p_username: username, p_first: firstName,
    });
    if (lErr || !(l as { ok: boolean }).ok) throw new HttpError(409, "telegram_taken");
    const { data: ob, error: obErr } = await admin.rpc("svc_onboard", {
      p_user: uid, p_method: "telegram", p_ref: r.ref_code || null, p_ip: r.ip_hash || ipHash, p_phone: null,
    });
    if (obErr) console.error("onboard", obErr.message);
    else referral = (ob as { referral?: unknown } | null)?.referral ?? null;
  }

  const session = await sessionForEmail(email);
  return { ok: true, status: "ok", created, referral, session: publicSession(session) };
}

async function setEmail({ req, body, ipHash }: Ctx) {
  const uid = await userFromAuthHeader(req);
  await limit(`setemail:${uid}`, 5, 3600);
  await limit(`setemail:ip:${ipHash}`, 10, 3600);
  const p = await profile(uid);
  if (!p || p.status !== "active") throw new HttpError(403, "account_blocked");
  if (p.email) throw new HttpError(409, "email_already_set");
  const email = normEmail(body.email);
  const password = checkPassword(body.password);
  const other = await authUser(email);
  if (other && other.id !== uid) throw new HttpError(409, "email_taken");

  if (!(await mailReady())) {
    const { error } = await admin.auth.admin.updateUserById(uid, { email, password, email_confirm: true });
    if (error) {
      if (/already|exists/i.test(error.message)) throw new HttpError(409, "email_taken");
      throw new HttpError(500, "update_failed");
    }
    await admin.rpc("svc_set_email", { p_user: uid, p_email: email });
    return { ok: true };
  }

  // Пароль сохраняем сразу (по нему нельзя войти, пока email не подтверждён), email — после кода
  const key = await sha256Hex(email);
  if (!(await allow(`mail:cool:${key}`, 1, 60))) throw new HttpError(429, "code_cooldown");
  const code = String(100000 + (crypto.getRandomValues(new Uint32Array(1))[0] % 900000));
  const { error: pErr } = await admin.auth.admin.updateUserById(uid, { password });
  if (pErr) throw new HttpError(500, "update_failed");
  const { error } = await admin.rpc("svc_email_change_start", { p_user: uid, p_email: email, p_code_hash: await sha256Hex(uid + "|" + code) });
  if (error) throw error;
  if (!(await mailCode(email, code, "link"))) throw new HttpError(503, "mail_failed");
  return { ok: true, status: "verify", email };
}

async function setEmailConfirm({ req, body, ipHash }: Ctx) {
  const uid = await userFromAuthHeader(req);
  await limit(`setemailc:${uid}`, 10, 900);
  await limit(`setemailc:ip:${ipHash}`, 30, 900);
  const code = str(body.code, 12).replace(/\s+/g, "");
  if (!/^[0-9]{6}$/.test(code)) throw new HttpError(400, "bad_code");
  const { data, error } = await admin.rpc("svc_email_change_check", { p_user: uid, p_code_hash: await sha256Hex(uid + "|" + code) });
  if (error) throw error;
  const r = data as { ok: boolean; error?: string; email?: string };
  if (!r.ok) throw new HttpError(400, r.error || "bad_code");
  const other = await authUser(r.email!);
  if (other && other.id !== uid) throw new HttpError(409, "email_taken");
  const { error: uErr } = await admin.auth.admin.updateUserById(uid, { email: r.email!, email_confirm: true });
  if (uErr) {
    if (/already|exists/i.test(uErr.message)) throw new HttpError(409, "email_taken");
    throw new HttpError(500, "update_failed");
  }
  await admin.rpc("svc_set_email", { p_user: uid, p_email: r.email! });
  return { ok: true };
}

async function reset({ body, ipHash }: Ctx) {
  await limit(`reset:ip:${ipHash}`, 5, 3600);
  const email = normEmail(body.email);
  const emailKey = await sha256Hex(email);
  await limit(`reset:em:${emailKey}`, 5, 3600);
  const u = await authUser(email);
  let channel = "none";
  if (u && u.status === "active") {
    try {
      const sent = await sendAuthCode(email, "reset", ipHash, u.telegram_id);
      channel = sent ? ((await mailReady()) ? "email" : "telegram") : "none";
    } catch (e) {
      if (!(e instanceof HttpError && (e.code === "code_cooldown" || e.code === "rate_limited"))) throw e;
      channel = "throttled";
    }
    await logEvent("password_reset_requested", "info", u.id, { client_no: u.client_no, channel }, null, ipHash);
  }
  // Ответ одинаковый для любого email — нельзя узнать, зарегистрирован ли адрес
  return { ok: true, mail: await mailReady() };
}

async function resetConfirm({ body, ipHash }: Ctx) {
  const email = normEmail(body.email);
  const password = checkPassword(body.password);
  const code = str(body.code, 12).replace(/\s+/g, "");
  const d = await verifyCode(email, code, "recovery", ipHash);
  const uid = d.user!.id;
  const p = await profile(uid);
  if (!p || p.status !== "active") throw new HttpError(403, "account_blocked");
  const { error } = await admin.auth.admin.updateUserById(uid, { password, email_confirm: true });
  if (error) throw new HttpError(500, "update_failed");
  // Все прежние входы на других устройствах завершаются
  await admin.auth.admin.signOut(d.session!.access_token, "others").catch(() => {});
  const meta = (d.user!.user_metadata || {}) as { signup_ref?: string; signup_phone?: string };
  await admin.rpc("svc_onboard", {
    p_user: uid, p_method: "email", p_ref: normCode(meta.signup_ref) || null, p_ip: ipHash, p_phone: meta.signup_phone || null,
  });
  await logEvent("password_reset", "info", uid, { client_no: p.client_no }, true, ipHash);
  return { ok: true, session: publicSession(d.session!) };
}

// Заявка с формы «Записаться»: только администраторам из app.admin_telegram_ids
async function lead({ body, ipHash }: Ctx) {
  if (str(body.website, 100)) return { ok: true }; // ловушка для ботов
  await limit(`lead:ip:${ipHash}`, 5, 600);
  const name = str(body.name, 60).replace(/[\u0000-\u001f]/g, " ");
  let phone = str(body.phone, 20).replace(/\D/g, "");
  if (phone.length === 11 && phone[0] === "8") phone = "7" + phone.slice(1);
  if (phone.length === 10) phone = "7" + phone;
  if (name.length < 2) throw new HttpError(400, "bad_name");
  if (!/^[0-9]{11,12}$/.test(phone)) throw new HttpError(400, "bad_phone");
  await limit(`lead:ph:${await sha256Hex(phone)}`, 3, 3600);
  let service = str(body.service, 120).replace(/[\u0000-\u001f]/g, " ");
  if (service === "promo") service = "Бесплатная консультация + процедура (акция)";
  const promo = normCode(body.promo);

  const token = await secret("telegram_bot_token");
  const { data: chats } = await admin.rpc("svc_admin_chats");
  const ids = ((chats as number[] | null) || []).map(Number).filter(Boolean);
  if (!token || !ids.length) throw new HttpError(503, "lead_not_configured");

  const time = new Date().toLocaleString("ru-RU", { timeZone: "Asia/Yekaterinburg" });
  const text =
    "🆕 <b>Заявка с сайта</b>\n\n" +
    `👤 ${escHtml(name)}\n` +
    `📞 <a href="tel:+${phone}">+${phone}</a>\n` +
    `🩺 ${escHtml(service || "—")}\n` +
    (promo ? `🎁 Промокод друга: <code>${promo}</code>\n` : "") +
    `🕒 ${time}\n\n` +
    `Написать клиенту в WhatsApp: https://wa.me/${phone}`;
  const results = await Promise.all(ids.map((id) => sendTelegram(id, text).catch(() => false)));
  const sent = results.filter(Boolean).length;
  await logEvent("site_lead", sent ? "info" : "error", null,
    { name: name.slice(0, 1) + "•••", phone: "+" + phone.slice(0, 4) + "•••" + phone.slice(-2), service: service.slice(0, 80), sent }, null, ipHash);
  if (!sent) throw new HttpError(502, "lead_failed");
  return { ok: true };
}

async function refClick({ body, ipHash }: Ctx) {
  const code = normCode(body.code);
  if (!code) return { ok: true };
  if (!(await allow(`refclick:ip:${ipHash}`, 30, 3600))) return { ok: true };
  if (await allow(`refclick:${ipHash}:${code}`, 1, 86400)) {
    await logEvent("ref_link_click", "info", null, { code }, true, ipHash);
  }
  return { ok: true };
}

async function checkCode({ body, ipHash }: Ctx) {
  await limit(`checkcode:ip:${ipHash}`, 30, 600);
  const code = normCode(body.code);
  if (!code) return { ok: true, valid: false };
  const { data } = await admin.rpc("svc_check_code", { p_code: code });
  return { ok: true, ...(data as Record<string, unknown>) };
}

const ACTIONS: Record<string, (c: Ctx) => Promise<unknown>> = {
  signup, verify, resend, login, tg_start: tgStart, tg_poll: tgPoll,
  set_email: setEmail, set_email_confirm: setEmailConfirm, reset, reset_confirm: resetConfirm,
  lead, ref_click: refClick, check_code: checkCode,
};

Deno.serve(async (req) => {
  const origin = req.headers.get("origin");
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(origin) });
  if (req.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405, origin);
  if (origin && !ALLOWED_ORIGINS.has(origin)) return json({ ok: false, error: "forbidden_origin" }, 403, origin);

  let body: Record<string, unknown>;
  try {
    const text = await req.text();
    if (text.length > 8000) return json({ ok: false, error: "too_large" }, 413, origin);
    body = JSON.parse(text || "{}");
    if (typeof body !== "object" || body === null || Array.isArray(body)) throw new Error();
  } catch {
    return json({ ok: false, error: "bad_request" }, 400, origin);
  }

  const action = ACTIONS[String(body.action || "")];
  if (!action) return json({ ok: false, error: "unknown_action" }, 400, origin);

  const ip = clientIp(req);
  try {
    const result = await action({ req, body, ip, ipHash: await ipHash(ip) });
    return json(result, 200, origin);
  } catch (e) {
    if (e instanceof HttpError) {
      if (e.code === "rate_limited") {
        await logEvent("rate_limited", "info", null, { action: body.action }, null, await ipHash(ip).catch(() => null));
      }
      return json({ ok: false, error: e.code }, e.status, origin);
    }
    const msg = e instanceof Error ? e.message : String(e);
    console.error("account error", body.action, msg);
    try {
      if (await allow(`err:account:${String(body.action)}`, 3, 600)) {
        await logEvent("system_error", "error", null, { where: `account/${body.action}`, message: msg.slice(0, 200) }, true);
      }
    } catch { /* журнал недоступен — ответ всё равно отдаём */ }
    return json({ ok: false, error: "server_error" }, 500, origin);
  }
});
