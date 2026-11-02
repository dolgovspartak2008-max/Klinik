/*
 * Админ-панель: онлайн-курсы (категории, курсы, уроки и видео, комплекты, промокоды,
 * заказы и оплаты, доступы клиентов, аналитика). Каждое действие проверяется на сервере
 * (public.admin_* и функция courses) — интерфейс лишь удобство.
 */
(function () {
  "use strict";
  var doc = document, SB = window.SB, A = window.FZAdmin, C = window.FZC;
  if (!SB || !A || !C) return;
  var esc = C.esc, money = C.money;

  function $(s, r) { return (r || doc).querySelector(s); }
  function $$(s, r) { return Array.prototype.slice.call((r || doc).querySelectorAll(s)); }
  function toast(m) { if (window.FZToast) window.FZToast(m); }
  function fail(e) { toast(e && e.message ? e.message : "Ошибка"); }
  function dt(iso) { return iso ? new Date(iso).toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "—"; }
  function labelTables(root) {
    $$("table.adm-table", root).forEach(function (t) {
      var heads = $$("thead th", t).map(function (th) { return th.textContent; });
      $$("tbody tr", t).forEach(function (tr) { Array.prototype.forEach.call(tr.children, function (td, i) { td.setAttribute("data-label", heads[i] || ""); }); });
    });
  }
  var STATUS = { draft: "черновик", published: "в продаже", archived: "снят с продажи" };
  var O_STATUS = { pending: "ждёт оплаты", paid: "оплачен", cancelled: "отменён", expired: "просрочен", refunded: "возврат" };
  var SRC = { purchase: "покупка", bundle: "комплект", gift: "подарок", manual: "выдан вручную", promo: "промокод 100%" };
  var OVERLAP = { prorate: "цена уменьшается на стоимость купленных курсов", full: "полная цена (покупателя предупреждаем)", block: "нельзя купить, если часть курсов уже есть" };
  function chip(st, label) { return '<span class="chip-status is-' + esc(st) + '">' + esc(label) + "</span>"; }

  Object.assign(A.ev, {
    course_order_created: "Новый заказ курса", course_order_paid: "Заказ курса оплачен", course_order_cancelled: "Заказ курса отменён",
    course_refund: "Возврат за курс", course_access_granted: "Курс выдан вручную", course_access_revoked: "Доступ к курсу отозван",
    courses_blocked: "Курсы заблокированы клиенту", courses_unblocked: "Курсы разблокированы клиенту", gift_activated: "Активирован подарок",
    gift_invalid_attempt: "Неверный подарочный код", gift_reuse_attempt: "Повторная активация подарка", gift_bruteforce: "Перебор подарочных кодов",
    video_access_denied: "Попытка открыть чужое видео", video_url_flood: "Слишком много запросов видео", many_devices: "Много устройств за сутки",
    playback_takeover: "Просмотр перенесён на другое устройство", playback_killed: "Просмотр остановлен админом",
    payment_amount_mismatch: "Сумма оплаты не совпала", course_price_changed: "Изменена цена", course_status_changed: "Изменён статус курса",
    course_saved: "Курс сохранён", course_category_saved: "Категория сохранена", course_category_deleted: "Категория удалена",
    lesson_saved: "Урок сохранён", lesson_published: "Опубликован новый урок", lesson_deleted: "Урок удалён", lessons_reordered: "Изменён порядок уроков",
    lesson_video_replaced: "Загружено видео урока", course_cover_changed: "Обновлена обложка", bundle_saved: "Комплект сохранён",
    course_promo_saved: "Промокод на курсы сохранён"
  });

  // ---------------------------------------------------------------- модальное окно редактора
  var modal = $("#cmModal"), body = $("[data-cm-body]");
  function openModal(html) { body.innerHTML = html; modal.hidden = false; doc.body.classList.add("has-modal"); }
  function closeModal() { modal.hidden = true; doc.body.classList.remove("has-modal"); body.innerHTML = ""; }
  modal.addEventListener("click", function (e) { if (e.target.closest("[data-cm-close]")) closeModal(); });
  doc.addEventListener("keydown", function (e) { if (e.key === "Escape" && !modal.hidden) closeModal(); });
  function formStatus(f, t, ok) { var s = $(".acc-status", f); if (s) { s.textContent = t || ""; s.className = "acc-status" + (t ? ok ? " is-ok" : " is-error" : ""); } }
  function field(label, name, value, opts) {
    opts = opts || {};
    var input = opts.area
      ? '<textarea name="' + name + '" rows="' + (opts.rows || 4) + '" maxlength="' + (opts.max || 4000) + '">' + esc(value) + "</textarea>"
      : '<input name="' + name + '" type="' + (opts.type || "text") + '" value="' + esc(value == null ? "" : value) + '"' +
        (opts.max ? ' maxlength="' + opts.max + '"' : "") + (opts.step ? ' step="' + opts.step + '"' : "") + (opts.ph ? ' placeholder="' + esc(opts.ph) + '"' : "") + " />";
    return '<label class="field' + (opts.cls ? " " + opts.cls : "") + '"><span>' + label + (opts.hint ? " <small>— " + opts.hint + "</small>" : "") + "</span>" + input + "</label>";
  }
  function slugify(t) {
    var map = { а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "zh", з: "z", и: "i", й: "y", к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r", с: "s", т: "t", у: "u", ф: "f", х: "h", ц: "c", ч: "ch", ш: "sh", щ: "sch", ъ: "", ы: "y", ь: "", э: "e", ю: "yu", я: "ya" };
    return String(t || "").toLowerCase().split("").map(function (c) { return map[c] != null ? map[c] : c; }).join("")
      .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
  }
  function formData(f) {
    var o = {};
    $$("input, textarea, select", f).forEach(function (el) {
      if (!el.name || el.type === "file") return;
      if (el.type === "checkbox") { if (el.hasAttribute("data-multi")) { (o[el.name] = o[el.name] || []); if (el.checked) o[el.name].push(el.value); } else o[el.name] = el.checked; }
      else o[el.name] = el.value.trim();
    });
    return o;
  }

  // ---------------------------------------------------------------- загрузка файлов прямо в хранилище
  function putFile(url, file, onProgress) {
    return new Promise(function (resolve, reject) {
      var x = new XMLHttpRequest();
      x.open("PUT", url);
      x.setRequestHeader("x-upsert", "false");
      x.upload.onprogress = function (e) { if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total); };
      x.onload = function () { x.status >= 200 && x.status < 300 ? resolve() : reject(new Error("upload " + x.status)); };
      x.onerror = function () { reject(new Error("network")); };
      var fd = new FormData();
      fd.append("cacheControl", "3600");
      fd.append("", file);
      x.send(fd);
    });
  }
  function videoDuration(file) {
    return new Promise(function (resolve) {
      var v = doc.createElement("video"), u = URL.createObjectURL(file);
      v.preload = "metadata";
      v.onloadedmetadata = function () { resolve(Math.round(v.duration) || 0); URL.revokeObjectURL(u); };
      v.onerror = function () { resolve(0); URL.revokeObjectURL(u); };
      v.src = u;
    });
  }
  function upload(kind, targetKind, targetId, file, onProgress) {
    var ct = file.type || (kind === "video" ? "video/mp4" : "");
    return SB.courses("admin_upload_url", { kind: kind, target_kind: targetKind, target_id: targetId, content_type: ct, size: file.size })
      .then(function (u) {
        // сначала напрямую в Supabase, при недоступности — через прокси сайта
        return putFile(u.url, file, onProgress).catch(function () { return putFile(u.proxy_url, file, onProgress); }).then(function () { return u.path; });
      });
  }
  function uploadVideo(lessonId, file, status) {
    if (file.type && file.type !== "video/mp4") return Promise.reject({ message: SB.message("video_format") });
    if (file.size > 50 * 1024 * 1024) return Promise.reject({ message: SB.message("video_too_big") });
    var dur = 0;
    return videoDuration(file).then(function (d) { dur = d; return upload("video", "lesson", lessonId, file, function (p) { status.textContent = "Загрузка: " + Math.round(p * 100) + "%"; }); })
      .then(function (path) { status.textContent = "Сохраняем…"; return SB.courses("admin_attach_video", { lesson_id: lessonId, path: path, size: file.size, duration: dur }); });
  }
  function uploadImage(kind, id, file) {
    if (file.size > 5 * 1024 * 1024) return Promise.reject({ message: SB.message("image_too_big") });
    return upload("image", kind, id, file).then(function (path) {
      return SB.courses("admin_attach_image", { target_kind: kind, target_id: id, path: path });
    });
  }

  // ---------------------------------------------------------------- вкладка «Курсы»
  var ov = null;
  function loadCourses() {
    var p = $('[data-panel="c-courses"] [data-c-body]');
    p.innerHTML = '<p class="cab-muted">Загрузка…</p>';
    return SB.rpc("admin_courses_overview").then(function (o) {
      ov = o;
      badge(o.pending_orders);
      p.innerHTML =
        '<div class="adm-table-wrap"><table class="adm-table"><thead><tr><th>Курс</th><th>Категория</th><th>Статус</th><th>Цена</th><th>Уроки</th><th>Ученики</th><th>Продажи</th><th></th></tr></thead><tbody>' +
        (o.courses.length ? o.courses.map(function (c) {
          return "<tr><td><b>" + esc(c.title) + '</b><br><small class="cab-muted">/kursy/' + esc(c.slug) + "/</small></td>" +
            "<td>" + esc(c.category ? c.category.title : "—") + "</td><td>" + chip(c.status === "published" ? "confirmed" : c.status === "draft" ? "pending" : "cancelled", STATUS[c.status]) + "</td>" +
            "<td>" + money(c.price) + (c.old_price ? " <s class=\"cab-muted\">" + money(c.old_price) + "</s>" : "") + "</td>" +
            "<td>" + c.stats.lessons + " из " + c.lessons_all + (c.lessons_no_video ? '<br><small class="cab-muted">без видео: ' + c.lessons_no_video + "</small>" : "") + "</td>" +
            "<td>" + c.students + "</td><td>" + c.sales + "</td>" +
            '<td><div class="adm-actions"><button class="btn btn--outline btn--sm" type="button" data-c-edit="' + esc(c.id) + '">Открыть</button>' +
            (c.status === "published" ? '<a class="acc-link" href="/kursy/' + esc(c.slug) + '/" target="_blank">на сайте ↗</a>' : "") + "</div></td></tr>";
        }).join("") : '<tr><td colspan="8" class="cab-muted">Курсов пока нет.</td></tr>') + "</tbody></table></div>" +
        '<div class="cab-block"><h2>Категории</h2><p class="cab-muted cab-small">Категория показывается на сайте, только если в ней есть курсы в продаже.</p>' +
        '<div class="adm-table-wrap"><table class="adm-table"><thead><tr><th>Название</th><th>Адрес</th><th>Курсов</th><th>Порядок</th><th></th></tr></thead><tbody>' +
        o.categories.map(function (k) {
          return "<tr><td><b>" + esc(k.title) + "</b>" + (k.hidden ? " " + chip("cancelled", "скрыта") : "") + "</td><td>#" + esc(k.slug) + "</td><td>" + k.courses + "</td><td>" + k.sort + "</td>" +
            '<td><div class="adm-actions"><button class="acc-link" type="button" data-cat-edit="' + esc(k.id) + '">Изменить</button>' +
            (k.courses ? "" : '<button class="acc-link acc-link--danger" type="button" data-cat-del="' + esc(k.id) + '">Удалить</button>') + "</div></td></tr>";
        }).join("") + "</tbody></table></div></div>";
      labelTables(p);
    }).catch(function (e) { p.innerHTML = '<p class="acc-status is-error">' + esc(e.message) + "</p>"; });
  }

  function categoryForm(k) {
    k = k || { sort: (ov ? ov.categories.length + 1 : 1) };
    openModal('<h2>' + (k.id ? "Категория" : "Новая категория") + '</h2><form class="acc-form adm-cform" data-cat-form>' +
      '<input type="hidden" name="id" value="' + esc(k.id || "") + '" />' +
      field("Название", "title", k.title, { max: 120 }) + field("Адрес (латиница)", "slug", k.slug, { max: 60, hint: "для ссылки /kursy/#адрес" }) +
      field("Описание", "description", k.description, { area: 1, rows: 3, max: 1000 }) + field("Порядок", "sort", k.sort, { type: "number" }) +
      '<label class="check"><input type="checkbox" name="hidden"' + (k.hidden ? " checked" : "") + " /><span>Скрыть на сайте</span></label>" +
      '<button class="btn btn--primary acc-submit" type="submit">Сохранить</button><p class="acc-status" role="status"></p></form>');
    var f = $("[data-cat-form]");
    f.elements.title.addEventListener("input", function () { if (!k.id) f.elements.slug.value = slugify(f.elements.title.value); });
  }

  function courseForm(c) {
    var cats = ov.categories;
    c = c || { category_id: cats[0] && cats[0].id, sort: ov.courses.length + 1 };
    return '<form class="acc-form adm-cform" data-course-form>' +
      '<input type="hidden" name="id" value="' + esc(c.id || "") + '" />' +
      '<div class="adm-cgrid">' + field("Название", "title", c.title, { max: 120 }) + field("Адрес (латиница)", "slug", c.slug, { max: 60, hint: "/kursy/адрес/" }) +
      '<label class="field"><span>Категория</span><select name="category_id">' + cats.map(function (k) {
        return '<option value="' + esc(k.id) + '"' + (k.id === c.category_id ? " selected" : "") + ">" + esc(k.title) + "</option>"; }).join("") + "</select></label>" +
      field("Направление", "direction", c.direction, { max: 120, ph: "Например: Коленные суставы" }) +
      field("Цена, ₽", "price", c.price, { type: "number", step: "1" }) + field("Старая цена, ₽", "old_price", c.old_price, { type: "number", step: "1", hint: "если есть скидка" }) +
      field("Срок доступа, дней", "access_days", c.access_days, { type: "number", hint: "пусто — без ограничения" }) + field("Порядок в каталоге", "sort", c.sort, { type: "number" }) + "</div>" +
      field("Краткое описание (карточка)", "short", c.short, { area: 1, rows: 2, max: 400 }) +
      '<p class="cab-muted cab-small">В длинных текстах строка, начинающаяся с «- », станет пунктом списка; пустая строка — новый абзац.</p>' +
      field("Для кого", "for_whom", c.for_whom, { area: 1 }) + field("Какие задачи помогает решать", "tasks", c.tasks, { area: 1 }) +
      field("Программа", "program", c.program, { area: 1, rows: 3 }) + field("Чего можно ожидать (без обещаний излечения)", "results", c.results, { area: 1, rows: 3 }) +
      field("Как заниматься (рекомендации)", "recommendations", c.recommendations, { area: 1 }) +
      field("Об авторе / специалисте", "author", c.author, { area: 1, rows: 3, hint: "только проверенные данные; пусто — блок не показывается" }) +
      field("Противопоказания и меры предосторожности", "contraindications", c.contraindications, { area: 1, rows: 8, max: 6000 }) +
      field("Условия доступа", "access_terms", c.access_terms, { area: 1, rows: 3, max: 3000 }) +
      '<div class="adm-actions"><button class="btn btn--primary acc-submit" type="submit">Сохранить курс</button></div><p class="acc-status" role="status"></p></form>';
  }

  function openCourse(id) {
    curCourse = id;
    if (!id) {
      openModal("<h2>Новый курс</h2>" + courseForm(null));
      var f = $("[data-course-form]");
      f.elements.title.addEventListener("input", function () { f.elements.slug.value = slugify(f.elements.title.value); });
      return;
    }
    openModal('<p class="cab-muted">Загрузка…</p>');
    SB.rpc("admin_course_get", { p_id: id }).then(function (c) {
      var st = c.status;
      body.innerHTML = '<h2>' + esc(c.title) + " " + chip(st === "published" ? "confirmed" : st === "draft" ? "pending" : "cancelled", STATUS[st]) + "</h2>" +
        '<p class="cab-muted cab-small">Учеников: ' + c.students + " · средний прогресс: " + (c.avg_progress == null ? "—" : c.avg_progress + "%") + "</p>" +
        '<div class="adm-actions adm-cbar">' +
          (st !== "published" ? '<button class="btn btn--accent btn--sm" type="button" data-c-status="published" data-id="' + esc(c.id) + '">Опубликовать</button>' : "") +
          (st === "published" ? '<button class="btn btn--outline btn--sm" type="button" data-c-status="archived" data-id="' + esc(c.id) + '">Снять с продажи</button>' : "") +
          (st === "archived" ? '<button class="btn btn--outline btn--sm" type="button" data-c-status="draft" data-id="' + esc(c.id) + '">В черновики</button>' : "") +
          '<label class="btn btn--outline btn--sm adm-file">Обложка…<input type="file" accept="image/jpeg,image/png,image/webp" data-cover="' + esc(c.id) + '" hidden /></label>' +
          (c.cover_url ? '<img class="adm-thumb" src="' + esc(c.cover_url) + '" alt="" />' : "") +
        "</div>" +
        '<p class="cab-muted cab-small">Снятие с продажи не отнимает курс у тех, кто его уже купил.</p>' +
        "<h3>Уроки</h3>" + lessonsHtml(c) +
        '<button class="btn btn--accent btn--sm" type="button" data-l-new="' + esc(c.id) + '">+ Добавить урок</button>' +
        "<h3>Описание и цена</h3>" + courseForm(c);
    }).catch(function (e) { body.innerHTML = '<p class="acc-status is-error">' + esc(e.message) + "</p>"; });
  }

  function lessonsHtml(c) {
    if (!c.lessons.length) return '<p class="cab-empty">Уроков пока нет.</p>';
    return '<ol class="adm-lessons">' + c.lessons.map(function (l, i) {
      return '<li class="adm-lesson" data-lesson-row="' + esc(l.id) + '"><div class="adm-lesson__head">' +
        '<span class="adm-lesson__n">' + (i + 1) + "</span><div><b>" + esc(l.title) + "</b><br><small class=\"cab-muted\">" +
        (l.has_video ? "видео " + (l.duration_sec ? C.clock(l.duration_sec) : "") + (l.video_size ? " · " + (l.video_size / 1048576).toFixed(1) + " МБ" : "") : "⚠️ видео не загружено") +
        " · " + (l.hidden ? "скрыт" : "опубликован") + (l.is_free ? " · бесплатный" : "") + " · смотрели: " + l.viewers + ", прошли: " + l.completed + "</small></div>" +
        '<div class="adm-actions">' +
          (i > 0 ? '<button class="acc-link" type="button" data-l-move="-1" aria-label="Выше">↑</button>' : "") +
          (i < c.lessons.length - 1 ? '<button class="acc-link" type="button" data-l-move="1" aria-label="Ниже">↓</button>' : "") +
          '<button class="acc-link" type="button" data-l-edit>Изменить</button>' +
          '<label class="acc-link adm-file">' + (l.has_video ? "Заменить видео" : "Загрузить видео") + '<input type="file" accept="video/mp4" data-l-video hidden /></label>' +
          '<label class="acc-link adm-file">Постер<input type="file" accept="image/jpeg,image/png,image/webp" data-l-poster hidden /></label>' +
          (l.has_video ? '<button class="acc-link" type="button" data-l-toggle="' + (l.hidden ? "show" : "hide") + '">' + (l.hidden ? "Опубликовать" : "Скрыть") + "</button>" : "") +
          (!l.published_at && !l.viewers ? '<button class="acc-link acc-link--danger" type="button" data-l-del>Удалить</button>' : "") +
        '</div></div><p class="cab-muted cab-small" data-l-status></p>' +
        '<form class="acc-form adm-cform" data-lesson-form hidden><input type="hidden" name="id" value="' + esc(l.id) + '" />' +
          '<input type="hidden" name="hidden" value="' + (l.hidden ? "true" : "false") + '" />' +
          field("Название", "title", l.title, { max: 160 }) + field("Описание", "description", l.description, { area: 1, rows: 3 }) +
          field("Рекомендации к уроку", "recommendations", l.recommendations, { area: 1, rows: 3 }) +
          '<label class="check"><input type="checkbox" name="is_free"' + (l.is_free ? " checked" : "") + " /><span>Бесплатный ознакомительный урок (смотреть можно после входа на сайт, без покупки)</span></label>" +
          '<button class="btn btn--primary btn--sm acc-submit" type="submit">Сохранить урок</button><p class="acc-status" role="status"></p></form></li>';
    }).join("") + "</ol>";
  }
  var curCourse = null;
  function currentCourseId() { return curCourse; }

  // ---------------------------------------------------------------- вкладка «Заказы»
  function loadOrders() {
    var p = $('[data-panel="c-orders"] [data-c-body]');
    var st = $("[data-o-status]").value, q = $("[data-o-q]").value.trim();
    p.innerHTML = '<p class="cab-muted">Загрузка…</p>';
    return SB.rpc("admin_course_orders", { p_status: st, p_q: q, p_limit: 100, p_offset: 0 }).then(function (list) {
      if (st === "pending") badge(list.length);
      p.innerHTML = !list.length ? '<p class="cab-empty">Заказов нет.</p>' :
        '<div class="adm-table-wrap"><table class="adm-table"><thead><tr><th>Заказ</th><th>Клиент</th><th>Что</th><th>Сумма</th><th>Статус</th><th></th></tr></thead><tbody>' +
        list.map(function (o) {
          var refunded = Number(o.refunded) || 0;
          return "<tr><td><b>№ " + o.order_no + "</b><br><small class=\"cab-muted\">" + esc(dt(o.created_at)) + "</small></td>" +
            '<td><button class="acc-link" type="button" data-user="' + esc(o.user.id) + '">' + esc(o.user.name || "без имени") + ' <span class="adm-no">№ ' + o.user.client_no + "</span></button>" +
              "<br><small class=\"cab-muted\">" + esc(o.user.phone || o.user.email || "") + "</small></td>" +
            "<td>" + esc(o.title) + (o.is_gift ? " · 🎁 подарок" : "") + (o.gift ? '<br><small>код <code>' + esc(o.gift.code) + "</code> · " + (o.gift.status === "activated" ? "активирован" : o.gift.status === "cancelled" ? "аннулирован" : "не активирован") + "</small>" : "") +
              (o.note ? '<br><small class="cab-muted">' + esc(o.note) + "</small>" : "") + "</td>" +
            "<td><b>" + money(o.total) + "</b>" + (Number(o.discount) ? '<br><small class="cab-muted">скидка ' + money(o.discount) + (o.promo_code ? " · " + esc(o.promo_code) : "") + "</small>" : "") +
              (refunded ? '<br><small class="acc-link--danger">возврат ' + money(refunded) + "</small>" : "") + "</td>" +
            "<td>" + chip(o.status === "paid" ? "confirmed" : o.status, O_STATUS[o.status] || o.status) +
              (o.payment ? '<br><small class="cab-muted">' + esc(o.payment.method || o.payment.provider) + " · " + esc(dt(o.payment.created_at)) + "</small>" : "") +
              (o.cancel_reason ? '<br><small class="cab-muted">' + esc(o.cancel_reason) + "</small>" : "") + "</td>" +
            '<td><div class="adm-actions">' +
              (o.status === "pending" || o.status === "expired" ? '<button class="btn btn--accent btn--sm" type="button" data-o-paid="' + esc(o.id) + '" data-no="' + o.order_no + '" data-sum="' + esc(o.total) + '">Оплата получена</button>' +
                '<button class="acc-link acc-link--danger" type="button" data-o-cancel="' + esc(o.id) + '">Отменить</button>' : "") +
              ((o.status === "paid" || o.status === "refunded") && refunded < Number(o.total) ? '<button class="acc-link acc-link--danger" type="button" data-o-refund="' + esc(o.id) + '" data-left="' + (Number(o.total) - refunded) + '">Возврат</button>' : "") +
            "</div></td></tr>";
        }).join("") + "</tbody></table></div>";
      labelTables(p);
    }).catch(function (e) { p.innerHTML = '<p class="acc-status is-error">' + esc(e.message) + "</p>"; });
  }
  function badge(n) { var b = $("[data-c-orders-badge]"); if (b) { b.hidden = !n; b.textContent = n || ""; } }

  // ---------------------------------------------------------------- вкладка «Комплекты и промокоды»
  function loadSales() {
    var p = $('[data-panel="c-sales"] [data-c-body]');
    p.innerHTML = '<p class="cab-muted">Загрузка…</p>';
    return SB.rpc("admin_courses_overview").then(function (o) {
      ov = o;
      p.innerHTML = '<div class="cab-block"><h2>Комплекты</h2>' +
        '<div class="adm-actions"><button class="btn btn--accent btn--sm" type="button" data-b-new>+ Новый комплект</button></div>' +
        (o.bundles.length ? '<div class="adm-table-wrap"><table class="adm-table"><thead><tr><th>Комплект</th><th>Курсы</th><th>Цена</th><th>Статус</th><th>Продажи</th><th></th></tr></thead><tbody>' +
          o.bundles.map(function (b) {
            return "<tr><td><b>" + esc(b.title) + "</b><br><small class=\"cab-muted\">" + esc(OVERLAP[b.overlap_mode]) + "</small></td><td>" +
              b.courses.map(function (c) { return esc(c.title); }).join(", ") + "</td><td>" + money(b.price) + (b.old_price ? ' <s class="cab-muted">' + money(b.old_price) + "</s>" : "") +
              '<br><small class="cab-muted">по отдельности ' + money(b.courses_price) + "</small></td><td>" + chip(b.status === "published" ? "confirmed" : "pending", STATUS[b.status]) + "</td><td>" + b.sales + "</td>" +
              '<td><div class="adm-actions"><button class="acc-link" type="button" data-b-edit="' + esc(b.id) + '">Изменить</button>' +
              (b.status === "published" ? '<button class="acc-link" type="button" data-b-status="archived" data-id="' + esc(b.id) + '">Снять</button>'
                : '<button class="acc-link" type="button" data-b-status="published" data-id="' + esc(b.id) + '">Опубликовать</button>') +
              '<label class="acc-link adm-file">Обложка<input type="file" accept="image/jpeg,image/png,image/webp" data-b-cover="' + esc(b.id) + '" hidden /></label></div></td></tr>';
          }).join("") + "</tbody></table></div>" : '<p class="cab-empty">Комплектов нет.</p>') + "</div>" +
        '<div class="cab-block"><h2>Промокоды на курсы</h2><p class="cab-muted cab-small">Действуют только на онлайн-курсы. Промокоды GIFT-… из реферальной программы на курсы не распространяются. Использованным считается промокод в оплаченном заказе; открытые заказы временно резервируют лимит.</p>' +
        '<div class="adm-actions"><button class="btn btn--accent btn--sm" type="button" data-p-new>+ Новый промокод</button></div>' +
        (o.promos.length ? '<div class="adm-table-wrap"><table class="adm-table"><thead><tr><th>Код</th><th>Скидка</th><th>Где действует</th><th>Срок</th><th>Использован</th><th></th></tr></thead><tbody>' +
          o.promos.map(function (x) {
            return "<tr><td><b>" + esc(x.code) + "</b> " + (x.active ? "" : chip("cancelled", "выключен")) + (x.note ? '<br><small class="cab-muted">' + esc(x.note) + "</small>" : "") + "</td>" +
              "<td>" + (x.discount_type === "percent" ? esc(x.amount) + "%" : money(x.amount)) + "</td>" +
              "<td>" + (x.applies_all ? "все курсы и комплекты" : scopeText(x)) + "</td>" +
              "<td>" + (x.valid_from ? "с " + esc(dt(x.valid_from)) + "<br>" : "") + (x.valid_until ? "до " + esc(dt(x.valid_until)) : "без срока") + "</td>" +
              "<td>" + x.used + (x.max_uses ? " из " + x.max_uses : "") + (x.reserved ? '<br><small class="cab-muted">в открытых заказах: ' + x.reserved + "</small>" : "") +
              '<br><small class="cab-muted">на человека: ' + x.per_user + "</small></td>" +
              '<td><button class="acc-link" type="button" data-p-edit="' + esc(x.id) + '">Изменить</button></td></tr>';
          }).join("") + "</tbody></table></div>" : '<p class="cab-empty">Промокодов нет.</p>') + "</div>";
      labelTables(p);
    }).catch(function (e) { p.innerHTML = '<p class="acc-status is-error">' + esc(e.message) + "</p>"; });
  }
  function scopeText(x) {
    var names = ov.courses.filter(function (c) { return x.course_ids.indexOf(c.id) >= 0; }).map(function (c) { return c.title; })
      .concat(ov.bundles.filter(function (b) { return x.bundle_ids.indexOf(b.id) >= 0; }).map(function (b) { return "комплект «" + b.title + "»"; }));
    return esc(names.join(", ") || "—");
  }
  function checks(name, items, selected) {
    return '<div class="adm-services">' + items.map(function (i) {
      return '<label class="check"><input type="checkbox" data-multi name="' + name + '" value="' + esc(i.id) + '"' + (selected.indexOf(i.id) >= 0 ? " checked" : "") + " /><span>" + esc(i.title) + "</span></label>";
    }).join("") + "</div>";
  }
  function bundleForm(b) {
    b = b || { overlap_mode: "prorate", courses: [], sort: ov.bundles.length + 1 };
    var sel = b.courses.map(function (c) { return c.id; });
    openModal("<h2>" + (b.id ? "Комплект" : "Новый комплект") + '</h2><form class="acc-form adm-cform" data-bundle-form><input type="hidden" name="id" value="' + esc(b.id || "") + '" />' +
      '<div class="adm-cgrid">' + field("Название", "title", b.title, { max: 120 }) + field("Адрес (латиница)", "slug", b.slug, { max: 60 }) +
      field("Цена комплекта, ₽", "price", b.price, { type: "number" }) + field("Старая цена, ₽", "old_price", b.old_price, { type: "number", hint: "пусто — показываем сумму курсов" }) +
      field("Порядок", "sort", b.sort, { type: "number" }) +
      '<label class="field"><span>Если часть курсов уже куплена</span><select name="overlap_mode">' + Object.keys(OVERLAP).map(function (k) {
        return '<option value="' + k + '"' + (b.overlap_mode === k ? " selected" : "") + ">" + esc(OVERLAP[k]) + "</option>"; }).join("") + "</select></label></div>" +
      field("Описание", "description", b.description, { area: 1, rows: 3 }) +
      "<p><b>Курсы в комплекте</b></p>" + checks("course_ids", ov.courses, sel) +
      '<button class="btn btn--primary acc-submit" type="submit">Сохранить</button><p class="acc-status" role="status"></p></form>');
    var f = $("[data-bundle-form]");
    f.elements.title.addEventListener("input", function () { if (!b.id) f.elements.slug.value = slugify(f.elements.title.value); });
  }
  function isoLocal(iso) { if (!iso) return ""; var d = new Date(iso); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 16); }
  function promoForm(x) {
    x = x || { discount_type: "percent", per_user: 1, applies_all: true, active: true, course_ids: [], bundle_ids: [] };
    openModal("<h2>" + (x.id ? "Промокод" : "Новый промокод") + '</h2><form class="acc-form adm-cform" data-promo-form><input type="hidden" name="id" value="' + esc(x.id || "") + '" />' +
      '<div class="adm-cgrid">' + field("Код", "code", x.code, { max: 30, ph: "Например, OSEN2026" }) +
      '<label class="field"><span>Тип скидки</span><select name="discount_type"><option value="percent"' + (x.discount_type === "percent" ? " selected" : "") + '>процент</option><option value="fixed"' + (x.discount_type === "fixed" ? " selected" : "") + ">сумма в рублях</option></select></label>" +
      field("Размер", "amount", x.amount, { type: "number" }) + field("Всего применений", "max_uses", x.max_uses, { type: "number", hint: "пусто — без ограничения" }) +
      field("На одного человека", "per_user", x.per_user, { type: "number" }) + field("Действует с", "valid_from", isoLocal(x.valid_from), { type: "datetime-local" }) +
      field("Действует до", "valid_until", isoLocal(x.valid_until), { type: "datetime-local" }) + field("Комментарий для админов", "note", x.note, { max: 300 }) + "</div>" +
      '<label class="check"><input type="checkbox" name="active"' + (x.active ? " checked" : "") + " /><span>Промокод включён</span></label>" +
      '<label class="check"><input type="checkbox" name="applies_all"' + (x.applies_all ? " checked" : "") + " data-p-all /><span>Действует на все курсы и комплекты</span></label>" +
      '<div data-p-scope' + (x.applies_all ? " hidden" : "") + "><p><b>Курсы</b></p>" + checks("course_ids", ov.courses, x.course_ids) +
      "<p><b>Комплекты</b></p>" + checks("bundle_ids", ov.bundles, x.bundle_ids) + "</div>" +
      '<button class="btn btn--primary acc-submit" type="submit">Сохранить</button><p class="acc-status" role="status"></p></form>');
  }

  // ---------------------------------------------------------------- вкладка «Аналитика»
  function loadStats() {
    var p = $('[data-panel="c-stats"] [data-c-body]');
    p.innerHTML = '<p class="cab-muted">Загрузка…</p>';
    return SB.rpc("admin_course_analytics").then(function (a) {
      function kpi(l, v, s) { return '<div class="adm-kpi"><span>' + l + "</span><b>" + v + "</b>" + (s ? "<small>" + s + "</small>" : "") + "</div>"; }
      p.innerHTML = '<div class="adm-kpis">' +
        kpi("Оплачено", money(a.revenue), "возвраты: " + money(a.refunded)) + kpi("Продаж", a.sales, "подарков: " + a.gifts + ", бесплатных: " + a.free_orders) +
        kpi("Покупателей", a.buyers, "учеников всего: " + a.students) + kpi("Средний прогресс", (a.avg_progress == null ? "—" : a.avg_progress + "%"), "ждут оплаты: " + a.pending) + "</div>" +
        '<div class="cab-block"><h2>По курсам</h2><div class="adm-table-wrap"><table class="adm-table"><thead><tr><th>Курс</th><th>Продажи</th><th>Выручка</th><th>Ученики</th><th>Средний прогресс</th></tr></thead><tbody>' +
        a.by_course.map(function (c) { return "<tr><td>" + esc(c.title) + " " + (c.status !== "published" ? chip("pending", STATUS[c.status]) : "") + "</td><td>" + c.sales + "</td><td>" + money(c.revenue) + "</td><td>" + c.students + "</td><td>" + (c.avg_progress == null ? "—" : c.avg_progress + "%") + "</td></tr>"; }).join("") +
        "</tbody></table></div>" +
        (a.by_bundle.length ? "<h3>Комплекты</h3><div class=\"adm-table-wrap\"><table class=\"adm-table\"><thead><tr><th>Комплект</th><th>Продажи</th><th>Выручка</th></tr></thead><tbody>" +
          a.by_bundle.map(function (b) { return "<tr><td>" + esc(b.title) + "</td><td>" + b.sales + "</td><td>" + money(b.revenue) + "</td></tr>"; }).join("") + "</tbody></table></div>" : "") + "</div>" +
        '<div class="cab-block"><h2>Платежи и возвраты</h2>' + (a.payments.length ? '<div class="adm-table-wrap"><table class="adm-table"><thead><tr><th>Дата</th><th>Операция</th><th>Заказ</th><th>Сумма</th><th>Способ / причина</th></tr></thead><tbody>' +
          a.payments.map(function (x) { return "<tr><td>" + esc(dt(x.at)) + "</td><td>" + (x.kind === "refund" ? chip("refunded", "возврат") : chip("confirmed", "оплата")) + "</td><td>№ " + x.order_no + " · " + esc(x.title) + ' <span class="adm-no">клиент № ' + x.client_no + "</span></td><td>" + (x.kind === "refund" ? "−" : "") + money(x.amount) + "</td><td>" + esc(x.method || "") + "</td></tr>"; }).join("") +
          "</tbody></table></div>" : '<p class="cab-empty">Платежей пока нет.</p>') + "</div>";
      labelTables(p);
    }).catch(function (e) { p.innerHTML = '<p class="acc-status is-error">' + esc(e.message) + "</p>"; });
  }

  // ---------------------------------------------------------------- карточка клиента: курсы
  window.FZAdminUser = function (userId, box) {
    if (!box) return;
    box.innerHTML = "<h3>Онлайн-курсы</h3><p class=\"cab-muted\">Загрузка…</p>";
    SB.rpc("admin_user_courses", { p_user: userId }).then(function (x) {
      var active = x.access.filter(function (a) { return !a.revoked_at; });
      box.innerHTML = "<h3>Онлайн-курсы</h3>" +
        (x.courses_blocked ? '<p class="buy-note buy-note--warn">Доступ к курсам заблокирован: ' + esc(x.courses_block_reason || "") + "</p>" : "") +
        (x.access.length ? '<ul class="adm-list">' + x.access.map(function (a) {
          var p = a.progress || {};
          return "<li><b>" + esc(a.title) + "</b> · " + esc(SRC[a.source] || a.source) + (a.order_no ? " (заказ № " + a.order_no + ")" : "") + " · " + esc(dt(a.granted_at)) +
            (a.note ? " · «" + esc(a.note) + "»" : "") + " · прогресс " + (p.percent || 0) + "% (" + (p.completed || 0) + " из " + (p.total || 0) + ")" +
            (a.revoked_at ? ' · <span class="acc-link--danger">отозван ' + esc(dt(a.revoked_at)) + ": " + esc(a.revoke_reason || "") + "</span>"
              : ' <button class="acc-link acc-link--danger" type="button" data-a-revoke="' + esc(a.id) + '">отозвать</button>') + "</li>";
        }).join("") + "</ul>" : '<p class="cab-muted">Курсов нет.</p>') +
        '<form class="acc-form adm-cform adm-inline-form" data-a-grant><input type="hidden" name="user" value="' + esc(userId) + '" />' +
          '<label class="field"><span>Выдать курс вручную</span><select name="course">' + x.all_courses.filter(function (c) {
            return !active.some(function (a) { return a.course_id === c.id; }); }).map(function (c) { return '<option value="' + esc(c.id) + '">' + esc(c.title) + "</option>"; }).join("") + "</select></label>" +
          field("Причина", "note", "", { max: 300, ph: "Например: оплата наличными на приёме" }) + field("Дней доступа", "days", "", { type: "number", hint: "пусто — как у курса" }) +
          '<button class="btn btn--accent btn--sm acc-submit" type="submit">Выдать</button><p class="acc-status" role="status"></p></form>' +
        '<div class="adm-actions">' + (x.courses_blocked
          ? '<button class="btn btn--outline btn--sm" type="button" data-a-block="0" data-user-id="' + esc(userId) + '">Разблокировать курсы</button>'
          : '<button class="btn btn--outline btn--sm acc-link--danger" type="button" data-a-block="1" data-user-id="' + esc(userId) + '">Заблокировать курсы</button>') +
          '<button class="btn btn--outline btn--sm" type="button" data-a-kill="' + esc(userId) + '">Остановить просмотр</button></div>' +
        (x.orders.length ? "<p><b>Заказы</b></p><ul class=\"adm-list\">" + x.orders.map(function (o) {
          return "<li>№ " + o.order_no + " · " + esc(o.title) + " · " + money(o.total) + " · " + esc(O_STATUS[o.status] || o.status) + " · " + esc(dt(o.created_at)) +
            (o.gift ? " · код " + esc(o.gift.code) : "") + "</li>"; }).join("") + "</ul>" : "") +
        (x.sessions.length ? "<p><b>Последние просмотры</b></p><ul class=\"adm-list\">" + x.sessions.map(function (s) {
          return "<li>" + esc(dt(s.started_at)) + " — " + (s.ended_at ? esc(dt(s.ended_at)) + " (" + esc({ replaced: "перенесён на другое устройство", stopped: "закрыт", expired: "по таймауту", admin: "остановлен админом", revoked: "доступ отозван" }[s.end_reason] || s.end_reason) + ")" : "идёт сейчас") +
            (s.lesson ? " · «" + esc(s.lesson) + "»" : "") + ' · <small class="cab-muted">' + esc(s.device || "") + " · ссылок: " + s.urls + "</small></li>"; }).join("") + "</ul>" : "");
    }).catch(function (e) { box.innerHTML = '<p class="acc-status is-error">' + esc(e.message) + "</p>"; });
  };
  function refreshUser() { var m = $("#userModal"); if (m && m.dataset.userId) window.FZAdminUser(m.dataset.userId, $("[data-user-courses]", m)); }

  // ---------------------------------------------------------------- события
  doc.addEventListener("click", function (e) {
    var t;
    if ((t = e.target.closest("[data-c-new]"))) { (ov ? Promise.resolve() : loadCourses()).then(function () { openCourse(null); }); }
    else if ((t = e.target.closest("[data-cat-new]"))) { (ov ? Promise.resolve() : loadCourses()).then(function () { categoryForm(null); }); }
    else if ((t = e.target.closest("[data-cat-edit]"))) categoryForm(ov.categories.filter(function (k) { return k.id === t.getAttribute("data-cat-edit"); })[0]);
    else if ((t = e.target.closest("[data-cat-del]"))) {
      if (!confirm("Удалить пустую категорию?")) return;
      SB.rpc("admin_category_delete", { p_id: t.getAttribute("data-cat-del") }).then(function () { toast("Категория удалена"); loadCourses(); }).catch(fail);
    }
    else if ((t = e.target.closest("[data-c-edit]"))) openCourse(t.getAttribute("data-c-edit"));
    else if ((t = e.target.closest("[data-c-status]"))) {
      var to = t.getAttribute("data-c-status");
      if (to === "archived" && !confirm("Снять курс с продажи? Купившие сохранят доступ, открытые заказы будут отменены.")) return;
      SB.rpc("admin_course_set_status", { p_id: t.getAttribute("data-id"), p_status: to })
        .then(function () { toast("Статус изменён"); openCourse(t.getAttribute("data-id")); loadCourses(); }).catch(fail);
    }
    else if ((t = e.target.closest("[data-l-new]"))) {
      var title = prompt("Название нового урока:", "");
      if (!title) return;
      SB.rpc("admin_lesson_save", { p: { course_id: t.getAttribute("data-l-new"), title: title } })
        .then(function () { toast("Урок добавлен — загрузите к нему видео"); openCourse(t.getAttribute("data-l-new")); }).catch(fail);
    }
    else if ((t = e.target.closest("[data-l-edit]"))) { var fm = $("[data-lesson-form]", t.closest("[data-lesson-row]")); fm.hidden = !fm.hidden; }
    else if ((t = e.target.closest("[data-l-toggle]"))) {
      var row = t.closest("[data-lesson-row]"), lf = $("[data-lesson-form]", row);
      var o = formData(lf); o.hidden = t.getAttribute("data-l-toggle") === "hide";
      if (!o.hidden && !confirm("Опубликовать урок? Ученики курса получат уведомление о новом уроке (если урок публикуется впервые).")) return;
      SB.rpc("admin_lesson_save", { p: o }).then(function () { toast(o.hidden ? "Урок скрыт" : "Урок опубликован"); openCourse(currentCourseId()); }).catch(fail);
    }
    else if ((t = e.target.closest("[data-l-move]"))) {
      var ids = $$("[data-lesson-row]", body).map(function (r) { return r.getAttribute("data-lesson-row"); });
      var id = t.closest("[data-lesson-row]").getAttribute("data-lesson-row"), i = ids.indexOf(id), j = i + Number(t.getAttribute("data-l-move"));
      ids[i] = ids[j]; ids[j] = id;
      var cid = currentCourseId();
      SB.rpc("admin_lesson_reorder", { p_course: cid, p_ids: ids }).then(function () { openCourse(cid); }).catch(fail);
    }
    else if ((t = e.target.closest("[data-l-del]"))) {
      if (!confirm("Удалить урок вместе с видео? Это нельзя отменить.")) return;
      var cid2 = currentCourseId();
      SB.courses("admin_lesson_delete", { lesson_id: t.closest("[data-lesson-row]").getAttribute("data-lesson-row") })
        .then(function () { toast("Урок удалён"); openCourse(cid2); }).catch(fail);
    }
    else if ((t = e.target.closest("[data-o-paid]"))) {
      var method = prompt("Заказ № " + t.getAttribute("data-no") + " на " + money(t.getAttribute("data-sum")) + ".\nКак оплачено? (например: перевод на карту, наличные в клинике)", "перевод на карту");
      if (!method) return;
      t.disabled = true;
      SB.rpc("admin_order_mark_paid", { p_order: t.getAttribute("data-o-paid"), p_method: method, p_note: null })
        .then(function (r) { toast(r.already ? "Заказ уже был оплачен" : r.gift_code ? "Оплачено. Подарочный код: " + r.gift_code : "Оплачено — доступ выдан, клиент получит уведомление"); loadOrders(); })
        .catch(function (err) { t.disabled = false; fail(err); });
    }
    else if ((t = e.target.closest("[data-o-cancel]"))) {
      var why = prompt("Причина отмены заказа:", "Клиент передумал");
      if (why === null) return;
      SB.rpc("admin_order_cancel", { p_order: t.getAttribute("data-o-cancel"), p_reason: why }).then(function () { toast("Заказ отменён"); loadOrders(); }).catch(fail);
    }
    else if ((t = e.target.closest("[data-o-refund]"))) {
      var left = Number(t.getAttribute("data-left"));
      var sum = prompt("Сумма возврата, ₽ (не больше " + left + "). Деньги клиенту возвращаются тем же способом, что и оплата — это делаете вы; здесь возврат фиксируется.", String(left));
      if (!sum) return;
      var reason = prompt("Причина возврата (обязательно):", "");
      if (!reason) return;
      var revoke = confirm("Закрыть клиенту доступ к курсу этого заказа?\nОК — закрыть, Отмена — оставить доступ.");
      SB.rpc("admin_order_refund", { p_order: t.getAttribute("data-o-refund"), p_amount: Number(String(sum).replace(",", ".")), p_reason: reason, p_revoke: revoke })
        .then(function () { toast("Возврат оформлен"); loadOrders(); }).catch(fail);
    }
    else if ((t = e.target.closest("[data-b-new]"))) bundleForm(null);
    else if ((t = e.target.closest("[data-b-edit]"))) bundleForm(ov.bundles.filter(function (b) { return b.id === t.getAttribute("data-b-edit"); })[0]);
    else if ((t = e.target.closest("[data-b-status]"))) {
      SB.rpc("admin_bundle_set_status", { p_id: t.getAttribute("data-id"), p_status: t.getAttribute("data-b-status") })
        .then(function () { toast("Статус изменён"); loadSales(); }).catch(fail);
    }
    else if ((t = e.target.closest("[data-p-new]"))) promoForm(null);
    else if ((t = e.target.closest("[data-p-edit]"))) promoForm(ov.promos.filter(function (x) { return x.id === t.getAttribute("data-p-edit"); })[0]);
    else if ((t = e.target.closest("[data-a-revoke]"))) {
      var rr = prompt("Причина отзыва доступа (обязательно, увидят администраторы):", "");
      if (!rr) return;
      SB.rpc("admin_access_revoke", { p_access: t.getAttribute("data-a-revoke"), p_reason: rr }).then(function () { toast("Доступ отозван"); refreshUser(); }).catch(fail);
    }
    else if ((t = e.target.closest("[data-a-block]"))) {
      var on = t.getAttribute("data-a-block") === "1", br = "";
      if (on) { br = prompt("Причина блокировки курсов (например, передача доступа другим людям):", ""); if (!br) return; }
      SB.rpc("admin_courses_block", { p_user: t.getAttribute("data-user-id"), p_on: on, p_reason: br }).then(function () { toast(on ? "Курсы заблокированы" : "Курсы разблокированы"); refreshUser(); }).catch(fail);
    }
    else if ((t = e.target.closest("[data-a-kill]"))) {
      SB.rpc("admin_session_kill", { p_user: t.getAttribute("data-a-kill") }).then(function (r) { toast(r.ended ? "Просмотр остановлен" : "Сейчас клиент ничего не смотрит"); refreshUser(); }).catch(fail);
    }
  });

  doc.addEventListener("change", function (e) {
    var t = e.target, file = t.files && t.files[0];
    if (t.matches("[data-p-all]")) { $("[data-p-scope]", body).hidden = t.checked; return; }
    if (!file) return;
    if (t.matches("[data-cover]")) {
      uploadImage("course", t.getAttribute("data-cover"), file).then(function () { toast("Обложка обновлена"); openCourse(t.getAttribute("data-cover")); }).catch(fail);
    } else if (t.matches("[data-b-cover]")) {
      uploadImage("bundle", t.getAttribute("data-b-cover"), file).then(function () { toast("Обложка обновлена"); loadSales(); }).catch(fail);
    } else if (t.matches("[data-l-poster]")) {
      var lid = t.closest("[data-lesson-row]").getAttribute("data-lesson-row");
      uploadImage("lesson", lid, file).then(function () { toast("Постер обновлён"); }).catch(fail);
    } else if (t.matches("[data-l-video]")) {
      var row = t.closest("[data-lesson-row]"), st = $("[data-l-status]", row);
      st.textContent = "Готовим загрузку…";
      uploadVideo(row.getAttribute("data-lesson-row"), file, st)
        .then(function () { toast("Видео загружено"); openCourse(currentCourseId()); })
        .catch(function (err) { st.textContent = err.message || "Ошибка загрузки"; });
    }
    t.value = "";
  });

  doc.addEventListener("submit", function (e) {
    var f = e.target, btn = $(".acc-submit", f), o, call, after;
    if (f.matches("[data-cat-form]")) {
      o = formData(f); call = SB.rpc("admin_category_save", { p: o }); after = function () { closeModal(); loadCourses(); };
    } else if (f.matches("[data-course-form]")) {
      o = formData(f); call = SB.rpc("admin_course_save", { p: o });
      after = function (r) { loadCourses(); openCourse(r.id); toast("Курс сохранён"); };
    } else if (f.matches("[data-lesson-form]")) {
      o = formData(f); o.hidden = o.hidden === "true"; call = SB.rpc("admin_lesson_save", { p: o });
      after = function () { toast("Урок сохранён"); openCourse(currentCourseId()); };
    } else if (f.matches("[data-bundle-form]")) {
      o = formData(f); call = SB.rpc("admin_bundle_save", { p: o }); after = function () { closeModal(); toast("Комплект сохранён"); loadSales(); };
    } else if (f.matches("[data-promo-form]")) {
      o = formData(f);
      o.valid_from = o.valid_from ? new Date(o.valid_from).toISOString() : ""; o.valid_until = o.valid_until ? new Date(o.valid_until).toISOString() : "";
      if (o.applies_all) { o.course_ids = []; o.bundle_ids = []; }
      call = SB.rpc("admin_promo_save", { p: o }); after = function () { closeModal(); toast("Промокод сохранён"); loadSales(); };
    } else if (f.matches("[data-a-grant]")) {
      o = formData(f);
      call = SB.rpc("admin_access_grant", { p_user: o.user, p_course: o.course, p_note: o.note, p_days: o.days ? Number(o.days) : null });
      after = function () { toast("Курс выдан, клиент получит уведомление"); refreshUser(); };
    } else return;
    e.preventDefault();
    if (btn) btn.disabled = true;
    formStatus(f, "");
    call.then(function (r) { after(r); }).catch(function (err) { formStatus(f, err.message, false); })
      .then(function () { if (btn) btn.disabled = false; });
  });

  $("[data-o-form]").addEventListener("submit", function (e) { e.preventDefault(); loadOrders(); });
  $("[data-o-status]").addEventListener("change", loadOrders);

  Object.assign(A.loaders, { "c-courses": loadCourses, "c-orders": loadOrders, "c-sales": loadSales, "c-stats": loadStats });
  // счётчик заказов, ожидающих оплаты
  setTimeout(function () { if (SB.isSignedIn()) SB.rpc("admin_course_orders", { p_status: "pending", p_q: "", p_limit: 200, p_offset: 0 }).then(function (l) { badge(l.length); }).catch(function () {}); }, 800);
})();
