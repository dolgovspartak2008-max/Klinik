// Физиотера — онлайн-курсы (Supabase Edge Function).
//
// Действия сайта (POST JSON { action, ... }, заголовок Authorization: Bearer <токен пользователя>):
//   play               — начать/продолжить просмотр урока: проверка права и единственной сессии в базе,
//                        затем короткоживущая подписанная ссылка на видео из приватного бакета
//   admin_upload_url   — (админ) одноразовая ссылка для загрузки видео или обложки прямо в хранилище
//   admin_attach_video — (админ) привязать загруженное видео к уроку, удалить старый файл
//   admin_attach_image — (админ) привязать обложку курса/комплекта или постер урока
//   admin_lesson_delete — (админ) удалить урок без прогресса учеников вместе с файлом
// Служебные задачи (?task=..., заголовок x-internal-secret — вызывает база):
//   mail               — отправить письма из очереди app.mail_outbox
//
// Ключ service_role есть только здесь (окружение Supabase); в браузер он не попадает.

import { createClient } from "npm:@supabase/supabase-js@2.49.4";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const VIDEO_BUCKET = "course-videos";
const MEDIA_BUCKET = "course-media";
const URL_TTL = 600; // секунд: ссылка на видео живёт 10 минут, потом плеер запрашивает новую
const PUBLIC_PREFIX = "/sb/storage/v1/object/public/" + MEDIA_BUCKET + "/";
const DEFAULT_MAIL_USER = "fizioteraufa@gmail.com";
const ALLOWED_ORIGINS = new Set(["https://www.fiziotera.online", "https://fiziotera.online", "http://localhost:8000"]);

const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

class HttpError extends Error {
  constructor(public status: number, public code: string, public extra: Record<string, unknown> = {}) { super(code); }
}

function headers(origin: string | null): Record<string, string> {
  const h: Record<string, string> = {
    "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", Vary: "Origin",
  };
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    h["Access-Control-Allow-Origin"] = origin;
    h["Access-Control-Allow-Headers"] = "authorization, apikey, content-type, x-client-info";
    h["Access-Control-Allow-Methods"] = "POST, OPTIONS";
  }
  return h;
}

const cache: Record<string, { v: string | null; at: number }> = {};
async function secret(name: string): Promise<string | null> {
  const c = cache[name];
  if (c && Date.now() - c.at < 60_000) return c.v;
  const { data, error } = await db.rpc("svc_secret", { p_name: name });
  if (error) throw error;
  cache[name] = { v: (data as string | null) ?? null, at: Date.now() };
  return cache[name].v;
}

function safeEqual(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a), y = new TextEncoder().encode(b);
  if (x.length !== y.length) return false;
  let d = 0;
  for (let i = 0; i < x.length; i++) d |= x[i] ^ y[i];
  return d === 0;
}

async function ipHash(req: Request): Promise<string> {
  const ip = ((req.headers.get("x-forwarded-for") || "").split(",")[0] || req.headers.get("x-real-ip") || "unknown").trim();
  const salt = (await secret("ip_salt")) || "fiziotera";
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(salt + "|" + ip));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
}

function token(req: Request): string {
  return (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
}

async function userId(req: Request): Promise<string> {
  const t = token(req);
  if (!t || t === ANON_KEY) throw new HttpError(401, "not_authenticated");
  const { data, error } = await db.auth.getUser(t);
  if (error || !data.user) throw new HttpError(401, "not_authenticated");
  return data.user.id;
}

async function requireAdmin(req: Request): Promise<string> {
  const uid = await userId(req);
  const { data, error } = await db.rpc("svc_is_admin", { p_user: uid });
  if (error) throw error;
  if (data !== true) throw new HttpError(403, "forbidden");
  return uid;
}

// Ошибка из базы: код в тексте исключения
function dbError(error: { message?: string } | null): never {
  const code = String(error?.message || "server_error");
  throw new HttpError(/^[a-z_]{3,40}$/.test(code) ? 400 : 500, /^[a-z_]{3,40}$/.test(code) ? code : "server_error");
}

// Ссылка хранилища -> путь через прокси сайта (/sb/…): работает и там, где supabase.co недоступен
function viaProxy(url: string): string {
  const u = new URL(url);
  return "/sb" + u.pathname + u.search;
}

function str(v: unknown, max: number): string { return typeof v === "string" ? v.trim().slice(0, max) : ""; }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
function uuid(v: unknown): string {
  const s = str(v, 36).toLowerCase();
  if (!UUID.test(s)) throw new HttpError(400, "bad_request");
  return s;
}
function rnd(n = 16): string {
  const a = crypto.getRandomValues(new Uint8Array(n));
  return Array.from(a).map((b) => "abcdefghijkmnpqrstuvwxyz23456789"[b % 32]).join("");
}

// ------------------------------------------------------------------ просмотр

async function play(req: Request, body: Record<string, unknown>) {
  const uid = await userId(req);
  const lesson = uuid(body.lesson_id);
  const device = str(body.device_id, 64);
  const { data, error } = await db.rpc("svc_course_play", {
    p_user: uid, p_lesson: lesson, p_device: device, p_force: body.force === true,
    p_session: null, p_ip: await ipHash(req), p_ua: str(req.headers.get("user-agent"), 200),
  });
  if (error) dbError(error);
  const r = data as { ok: boolean; error?: string; session_id?: string; video_path?: string; since?: string; device_hint?: string };
  if (!r.ok) {
    if (r.error === "other_device") throw new HttpError(409, "other_device", { since: r.since, device_hint: r.device_hint });
    throw new HttpError(r.error === "rate_limited" ? 429 : 403, r.error || "no_access");
  }
  const { data: signed, error: e2 } = await db.storage.from(VIDEO_BUCKET).createSignedUrl(r.video_path!, URL_TTL);
  if (e2 || !signed?.signedUrl) throw new HttpError(503, "video_unavailable");
  return { ok: true, session_id: r.session_id, url: viaProxy(signed.signedUrl), expires_in: URL_TTL };
}

// ------------------------------------------------------------------ админ: загрузка

const VIDEO_MAX = 50 * 1024 * 1024; // лимит файла на тарифе Supabase Free
const IMAGE_MAX = 5 * 1024 * 1024;
const IMAGE_TYPES: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };

async function adminUploadUrl(req: Request, body: Record<string, unknown>) {
  await requireAdmin(req);
  const kind = str(body.kind, 10);
  const size = Number(body.size) || 0;
  const target = uuid(body.target_id);
  let bucket: string, path: string;
  if (kind === "video") {
    if (body.content_type !== "video/mp4") throw new HttpError(400, "video_format");
    if (size <= 0 || size > VIDEO_MAX) throw new HttpError(400, "video_too_big");
    bucket = VIDEO_BUCKET; path = `lessons/${target}/${rnd(20)}.mp4`;
  } else if (kind === "image") {
    const ext = IMAGE_TYPES[String(body.content_type)];
    if (!ext) throw new HttpError(400, "image_format");
    if (size <= 0 || size > IMAGE_MAX) throw new HttpError(400, "image_too_big");
    const tk = str(body.target_kind, 10);
    if (!["course", "bundle", "lesson"].includes(tk)) throw new HttpError(400, "bad_request");
    bucket = MEDIA_BUCKET; path = `${tk}/${target}/${rnd(12)}.${ext}`;
  } else throw new HttpError(400, "bad_request");
  const { data, error } = await db.storage.from(bucket).createSignedUploadUrl(path);
  if (error || !data) throw new HttpError(503, "upload_unavailable");
  return { ok: true, path, url: data.signedUrl, proxy_url: viaProxy(data.signedUrl) };
}

async function adminAttachVideo(req: Request, body: Record<string, unknown>) {
  const admin = await requireAdmin(req);
  const lesson = uuid(body.lesson_id);
  const path = str(body.path, 200);
  const { data: info } = await db.storage.from(VIDEO_BUCKET).list(`lessons/${lesson}`, { search: path.split("/").pop() });
  const obj = (info || []).find((o) => `lessons/${lesson}/${o.name}` === path);
  if (!obj) throw new HttpError(400, "file_missing");
  const size = Number((obj.metadata as Record<string, unknown> | null)?.size) || Number(body.size) || null;
  const dur = Math.round(Number(body.duration) || 0);
  const { data, error } = await db.rpc("svc_lesson_set_video", {
    p_admin: admin, p_lesson: lesson, p_path: path, p_size: size, p_duration: dur > 0 && dur < 36000 ? dur : null, p_poster: null,
  });
  if (error) { await db.storage.from(VIDEO_BUCKET).remove([path]); dbError(error); }
  const old = (data as { old_path?: string | null }).old_path;
  if (old && old !== path) await db.storage.from(VIDEO_BUCKET).remove([old]);
  return { ok: true };
}

async function adminAttachImage(req: Request, body: Record<string, unknown>) {
  const admin = await requireAdmin(req);
  const tk = str(body.target_kind, 10);
  const target = uuid(body.target_id);
  const path = str(body.path, 200);
  if (!new RegExp(`^${tk}/${target}/[a-z0-9]{12}\\.(jpg|png|webp)$`).test(path)) throw new HttpError(400, "bad_path");
  const { data, error } = await db.rpc("svc_set_cover", { p_admin: admin, p_kind: tk, p_id: target, p_url: PUBLIC_PREFIX + path });
  if (error) dbError(error);
  const old = (data as { old_url?: string | null }).old_url;
  if (old && old.startsWith(PUBLIC_PREFIX) && old !== PUBLIC_PREFIX + path) {
    await db.storage.from(MEDIA_BUCKET).remove([old.slice(PUBLIC_PREFIX.length)]);
  }
  return { ok: true, url: PUBLIC_PREFIX + path };
}

async function adminLessonDelete(req: Request, body: Record<string, unknown>) {
  await requireAdmin(req);
  // вызываем от имени администратора — база ещё раз проверит права и прогресс учеников
  const asUser = createClient(SUPABASE_URL, ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${token(req)}` } },
  });
  const { data, error } = await asUser.rpc("admin_lesson_delete", { p_id: uuid(body.lesson_id) });
  if (error) dbError(error);
  const path = (data as { video_path?: string | null }).video_path;
  if (path) await db.storage.from(VIDEO_BUCKET).remove([path]);
  return { ok: true };
}

// ------------------------------------------------------------------ почта

async function sendMail(to: string, subject: string, text: string): Promise<string | null> {
  const pass = await secret("smtp_pass");
  if (pass) {
    try {
      const user = (await secret("smtp_user")) || DEFAULT_MAIL_USER;
      const nodemailer = (await import("npm:nodemailer@6.9.16")).default;
      const t = nodemailer.createTransport({
        host: "smtp.gmail.com", port: 465, secure: true, auth: { user, pass: pass.replace(/\s+/g, "") },
        connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 15000,
      });
      await t.sendMail({ from: `"Физиотера" <${user}>`, to, subject, text });
      return null;
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  }
  const resendKey = await secret("resend_api_key");
  if (resendKey) {
    const from = (await secret("mail_from")) || "Физиотера <noreply@fiziotera.online>";
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${resendKey}` },
      body: JSON.stringify({ from, to: [to], subject, text }),
    });
    return r.ok ? null : `resend ${r.status}`;
  }
  return "mail_not_configured";
}

async function mailTask() {
  let sent = 0, failed = 0;
  const { data, error } = await db.rpc("svc_claim_mail", { p_limit: 10 });
  if (error) throw error;
  for (const m of (data || []) as { id: number; to: string; subject: string; body: string }[]) {
    const err = await sendMail(m.to, m.subject, m.body);
    await db.rpc("svc_mail_result", { p_id: m.id, p_ok: !err, p_error: err });
    err ? failed++ : sent++;
  }
  return { ok: true, sent, failed };
}

// ------------------------------------------------------------------ HTTP

Deno.serve(async (req) => {
  const origin = req.headers.get("origin");
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: headers(origin) });
  if (req.method !== "POST") return new Response(JSON.stringify({ error: "method" }), { status: 405, headers: headers(origin) });
  const task = new URL(req.url).searchParams.get("task");
  try {
    if (task) {
      const expected = await secret("internal_secret");
      if (!expected || !safeEqual(req.headers.get("x-internal-secret") || "", expected)) {
        return new Response("forbidden", { status: 403 });
      }
      if (task === "mail") return Response.json(await mailTask());
      return Response.json({ ok: false });
    }
    const body = await req.json().catch(() => ({})) as Record<string, unknown>;
    const action = str(body.action, 40);
    let res: unknown;
    switch (action) {
      case "play": res = await play(req, body); break;
      case "admin_upload_url": res = await adminUploadUrl(req, body); break;
      case "admin_attach_video": res = await adminAttachVideo(req, body); break;
      case "admin_attach_image": res = await adminAttachImage(req, body); break;
      case "admin_lesson_delete": res = await adminLessonDelete(req, body); break;
      default: throw new HttpError(400, "bad_request");
    }
    return new Response(JSON.stringify(res), { status: 200, headers: headers(origin) });
  } catch (e) {
    if (e instanceof HttpError) {
      return new Response(JSON.stringify({ error: e.code, ...e.extra }), { status: e.status, headers: headers(origin) });
    }
    console.error("courses error", e instanceof Error ? e.message : String(e));
    return new Response(JSON.stringify({ error: "server_error" }), { status: 500, headers: headers(origin) });
  }
});
