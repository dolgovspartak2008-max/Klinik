/* Админ-панель. Права проверяются на сервере в каждой функции admin_* — скрытие кнопок здесь лишь удобство. */
(function () {
  "use strict";
  var doc = document;
  var SB = window.SB;
  var F = window.FZFormat || {};
  var esc = F.esc;
  var overview = null;

  function $(s, r) { return (r || doc).querySelector(s); }
  function $$(s, r) { return Array.prototype.slice.call((r || doc).querySelectorAll(s)); }
  function toast(m) { if (window.FZToast) window.FZToast(m); }
  function state(n) { $$("[data-state]").forEach(function (s) { s.hidden = s.getAttribute("data-state") !== n; }); }
  function dt(iso) { return iso ? new Date(iso).toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "—"; }
  function d(iso) { return iso ? new Date(iso).toLocaleDateString("ru-RU") : "—"; }
  function who(u) { return u ? esc(u.name || "без имени") + ' <span class="adm-no">№ ' + esc(u.client_no) + "</span>" : "—"; }

  var B_STATUS = { available: "доступен", pending: "ожидает", used: "использован", expired: "истёк", cancelled: "отменён" };
  var R_STATUS = { pending: "ожидает", confirmed: "подтверждено", cancelled: "отменено", refunded: "возврат" };
  var REF_STATUS = { registered: "зарегистрировался", qualified: "получил услугу", cancelled: "отменено" };
  var U_STATUS = { active: "активен", blocked: "заблокирован", deleted: "удалён" };
  var EV = {
    user_registered: "Новая регистрация", login: "Вход по email", telegram_login: "Вход через Telegram",
    telegram_linked: "Привязан Telegram", telegram_link_conflict: "Попытка привязать чужой Telegram",
    login_failed: "Неудачный вход", login_bruteforce: "Подбор пароля", blocked_login_attempt: "Вход в заблокированный аккаунт",
    referral_applied: "Применён промокод друга", ref_link_click: "Переход по реферальной ссылке", ref_code_invalid: "Неверный промокод",
    self_referral_attempt: "Попытка применить свой промокод", self_referral_suspected: "Приглашение самого себя",
    repeat_referral_attempt: "Повторный ввод промокода", duplicate_bonus_attempt: "Попытка повторно получить бонус",
    duplicate_phone: "Телефон у нескольких аккаунтов", suspicious_signups: "Много регистраций из одной сети",
    bonus_issued: "Начислен бонус", bonus_requested: "Запрос на скидку", bonus_confirmed: "Скидка подтверждена",
    bonus_request_cancelled: "Запрос на скидку отменён", bonus_refunded: "Возврат", bonus_cancelled: "Бонус отменён",
    referral_qualified: "Приглашённый получил услугу", reward_used_before_refund: "Награда использована до возврата",
    user_blocked: "Блокировка", user_unblocked: "Разблокировка", user_deleted: "Аккаунт удалён",
    rules_changed: "Изменены условия скидок", settings_changed: "Изменены настройки", service_toggled: "Изменён список услуг",
    password_reset_requested: "Восстановление пароля", email_added: "Добавлен email", rate_limited: "Превышен лимит запросов",
    system_error: "Ошибка системы", bonus_granted: "Начислена персональная скидка", broadcast_sent: "Рассылка",
    news_subscribed: "Подписался на новости", news_unsubscribed: "Отписался от новостей"
  };
  var KIND = { welcome: "подарок за регистрацию", referral_invitee: "по приглашению", referrer_reward: "за друга", manual: "персональная" };

  // подписи столбцов для карточного вида таблиц на телефоне
  function labelTables(root) {
    $$("table.adm-table", root).forEach(function (t) {
      var heads = $$("thead th", t).map(function (th) { return th.textContent; });
      $$("tbody tr", t).forEach(function (tr) {
        Array.prototype.forEach.call(tr.children, function (td, i) { td.setAttribute("data-label", heads[i] || ""); });
      });
    });
  }
  function fail(err) { toast(err && err.message ? err.message : "Ошибка"); }

  // ---------------------------------------------------------------- вкладки
  var loaded = {};
  function openTab(name) {
    $$("[data-tab]").forEach(function (t) { t.setAttribute("aria-selected", String(t.getAttribute("data-tab") === name)); });
    $$("[data-panel]").forEach(function (p) { p.hidden = p.getAttribute("data-panel") !== name; });
    history.replaceState(null, "", "#" + name);
    if (!loaded[name] || name === "requests" || name === "overview" || name === "broadcast") { loaded[name] = true; LOADERS[name](); }
  }
  doc.addEventListener("click", function (e) {
    var t = e.target.closest("[data-tab]");
    if (t) openTab(t.getAttribute("data-tab"));
  });

  // ---------------------------------------------------------------- обзор
  function loadOverview() {
    return SB.rpc("admin_overview").then(function (o) {
      overview = o;
      var b = o.bonuses || {};
      var badge = $("[data-pending-badge]");
      badge.hidden = !o.redemptions_pending;
      badge.textContent = o.redemptions_pending;
      var max = Math.max.apply(null, o.series.map(function (s) { return Math.max(s.users, s.referrals, s.confirmed); }).concat([1]));
      $('[data-panel="overview"]').innerHTML =
        '<div class="adm-kpis">' +
          kpi("Клиентов", o.users_total, "сегодня +" + o.users_today + ", за неделю +" + o.users_7d) +
          kpi("Ждут подтверждения", o.redemptions_pending, "скидок на приёме", o.redemptions_pending ? "requests" : "") +
          kpi("Приглашений", o.referrals_total, "получили услугу: " + o.referrals_qualified) +
          kpi("Подозрительных событий", o.suspicious_7d, "за 7 дней", o.suspicious_7d ? "events" : "") +
        "</div>" +
        '<div class="adm-row">' +
          '<div class="cab-block"><h2>Последние 14 дней</h2>' +
            '<div class="adm-chart" role="img" aria-label="Регистрации, приглашения и подтверждённые скидки по дням">' +
            o.series.map(function (s) {
              return '<div class="adm-chart__day" title="' + esc(d(s.day)) + ": регистраций " + s.users + ", приглашений " + s.referrals + ", скидок " + s.confirmed + '">' +
                '<div class="adm-chart__bars">' +
                  '<span class="b1" style="height:' + (s.users / max * 100) + '%"></span>' +
                  '<span class="b2" style="height:' + (s.referrals / max * 100) + '%"></span>' +
                  '<span class="b3" style="height:' + (s.confirmed / max * 100) + '%"></span></div>' +
                "<small>" + esc(new Date(s.day).getDate()) + "</small></div>";
            }).join("") + "</div>" +
            '<p class="adm-legend"><span class="b1"></span>регистрации <span class="b2"></span>приглашения <span class="b3"></span>подтверждённые скидки</p></div>' +
          '<div class="cab-block"><h2>Бонусы</h2><dl class="cab-dl">' +
            ["available", "pending", "used", "expired", "cancelled"].map(function (k) {
              return "<div><dt>" + B_STATUS[k] + "</dt><dd>" + (b[k] || 0) + "</dd></div>";
            }).join("") +
            "<div><dt>Реферальная программа</dt><dd>" + (o.settings.referral_enabled ? "включена" : "выключена") + "</dd></div>" +
            "<div><dt>Привязали Telegram</dt><dd>" + o.telegram_linked + "</dd></div>" +
            "<div><dt>Заблокировано</dt><dd>" + o.blocked + "</dd></div>" +
          "</dl></div>" +
        "</div>";
    }).catch(fail);
  }
  function kpi(label, value, sub, link) {
    return '<div class="adm-kpi' + (link ? " is-link" : "") + '"' + (link ? ' data-tab="' + link + '" role="button" tabindex="0"' : "") + ">" +
      "<span>" + esc(label) + "</span><b>" + esc(value) + "</b><small>" + esc(sub) + "</small></div>";
  }

  // ---------------------------------------------------------------- запросы
  function loadRequests() {
    var st = $("[data-req-filter]").value;
    var box = $("[data-req-list]");
    box.innerHTML = '<p class="cab-muted">Загрузка…</p>';
    return SB.rpc("admin_redemptions", { p_status: st, p_limit: 100, p_offset: 0 }).then(function (list) {
      if (!list.length) { box.innerHTML = '<p class="cab-empty">' + (st === "pending" ? "Новых запросов нет." : "Ничего не найдено.") + "</p>"; return; }
      box.innerHTML = '<div class="adm-table-wrap"><table class="adm-table"><thead><tr>' +
        "<th>Клиент</th><th>Телефон</th><th>Скидка</th><th>Услуга</th><th>Запрошено</th><th>Статус</th><th></th></tr></thead><tbody>" +
        list.map(function (r) {
          var act = r.status === "pending"
            ? '<button class="btn btn--accent btn--sm" data-decide="confirm" data-id="' + esc(r.id) + '">Услуга оказана</button>' +
              '<button class="btn btn--outline btn--sm" data-decide="cancel" data-id="' + esc(r.id) + '">Не состоялась</button>'
            : r.status === "confirmed" ? '<button class="acc-link acc-link--danger" data-decide="refund" data-id="' + esc(r.id) + '">Оформить возврат</button>' : "";
          return "<tr><td><button class=\"acc-link\" data-user=\"" + esc(r.user.id) + "\">" + who(r.user) + "</button>" +
            (r.invited_by ? '<br><small class="cab-muted">по коду ' + esc(r.invited_by) + "</small>" : "") + "</td>" +
            "<td>" + esc(r.phone) + "</td><td><b>" + esc(F.discount(r.bonus)) + "</b><br><small>" + esc(r.bonus.title) + "</small></td>" +
            "<td>" + esc(r.service) + "</td><td>" + esc(dt(r.requested_at)) + "</td>" +
            '<td><span class="chip-status is-' + esc(r.status) + '">' + esc(R_STATUS[r.status]) + "</span>" + (r.note ? '<br><small class="cab-muted">' + esc(r.note) + "</small>" : "") + "</td>" +
            '<td class="adm-actions">' + act + "</td></tr>";
        }).join("") + "</tbody></table></div>";
      labelTables(box);
    }).catch(fail);
  }
  $("[data-req-filter]").addEventListener("change", loadRequests);

  doc.addEventListener("click", function (e) {
    var b = e.target.closest("[data-decide]");
    if (!b) return;
    var dec = b.getAttribute("data-decide");
    var note = null;
    if (dec === "refund") {
      note = prompt("Возврат за услугу: бонус клиента будет отменён, награда пригласившему — тоже. Комментарий (необязательно):", "");
      if (note === null) return;
    } else if (dec === "cancel") {
      if (!confirm("Визит не состоялся? Бонус снова станет доступен клиенту.")) return;
    }
    b.disabled = true;
    SB.rpc("admin_decide", { p_redemption: b.getAttribute("data-id"), p_decision: dec, p_note: note })
      .then(function () {
        toast(dec === "confirm" ? "Скидка подтверждена" : dec === "cancel" ? "Запрос отменён" : "Возврат оформлен");
        loadRequests(); loadOverview();
        var open = $("#userModal"); if (!open.hidden && open.dataset.userId) openUser(open.dataset.userId);
      })
      .catch(function (err) { b.disabled = false; fail(err); });
  });

  // ---------------------------------------------------------------- клиенты
  function loadUsers(q) {
    var box = $("[data-user-list]");
    box.innerHTML = '<p class="cab-muted">Загрузка…</p>';
    return SB.rpc("admin_users", { p_q: q || "", p_limit: 50, p_offset: 0 }).then(function (r) {
      if (!r.items.length) { box.innerHTML = '<p class="cab-empty">Никого не нашлось. Проверьте написание или ищите по номеру телефона.</p>'; return; }
      box.innerHTML = '<p class="cab-muted">Найдено: ' + r.total + (r.total > r.items.length ? " (показаны последние " + r.items.length + ")" : "") + "</p>" +
        '<div class="adm-table-wrap"><table class="adm-table"><thead><tr><th>Клиент</th><th>Телефон</th><th>Email / Telegram</th><th>Промокод</th><th>Пригласил друзей</th><th>Регистрация</th><th>Статус</th></tr></thead><tbody>' +
        r.items.map(function (u) {
          return '<tr><td><button class="acc-link" data-user="' + esc(u.id) + '">' + who(u) + "</button>" + (u.is_admin ? ' <span class="chip-status is-used">админ</span>' : "") + "</td>" +
            "<td>" + esc(u.phone || "—") + "</td><td>" + esc(u.email || "—") + (u.telegram && u.telegram.username ? "<br>@" + esc(u.telegram.username) : "") + "</td>" +
            "<td>" + esc(u.ref_code) + "</td><td>" + esc(u.invites) + (u.invited_by ? '<br><small class="cab-muted">пришёл по ' + esc(u.invited_by) + "</small>" : "") + "</td>" +
            "<td>" + esc(d(u.created_at)) + "</td>" +
            '<td><span class="chip-status ' + (u.status === "active" ? "is-available" : "is-muted") + '">' + esc(U_STATUS[u.status]) + "</span></td></tr>";
        }).join("") + "</tbody></table></div>";
      labelTables(box);
    }).catch(fail);
  }
  $("[data-user-search]").addEventListener("submit", function (e) { e.preventDefault(); loadUsers(e.target.elements.q.value); });

  function openUser(id) {
    var m = $("#userModal");
    m.dataset.userId = id;
    m.hidden = false;
    var box = $("[data-user-detail]");
    box.innerHTML = '<p class="cab-muted">Загрузка…</p>';
    SB.rpc("admin_user", { p_user: id }).then(function (x) {
      var u = x.user;
      box.innerHTML =
        '<h2 id="userModalTitle">' + esc(u.name || "Без имени") + ' <span class="adm-no">№ ' + esc(u.client_no) + "</span></h2>" +
        '<dl class="cab-dl">' +
          "<div><dt>Статус</dt><dd>" + esc(U_STATUS[u.status]) + (u.status_reason ? " — " + esc(u.status_reason) : "") + "</dd></div>" +
          "<div><dt>Телефон</dt><dd>" + esc(u.phone || "—") + "</dd></div>" +
          "<div><dt>Email</dt><dd>" + esc(u.email || "—") + "</dd></div>" +
          "<div><dt>Telegram</dt><dd>" + (u.telegram ? "@" + esc(u.telegram.username || u.telegram.id) : "—") + "</dd></div>" +
          "<div><dt>Новости в Telegram</dt><dd>" + (u.news_opt_in && u.telegram ? "подписан" : "нет") + "</dd></div>" +
          "<div><dt>Промокод</dt><dd>" + esc(u.ref_code) + "</dd></div>" +
          "<div><dt>Регистрация</dt><dd>" + esc(dt(u.created_at)) + " · " + (u.signup_method === "telegram" ? "Telegram" : "Email") + "</dd></div>" +
          "<div><dt>Пригласил его</dt><dd>" + (x.referrer ? who(x.referrer) + " · " + esc(x.referrer.code) + (x.referrer.same_network ? " · ⚠️ одна сеть" : "") : "—") + "</dd></div>" +
        "</dl>" +
        (u.status === "deleted" || u.is_admin ? "" :
          '<div class="adm-actions">' + (u.status === "active"
            ? '<button class="btn btn--outline btn--sm acc-link--danger" data-block="' + esc(u.id) + '">Заблокировать</button>'
            : '<button class="btn btn--outline btn--sm" data-unblock="' + esc(u.id) + '">Разблокировать</button>') + "</div>") +
        "<h3>Бонусы</h3>" +
        (u.status === "active" ? '<button class="btn btn--accent btn--sm" type="button" data-grant-open>+ Начислить скидку</button>' +
          '<div data-grant-box hidden></div>' : "") +
        (x.bonuses.length ? x.bonuses.map(function (b) {
          return '<div class="adm-bonus"><div><b>' + esc(F.discount(b)) + "</b> · " + esc(b.title) +
            (KIND[b.kind] ? ' <small class="cab-muted">(' + esc(KIND[b.kind]) + ")</small>" : "") +
            ' <span class="chip-status is-' + esc(b.status) + '">' + esc(B_STATUS[b.status]) + "</span><br><small class=\"cab-muted\">до " + esc(d(b.expires_at)) +
            (b.cancel_reason ? " · " + esc(b.cancel_reason) : "") +
            (b.kind === "manual" ? "<br>Начислил: " + esc(b.issued_by || "администратор") + (b.admin_note ? " · «" + esc(b.admin_note) + "»" : "") : "") + "</small>" +
            (b.redemptions.length ? "<ul>" + b.redemptions.map(function (r) {
              return "<li>" + esc(dt(r.requested_at)) + " — " + esc(r.service) + ": " + esc(R_STATUS[r.status]) + "</li>";
            }).join("") + "</ul>" : "") + "</div>" +
            (b.status === "available" || b.status === "pending" ? '<button class="acc-link acc-link--danger" data-cancel-bonus="' + esc(b.id) + '">Отменить бонус</button>' : "") +
            "</div>";
        }).join("") : '<p class="cab-muted">Бонусов нет.</p>') +
        "<h3>Пригласил (" + x.invited.length + ")</h3>" +
        (x.invited.length ? "<ul class=\"adm-list\">" + x.invited.map(function (i) {
          return '<li><button class="acc-link" data-user="' + esc(i.user_id) + '">' + who(i) + "</button> · " + esc(d(i.created_at)) + " · " + esc(REF_STATUS[i.status]) + (i.same_network ? " · ⚠️ одна сеть" : "") + "</li>";
        }).join("") + "</ul>" : '<p class="cab-muted">Никого.</p>') +
        "<h3>Журнал действий</h3><ol class=\"adm-events adm-events--compact\">" + x.events.map(eventRow).join("") + "</ol>";
      m.dataset.tg = u.telegram ? "1" : "";
      $(".modal__close", m).focus();
    }).catch(fail);
  }
  function closeUser() { var m = $("#userModal"); m.hidden = true; delete m.dataset.userId; }
  doc.addEventListener("keydown", function (e) { if (e.key === "Escape" && !$("#userModal").hidden) closeUser(); });

  doc.addEventListener("click", function (e) {
    var t = e.target.closest("[data-user],[data-close-user],[data-block],[data-unblock],[data-cancel-bonus]");
    if (!t) return;
    if (t.hasAttribute("data-close-user")) return closeUser();
    if (t.hasAttribute("data-user")) return openUser(t.getAttribute("data-user"));
    var reason;
    if (t.hasAttribute("data-block")) {
      reason = prompt("Причина блокировки (увидят только администраторы):", "");
      if (reason === null) return;
      SB.rpc("admin_set_user_status", { p_user: t.getAttribute("data-block"), p_status: "blocked", p_reason: reason })
        .then(function () { toast("Аккаунт заблокирован"); openUser(t.getAttribute("data-block")); }).catch(fail);
    } else if (t.hasAttribute("data-unblock")) {
      SB.rpc("admin_set_user_status", { p_user: t.getAttribute("data-unblock"), p_status: "active", p_reason: "Разблокирован" })
        .then(function () { toast("Аккаунт разблокирован"); openUser(t.getAttribute("data-unblock")); }).catch(fail);
    } else if (t.hasAttribute("data-cancel-bonus")) {
      reason = prompt("Отменить бонус как неправомерный? Право на подарок не вернётся. Причина:", "");
      if (reason === null) return;
      SB.rpc("admin_cancel_bonus", { p_bonus: t.getAttribute("data-cancel-bonus"), p_reason: reason })
        .then(function () { toast("Бонус отменён"); openUser($("#userModal").dataset.userId); }).catch(fail);
    }
  });

  // ---------------------------------------------------------------- персональная скидка
  function grantForm(services, hasTg) {
    return '<form class="adm-grant" data-grant-form novalidate>' +
      '<label class="field"><span>Как скидка будет называться у клиента</span><input name="title" maxlength="80" value="Персональная скидка" required /></label>' +
      '<div class="adm-rule__main">' +
        '<label class="field"><span>Размер скидки</span><span class="adm-amount">' +
          '<input name="amount" type="number" min="1" step="1" inputmode="decimal" placeholder="10" required />' +
          '<select name="discount_type" aria-label="Проценты или рубли"><option value="percent">%</option><option value="fixed">₽</option></select></span></label>' +
        '<label class="field"><span>Сколько дней действует</span><input name="valid_days" type="number" min="1" max="3650" value="30" required /></label>' +
      "</div>" +
      '<details class="adm-rule__more"><summary>Дополнительно</summary>' +
        '<label class="field"><span>Сколько раз можно использовать</span><input name="max_uses" type="number" min="1" max="100" value="1" /></label>' +
        '<label class="check"><input type="checkbox" name="stackable" /><span>Можно использовать вместе с другими скидками</span></label>' +
        '<label class="check"><input type="checkbox" name="all_services" checked /><span>Действует на все услуги</span></label>' +
        '<div class="adm-services" data-grant-svc hidden>' + services.filter(function (x) { return x.active; }).map(function (x) {
          return '<label class="check"><input type="checkbox" name="svc" value="' + esc(x.id) + '" /><span>' + esc(x.title) + "</span></label>";
        }).join("") + "</div>" +
      "</details>" +
      '<label class="field"><span>Комментарий для администраторов <small>— клиент его не видит</small></span><input name="note" maxlength="300" placeholder="Например: извинения за перенос приёма" /></label>' +
      '<label class="check"><input type="checkbox" name="notify"' + (hasTg ? " checked" : " disabled") + " /><span>" +
        (hasTg ? "Сообщить клиенту в Telegram" : "Сообщить в Telegram нельзя — клиент не привязал Telegram") + "</span></label>" +
      '<div class="adm-actions"><button class="btn btn--primary acc-submit" type="submit">Начислить</button>' +
      '<button class="btn btn--outline" type="button" data-grant-cancel>Отмена</button></div>' +
      '<p class="acc-status" role="status" aria-live="polite"></p></form>';
  }
  doc.addEventListener("click", function (e) {
    var open = e.target.closest("[data-grant-open]");
    var cancel = e.target.closest("[data-grant-cancel]");
    if (!open && !cancel) return;
    var box = $("[data-grant-box]");
    if (cancel) { box.hidden = true; box.innerHTML = ""; $("[data-grant-open]").hidden = false; return; }
    (overview ? Promise.resolve() : loadOverview()).then(function () {
      box.innerHTML = grantForm((overview && overview.services) || [], !!$("#userModal").dataset.tg);
      box.hidden = false; open.hidden = true;
      $('[name="amount"]', box).focus();
    });
  });
  doc.addEventListener("change", function (e) {
    var t = e.target;
    if (t.name === "all_services" && t.form && t.form.hasAttribute("data-grant-form")) $("[data-grant-svc]", t.form).hidden = t.checked;
  });
  doc.addEventListener("submit", function (e) {
    var f = e.target;
    if (!f.hasAttribute("data-grant-form")) return;
    e.preventDefault();
    var el = f.elements, st = $(".acc-status", f);
    var bonus = {
      title: el.title.value.trim(), discount_type: el.discount_type.value, amount: el.amount.value,
      valid_days: el.valid_days.value, max_uses: el.max_uses.value || "1", stackable: el.stackable.checked,
      all_services: el.all_services.checked, service_ids: $$('input[name="svc"]:checked', f).map(function (x) { return x.value; }),
      note: el.note.value, notify: el.notify.checked
    };
    var n = Number(bonus.amount);
    var problem = bonus.title.length < 3 ? SB.message("bad_title")
      : !(n > 0) || (bonus.discount_type === "percent" && n > 100) || n > 100000 ? SB.message("bad_amount")
      : !(Number(bonus.valid_days) >= 1 && Number(bonus.valid_days) <= 3650) ? SB.message("bad_days")
      : !bonus.all_services && !bonus.service_ids.length ? SB.message("no_services") : "";
    if (problem) { st.textContent = problem; st.className = "acc-status is-error"; return; }
    var who = $("#userModalTitle").textContent;
    if (!confirm("Начислить «" + bonus.title + "» — " + F.discount(bonus) + " на " + bonus.valid_days + " дн.\nКлиент: " + who + "?")) return;
    var btn = $(".acc-submit", f); btn.disabled = true;
    SB.rpc("admin_grant_bonus", { p_user: $("#userModal").dataset.userId, p_bonus: bonus })
      .then(function (r) {
        toast(r.notified ? "Скидка начислена, клиенту отправлено сообщение в Telegram" : "Скидка начислена — клиент увидит её в личном кабинете");
        openUser($("#userModal").dataset.userId); loadOverview();
      })
      .catch(function (err) { btn.disabled = false; st.textContent = err.message; st.className = "acc-status is-error"; });
  });

  // ---------------------------------------------------------------- рассылка
  function loadBroadcast() {
    return SB.rpc("admin_broadcast_info").then(function (x) {
      var f = $("[data-bc-form]");
      f.dataset.audience = x.audience;
      $("[data-bc-audience]").innerHTML = "Подписаны на новости: <b>" + esc(x.audience) + "</b> из " + esc(x.telegram_total) + " клиентов с Telegram";
      $("[data-bc-send]").textContent = x.audience ? "Отправить подписчикам (" + x.audience + ")" : "Отправить подписчикам";
      $("[data-bc-send]").disabled = !x.audience;
      $("[data-bc-test]").disabled = !x.admin_has_telegram;
      $("[data-bc-test]").title = x.admin_has_telegram ? "" : SB.message("no_telegram");
      var h = $("[data-bc-history]");
      if (!x.history.length) { h.innerHTML = '<p class="cab-empty">Рассылок ещё не было.</p>'; return; }
      h.innerHTML = '<div class="adm-table-wrap"><table class="adm-table"><thead><tr><th>Дата</th><th>Текст</th><th>Кто</th><th>Доставлено</th></tr></thead><tbody>' +
        x.history.map(function (b) {
          var txt = b.text.length > 140 ? b.text.slice(0, 140) + "…" : b.text;
          var stat = b.is_test ? "проверка себе" :
            esc(b.sent) + " из " + esc(b.recipients) + (b.queued ? " · в очереди " + esc(b.queued) : "") + (b.failed ? " · не доставлено " + esc(b.failed) : "");
          return "<tr><td>" + esc(dt(b.created_at)) + '</td><td class="adm-bc__text">' + esc(txt) + "</td><td>" + esc(b.by || "—") + "</td><td>" + stat + "</td></tr>";
        }).join("") + "</tbody></table></div>";
      labelTables(h);
    }).catch(fail);
  }
  $("[data-bc-form] textarea").addEventListener("input", function (e) {
    $("[data-bc-count]").textContent = e.target.value.length + " / 3500";
  });
  function sendBroadcast(test) {
    var f = $("[data-bc-form]");
    var text = f.elements.text.value.trim();
    var st = $(".acc-status", f);
    if (text.length < 5) { st.textContent = SB.message("text_too_short"); st.className = "acc-status is-error"; f.elements.text.focus(); return; }
    if (!test && !confirm("Отправить сообщение " + f.dataset.audience + " подписчикам? Отменить отправку будет нельзя.")) return;
    var btns = $$("[data-bc-test],[data-bc-send]"); btns.forEach(function (b) { b.disabled = true; });
    st.textContent = ""; st.className = "acc-status";
    SB.rpc("admin_broadcast", { p_text: text, p_button: f.elements.button.checked, p_test: test })
      .then(function (r) {
        toast(test ? "Проверочное сообщение отправлено вам в Telegram" : "Рассылка запущена: " + r.recipients + " получателей");
        if (!test) { f.reset(); $("[data-bc-count]").textContent = "0 / 3500"; }
        loadBroadcast();
        if (!test) setTimeout(loadBroadcast, 8000); // обновить счётчик доставленных
      })
      .catch(function (err) { st.textContent = err.message; st.className = "acc-status is-error"; loadBroadcast(); });
  }
  $("[data-bc-form]").addEventListener("submit", function (e) { e.preventDefault(); sendBroadcast(false); });
  $("[data-bc-test]").addEventListener("click", function () { sendBroadcast(true); });

  // ---------------------------------------------------------------- приглашения
  function loadReferrals(q) {
    var box = $("[data-ref-list]");
    box.innerHTML = '<p class="cab-muted">Загрузка…</p>';
    return SB.rpc("admin_referrals", { p_q: q || "", p_limit: 100, p_offset: 0 }).then(function (list) {
      if (!list.length) { box.innerHTML = '<p class="cab-empty">Приглашений пока нет.</p>'; return; }
      box.innerHTML = '<div class="adm-table-wrap"><table class="adm-table"><thead><tr><th>Пригласил</th><th>Промокод</th><th>Приглашённый</th><th>Дата</th><th>Статус</th></tr></thead><tbody>' +
        list.map(function (r) {
          return '<tr><td><button class="acc-link" data-user="' + esc(r.referrer.id) + '">' + who(r.referrer) + "</button></td><td><span class=\"adm-code\">" + esc(r.code) + "</span></td>" +
            '<td><button class="acc-link" data-user="' + esc(r.invitee.id) + '">' + who(r.invitee) + "</button>" + (r.same_network ? '<br><small class="cab-muted">⚠️ та же сеть, что у пригласившего</small>' : "") + "</td>" +
            "<td>" + esc(d(r.created_at)) + "</td><td>" + esc(REF_STATUS[r.status]) + (r.qualified_at ? "<br><small>" + esc(d(r.qualified_at)) + "</small>" : "") + "</td></tr>";
        }).join("") + "</tbody></table></div>";
      labelTables(box);
    }).catch(fail);
  }
  $("[data-ref-search]").addEventListener("submit", function (e) { e.preventDefault(); loadReferrals(e.target.elements.q.value); });

  // ---------------------------------------------------------------- условия
  var RULE_INFO = {
    welcome: ["Подарок за регистрацию", "Каждый новый клиент сразу после регистрации получает эту скидку на первую услугу."],
    referral_invitee: ["Скидка другу по промокоду", "Клиент, который зарегистрировался с промокодом друга, получает эту скидку на первую услугу."],
    referrer_reward: ["Бонус тому, кто пригласил", "Когда приглашённый друг получил услугу, пригласившему начисляется эта скидка. Можно не включать."]
  };
  function loadRules() {
    return loadOverview().then(function () {
      var o = overview;
      var panel = $('[data-panel="rules"]');
      panel.innerHTML =
        '<div class="adm-explain"><h2>Как настроить</h2><ol>' +
          "<li>Включите «Реферальную программу» — тогда у клиентов заработают промокоды для друзей.</li>" +
          "<li>У нужной скидки укажите размер и срок, включите переключатель и нажмите «Сохранить».</li>" +
          "<li>Всё остальное можно не трогать — оно спрятано в «Дополнительно».</li>" +
        "</ol></div>" +
        '<div class="cab-block adm-switches">' +
          switchRow("referral_enabled", "Реферальная программа", "Промокоды для друзей и скидки по ним. Если выключить — работает только подарок за регистрацию.", o.settings.referral_enabled) +
        "</div>" +
        ["welcome", "referral_invitee", "referrer_reward"].map(function (k) { return ruleForm(o.rules[k], o.services); }).join("") +
        '<details class="cab-block adm-more"><summary>Для опытных: услуги и диагностика</summary>' +
          '<h3>Какие услуги можно выбрать при использовании скидки</h3>' +
          '<p class="cab-muted">Снимите галочку, если на услугу скидки не действуют вообще.</p><div class="adm-services">' +
          o.services.map(function (s) {
            return '<label class="check"><input type="checkbox" data-service-toggle="' + esc(s.id) + '"' + (s.active ? " checked" : "") + " /><span>" + esc(s.title) + "</span></label>";
          }).join("") + "</div>" +
          '<div class="adm-switches adm-switches--gap">' +
            switchRow("diagnostics", "Подробные уведомления в Telegram", "Бот будет присылать вообще все события, включая обычные входы. Нужно только для проверки — потом выключите.", o.settings.diagnostics) +
          "</div>" +
        "</details>";
    });
  }
  function switchRow(key, title, hint, on) {
    return '<label class="adm-switch"><input type="checkbox" data-setting="' + key + '"' + (on ? " checked" : "") + ' /><span class="adm-switch__ui" aria-hidden="true"></span>' +
      "<span><b>" + esc(title) + "</b><small>" + esc(hint) + "</small></span></label>";
  }
  function ruleForm(r, services) {
    var ids = r.service_ids || [];
    var info = RULE_INFO[r.kind];
    return '<form class="cab-block adm-rule' + (r.enabled ? " is-on" : "") + '" data-rule="' + esc(r.kind) + '" novalidate>' +
      '<div class="adm-rule__head"><div><h2>' + esc(info[0]) + '</h2><p class="cab-muted">' + esc(info[1]) + "</p></div>" +
      '<label class="adm-switch adm-switch--sm"><input type="checkbox" name="enabled"' + (r.enabled ? " checked" : "") + ' /><span class="adm-switch__ui" aria-hidden="true"></span><span data-on-label>' + (r.enabled ? "Включено" : "Выключено") + "</span></label></div>" +
      '<div class="adm-rule__main">' +
        '<label class="field"><span>Размер скидки</span><span class="adm-amount">' +
          '<input name="amount" type="number" min="1" step="1" inputmode="decimal" placeholder="10" value="' + esc(r.amount == null ? "" : Number(r.amount)) + '" />' +
          '<select name="discount_type" aria-label="Проценты или рубли">' +
            '<option value="percent"' + (r.discount_type !== "fixed" ? " selected" : "") + ">%</option>" +
            '<option value="fixed"' + (r.discount_type === "fixed" ? " selected" : "") + ">₽</option></select></span></label>" +
        '<label class="field"><span>Сколько дней действует</span><input name="valid_days" type="number" min="1" max="3650" placeholder="30" value="' + esc(r.valid_days == null ? "" : r.valid_days) + '" /></label>' +
      "</div>" +
      '<details class="adm-rule__more"><summary>Дополнительно</summary>' +
        '<label class="field"><span>Как скидка называется у клиента в кабинете</span><input name="title" maxlength="80" value="' + esc(r.title) + '" /></label>' +
        '<label class="field"><span>Сколько раз можно использовать</span><input name="max_uses" type="number" min="1" max="100" value="' + esc(r.max_uses) + '" /></label>' +
        '<label class="check"><input type="checkbox" name="stackable"' + (r.stackable ? " checked" : "") + " /><span>Можно использовать вместе с другими скидками</span></label>" +
        '<label class="check"><input type="checkbox" name="all_services"' + (r.all_services ? " checked" : "") + " /><span>Действует на все услуги</span></label>" +
        '<div class="adm-services" data-svc-list' + (r.all_services ? " hidden" : "") + ">" +
          services.map(function (s) {
            return '<label class="check"><input type="checkbox" name="svc" value="' + esc(s.id) + '"' + (ids.indexOf(s.id) >= 0 ? " checked" : "") + " /><span>" + esc(s.title) + "</span></label>";
          }).join("") + "</div>" +
        '<input type="hidden" name="description" value="' + esc(r.description) + '" />' +
      "</details>" +
      '<div class="adm-rule__foot"><button class="btn btn--primary acc-submit" type="submit">Сохранить</button>' +
      '<p class="acc-status" role="status" aria-live="polite"></p></div>' +
      '<p class="cab-muted cab-small">Изменения касаются новых скидок. Уже выданные клиентам скидки остаются на прежних условиях.</p></form>';
  }

  doc.addEventListener("change", function (e) {
    var t = e.target;
    if (t.matches("[data-setting]")) {
      var payload = {}; payload[t.getAttribute("data-setting")] = t.checked;
      SB.rpc("admin_update_settings", { p_settings: payload }).then(function () { toast("Сохранено"); }).catch(function (err) { t.checked = !t.checked; fail(err); });
    } else if (t.matches("[data-service-toggle]")) {
      SB.rpc("admin_update_service", { p_id: t.getAttribute("data-service-toggle"), p_active: t.checked })
        .then(function () { toast("Сохранено"); }).catch(function (err) { t.checked = !t.checked; fail(err); });
    } else if (t.name === "enabled" && t.form && t.form.hasAttribute("data-rule")) {
      $("[data-on-label]", t.form).textContent = t.checked ? "Включено" : "Выключено";
    } else if (t.name === "all_services" && t.form && t.form.hasAttribute("data-rule")) {
      $("[data-svc-list]", t.form).hidden = t.checked;
    }
  });

  doc.addEventListener("submit", function (e) {
    var f = e.target;
    if (!f.hasAttribute("data-rule")) return;
    e.preventDefault();
    var el = f.elements;
    var rule = {
      enabled: el.enabled.checked, title: el.title.value, description: el.description.value,
      discount_type: el.discount_type.value, amount: el.amount.value, valid_days: el.valid_days.value,
      max_uses: el.max_uses.value || "1", stackable: el.stackable.checked, all_services: el.all_services.checked,
      service_ids: $$('input[name="svc"]:checked', f).map(function (x) { return x.value; })
    };
    var st = $(".acc-status", f);
    var problem = rule.discount_type === "percent" && Number(rule.amount) > 100 ? "Процент не может быть больше 100."
      : rule.enabled && !(Number(rule.amount) > 0) ? "Укажите размер скидки."
      : rule.enabled && !(Number(rule.valid_days) > 0) ? "Укажите, сколько дней действует скидка."
      : rule.enabled && !rule.all_services && !rule.service_ids.length ? "Отметьте хотя бы одну услугу в «Дополнительно» или включите «Действует на все услуги»." : "";
    if (problem) { st.textContent = problem; st.className = "acc-status is-error"; return; }
    var btn = $(".acc-submit", f); btn.disabled = true;
    SB.rpc("admin_update_rule", { p_kind: f.getAttribute("data-rule"), p_rule: rule })
      .then(function () { toast("Сохранено"); btn.disabled = false; loadRules(); })
      .catch(function (err) { btn.disabled = false; st.textContent = err.message; st.className = "acc-status is-error"; });
  });

  // ---------------------------------------------------------------- журнал
  var lastEv = null;
  var EV_KEYS = {
    code: "промокод", ref_code: "промокод", invited_with: "пришёл по коду", method: "способ",
    service: "услуга", bonus: "скидка", phone: "телефон", note: "комментарий", reason: "причина",
    referrer_no: "пригласил №", invitee_no: "приглашённый №", other_client_no: "телефон уже у клиента №",
    count_24h: "за сутки", tg_username: "Telegram", email_hint: "email", where: "где", message: "текст",
    title: "условия", source: "откуда"
  };
  var EV_VALUES = { telegram: "Telegram", email: "Email", signup: "при регистрации", later: "в кабинете", available: "выдана", not_issued: "не выдана" };
  function eventRow(e) {
    var data = e.data || {};
    var details = Object.keys(EV_KEYS).filter(function (k) { return data[k] != null && data[k] !== "" && typeof data[k] !== "object"; })
      .slice(0, 5).map(function (k) {
        var v = data[k]; v = EV_VALUES[v] || v;
        if (k === "tg_username") v = "@" + v;
        return esc(EV_KEYS[k]) + ": " + esc(v);
      }).join(" · ");
    if (data.discount_type && data.amount) details = (details ? details + " · " : "") + "размер: " + esc(F.discount(data));
    return '<li class="adm-ev adm-ev--' + esc(e.severity) + '"><time>' + esc(dt(e.created_at)) + "</time>" +
      "<b>" + esc(EV[e.type] || e.type) + "</b>" +
      (e.user ? ' <button class="acc-link" data-user="' + esc(e.user.id) + '">' + who(e.user) + "</button>" : "") +
      (e.actor_tg ? ' <small class="cab-muted">через Telegram</small>' : "") +
      (details ? "<small>" + details + "</small>" : "") + "</li>";
  }
  function loadEvents(more) {
    var list = $("[data-ev-list]");
    if (!more) { list.innerHTML = ""; lastEv = null; }
    return SB.rpc("admin_events", { p_type: "", p_severity: $("[data-ev-sev]").value, p_before: lastEv, p_limit: 50 }).then(function (items) {
      if (!items.length && !more) list.innerHTML = '<li class="cab-empty">Событий нет.</li>';
      list.insertAdjacentHTML("beforeend", items.map(eventRow).join(""));
      if (items.length) lastEv = items[items.length - 1].id;
      $("[data-ev-more]").hidden = items.length < 50;
    }).catch(fail);
  }
  $("[data-ev-sev]").addEventListener("change", function () { loadEvents(false); });
  $("[data-ev-more]").addEventListener("click", function () { loadEvents(true); });

  var LOADERS = {
    overview: loadOverview, requests: loadRequests, users: function () { loadUsers(""); },
    referrals: function () { loadReferrals(""); }, rules: loadRules, broadcast: loadBroadcast, events: function () { loadEvents(false); }
  };

  doc.addEventListener("click", function (e) {
    if (e.target.closest("[data-open-auth]") && window.FZAuth) window.FZAuth.open("login");
    if (e.target.closest("[data-signout]")) { SB.signOut(); location.href = "/"; }
  });
  doc.addEventListener("keydown", function (e) {
    var k = e.target.closest && e.target.closest(".adm-kpi.is-link");
    if (k && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); openTab(k.getAttribute("data-tab")); }
  });

  // ---------------------------------------------------------------- старт
  if (!SB || !SB.enabled) { $("[data-denied-text]").textContent = "Система ещё не подключена."; state("denied"); return; }
  if (!SB.isSignedIn()) { state("denied"); return; }
  SB.rpc("admin_overview").then(function () {
    state("app");
    var start = (location.hash || "").slice(1);
    openTab(LOADERS[start] ? start : "overview");
  }).catch(function (err) {
    $("[data-denied-text]").textContent = err.code === "forbidden"
      ? "У этого аккаунта нет прав администратора. Войдите через Telegram с аккаунта администратора."
      : err.message;
    state("denied");
  });
})();
