// Физиотера — серверная функция аккаунтов (Supabase Edge Function).
//
// Действия (POST JSON { action, ... }):
//   signup     — регистрация по email + пароль
//   login      — вход по email + пароль (с ограничением попыток)
//   tg_start   — начать вход/привязку через Telegram-бота
//   tg_poll    — проверить, подтвердил ли пользователь вход в боте
//   set_email  — добавить email и пароль к аккаунту, созданному через Telegram
//   reset      — восстановление пароля (ссылка в Telegram, если он привязан)
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

let secretCache: Record<string, string | null> = {};
async function secret(name: string): Promise<string | null> {
  if (name in secretCache) return secretCache[name];
  const { data, error } = await admin.rpc("svc_secret", { p_name: name });
  if (error) throw error;
  secretCache[name] = (data as string | null) ?? null;
  return secretCache[name];
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

// ---------------------------------------------------------------- actions

type Ctx = { req: Request; body: Record<string, unknown>; ip: string; ipHash: string };

async function signup({ body, ip, ipHash }: Ctx) {
  if (str(body.website, 100)) return { ok: true }; // ловушка для ботов
  await limit(`signup:ip:${ipHash}`, 6, 3600);
  const email = normEmail(body.email);
  const password = checkPassword(body.password);
  const name = str(body.name, 60);
  if (name.length < 2) throw new HttpError(400, "bad_name");
  if (body.consent !== true) throw new HttpError(400, "consent_required");
  const phone = str(body.phone, 20);
  const ref = normCode(body.ref);

  const { data, error } = await admin.auth.admin.createUser({
    email, password, email_confirm: true, user_metadata: { full_name: name },
  });
  if (error || !data.user) {
    const code = (error as { code?: string } | null)?.code;
    if (code === "email_exists" || /already been registered/i.test(error?.message || "")) {
      throw new HttpError(409, "email_taken");
    }
    throw new HttpError(500, "signup_failed");
  }
  const uid = data.user.id;
  const { data: ob, error: obErr } = await admin.rpc("svc_onboard", {
    p_user: uid, p_method: "email", p_ref: ref || null, p_ip: ipHash, p_phone: phone || null,
  });
  if (obErr) console.error("onboard", obErr.message);

  const { data: s, error: sErr } = await anonClient().auth.signInWithPassword({ email, password });
  if (sErr || !s.session) throw new HttpError(500, "login_failed");
  void ip;
  return { ok: true, session: publicSession(s.session), onboarding: ob };
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
    const { error: obErr } = await admin.rpc("svc_onboard", {
      p_user: uid, p_method: "telegram", p_ref: r.ref_code || null, p_ip: r.ip_hash || ipHash, p_phone: null,
    });
    if (obErr) console.error("onboard", obErr.message);
  }

  const session = await sessionForEmail(email);
  return { ok: true, status: "ok", created, session: publicSession(session) };
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
  const { error } = await admin.auth.admin.updateUserById(uid, { email, password, email_confirm: true });
  if (error) {
    if (/already|exists/i.test(error.message)) throw new HttpError(409, "email_taken");
    throw new HttpError(500, "update_failed");
  }
  await admin.rpc("svc_set_email", { p_user: uid, p_email: email });
  return { ok: true };
}

async function reset({ body, ipHash }: Ctx) {
  await limit(`reset:ip:${ipHash}`, 5, 3600);
  const email = normEmail(body.email);
  const emailKey = await sha256Hex(email);
  await limit(`reset:em:${emailKey}`, 3, 3600);
  const { data } = await admin.rpc("svc_user_by_email", { p_email: email });
  const u = data as { id: string; status: string; telegram_id: number | null; client_no: number } | null;
  let channel: string | null = null;

  if (u && u.status === "active") {
    const { data: link, error } = await admin.auth.admin.generateLink({ type: "recovery", email });
    const tokenHash = link?.properties?.hashed_token;
    if (!error && tokenHash) {
      const s = await settings();
      const url = `${s.site_url || "https://www.fiziotera.online"}/kabinet/?reset=${encodeURIComponent(tokenHash)}`;
      if (u.telegram_id) {
        const ok = await sendTelegram(u.telegram_id,
          "🔐 <b>Восстановление пароля на сайте «Физиотера»</b>\n\n" +
          `Чтобы задать новый пароль, откройте ссылку (действует 1 час):\n${url}\n\n` +
          "Если вы не запрашивали восстановление — просто проигнорируйте это сообщение.");
        if (ok) channel = "telegram";
      }
      if (!channel) {
        const resendKey = await secret("resend_api_key");
        const from = (await secret("mail_from")) || "Физиотера <noreply@fiziotera.online>";
        if (resendKey) {
          const r = await fetch("https://api.resend.com/emails", {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${resendKey}` },
            body: JSON.stringify({
              from, to: [email], subject: "Восстановление пароля — Физиотера",
              text: `Здравствуйте!\n\nЧтобы задать новый пароль, откройте ссылку (действует 1 час):\n${url}\n\n` +
                "Если вы не запрашивали восстановление — просто проигнорируйте письмо.\n\nКлиника «Физиотера», Уфа",
            }),
          });
          if (r.ok) channel = "email";
        }
      }
    }
    await logEvent("password_reset_requested", "info", u.id, { client_no: u.client_no, channel: channel || "none" }, null, ipHash);
  }
  // Ответ одинаковый для любого email — нельзя узнать, зарегистрирован ли адрес
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
  signup, login, tg_start: tgStart, tg_poll: tgPoll, set_email: setEmail, reset, ref_click: refClick, check_code: checkCode,
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
