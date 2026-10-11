/* Личный кабинет: скидки, промокод, приглашения, профиль. */
(function () {
  "use strict";
  var doc = document;
  var SB = window.SB;
  var F = window.FZFormat || {};
  var esc = F.esc;
  var main = doc.getElementById("main");
  var data = null;

  function $(s, root) { return (root || doc).querySelector(s); }
  function $$(s, root) { return Array.prototype.slice.call((root || doc).querySelectorAll(s)); }
  function toast(m) { if (window.FZToast) window.FZToast(m); }

  function state(name) {
    $$("[data-state]").forEach(function (s) { s.hidden = s.getAttribute("data-state") !== name; });
    main.setAttribute("aria-busy", String(name === "loading"));
    $$("[data-signout]").forEach(function (b) { b.hidden = !(SB && SB.isSignedIn()); });
  }

  var STATUS = {
    available: ["Доступен", "is-available"], pending: ["Ожидает подтверждения", "is-pending"],
    used: ["Использован", "is-used"], expired: ["Истёк", "is-muted"], cancelled: ["Отменён", "is-muted"]
  };
  var R_STATUS = { pending: "ожидает подтверждения", confirmed: "подтверждено", cancelled: "отменено", refunded: "возврат" };
  var KIND = { welcome: "Подарок за регистрацию", referral_invitee: "Скидка по приглашению друга", referrer_reward: "Награда за приглашённого друга" };

  function date(iso, withTime) {
    if (!iso) return "";
    var o = { day: "numeric", month: "long", year: "numeric" };
    if (withTime) { o.hour = "2-digit"; o.minute = "2-digit"; }
    return new Date(iso).toLocaleString("ru-RU", o);
  }
  function plural(n, one, few, many) {
    var m10 = n % 10, m100 = n % 100;
    return n + " " + (m10 === 1 && m100 !== 11 ? one : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? few : many);
  }

  function copy(text, okMsg) {
    var done = function () { toast(okMsg); };
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(done, fallback);
    } else fallback();
    function fallback() {
      var t = doc.createElement("textarea");
      t.value = text; t.setAttribute("readonly", ""); t.style.position = "fixed"; t.style.opacity = "0";
      doc.body.appendChild(t); t.select();
      try { doc.execCommand("copy"); done(); } catch (e) { toast("Не получилось скопировать — выделите текст вручную"); }
      t.remove();
    }
  }

  // ------------------------------------------------------------ отрисовка
  function render(d) {
    data = d;
    var p = d.profile;
    var rules = (d.program && d.program.rules) || {};
    var siteUrl = (d.program && d.program.site_url) || location.origin;
    var link = siteUrl.replace(/\/+$/, "") + "/?ref=" + encodeURIComponent(p.ref_code);
    var inv = rules.referral_invitee;
    var programOn = d.program && d.program.referral_enabled;

    $("[data-hello]").textContent = p.name ? "Здравствуйте, " + p.name.split(" ")[0] + "!" : "Здравствуйте!";
    $("[data-meta]").textContent = "Клиент № " + p.client_no + " · с нами с " + date(p.created_at);
    $("[data-admin-link]").hidden = !p.is_admin;

    var welcome = d.bonuses.filter(function (b) { return b.kind === "welcome" && b.status === "available"; })[0];
    $("[data-welcome]").hidden = !welcome;

    $("[data-code]").textContent = p.ref_code;
    $("[data-ref-link]").value = link;
    var shareText = "Мой промокод в клинике «Физиотера» (Уфа): " + p.ref_code +
      (programOn && inv && inv.enabled ? " — по нему скидка " + F.discount(inv) + " на первую услугу." : ".");
    $("[data-share-tg]").href = "https://t.me/share/url?url=" + encodeURIComponent(link) + "&text=" + encodeURIComponent(shareText);
    $("[data-share-wa]").href = "https://wa.me/?text=" + encodeURIComponent(shareText + " " + link);
    $("[data-ticket]").classList.toggle("is-off", !programOn);
    $("[data-ticket-note]").textContent = programOn
      ? "Поделитесь этим промокодом с другом! При первом обращении он сможет получить специальную скидку на услугу. Чем больше людей узнает о нашем центре, тем больше приятных предложений мы сможем подготовить!"
      : "Реферальная программа сейчас на паузе. Промокод сохранится за вами — как только программа заработает, им можно будет поделиться.";

    // условия программы
    var terms = [];
    if (programOn && inv && inv.enabled) terms.push("Друг получает скидку " + F.discount(inv) + " " + F.services(inv) + ".");
    if (programOn && rules.referrer_reward && rules.referrer_reward.enabled)
      terms.push("Когда друг получит услугу, вам начислится бонус " + F.discount(rules.referrer_reward) + ".");
    if (!programOn) terms.push("Реферальная программа сейчас на паузе.");
    $("[data-how-terms]").textContent = terms.join(" ");

    renderBonuses(d);

    // промокод друга
    $("[data-refcode-block]").hidden = !d.can_enter_code;
    var by = $("[data-invited-by]");
    by.hidden = !d.referred_by;
    if (d.referred_by) by.textContent = "Вы пришли по приглашению: " + d.referred_by.name + " (" + d.referred_by.code + ").";

    // приглашения
    var invites = d.invites || [];
    var qualified = invites.filter(function (i) { return i.status === "qualified"; }).length;
    $("[data-invite-stats]").textContent = invites.length
      ? "Приглашено: " + invites.length + " · получили услугу: " + qualified
      : "Пока никого. Отправьте промокод другу — его регистрация появится здесь.";
    $("[data-invites]").innerHTML = invites.map(function (i) {
      var st = i.status === "qualified" ? "Получил(а) услугу" : i.status === "cancelled" ? "Отменено" : "Зарегистрировался(ась)";
      var rw = i.reward ? " · ваш бонус: " + (STATUS[i.reward] ? STATUS[i.reward][0].toLowerCase() : i.reward) : "";
      return '<li><span class="invite-list__name">' + esc(i.name) + "</span><span>" + esc(date(i.created_at)) + "</span>" +
        '<span class="chip-status ' + (i.status === "qualified" ? "is-available" : "is-muted") + '">' + esc(st + rw) + "</span></li>";
    }).join("");

    // профиль
    var pf = $("[data-profile-form]");
    pf.elements.name.value = p.name || "";
    pf.elements.phone.value = p.phone || "";
    pf.elements.phone.readOnly = !!p.phone_locked;
    $("[data-phone-hint]").textContent = p.phone_locked
      ? "Телефон закреплён за оформленной скидкой. Если номер сменился — позвоните нам."
      : "По телефону администратор найдёт ваши скидки на приёме.";
    $("[data-email]").textContent = p.email || "не указан";
    $("[data-telegram]").textContent = p.telegram ? (p.telegram.username ? "@" + p.telegram.username : p.telegram.first_name || "привязан") : "не привязан";
    $("[data-link-tg]").hidden = !!p.telegram;
    $("[data-email-block]").hidden = !!p.email;

    state("dashboard");
  }

  function bonusCard(b, services) {
    var st = STATUS[b.status] || [b.status, "is-muted"];
    var allowed = b.all_services ? services : (b.services || []).filter(function (s) {
      return services.some(function (x) { return x.id === s.id; });
    });
    var pending = (b.redemptions || []).filter(function (r) { return r.status === "pending"; })[0];
    var left = b.max_uses - b.uses_confirmed;
    var h = '<article class="bonus bonus--' + esc(b.status) + '">' +
      '<div class="bonus__value">' + esc(F.discount(b)) + "</div>" +
      '<div class="bonus__body">' +
        (KIND[b.kind] && KIND[b.kind] !== b.title ? '<p class="bonus__kind">' + esc(KIND[b.kind]) + "</p>" : "") +
        '<h3 class="bonus__title">' + esc(b.title) + "</h3>" +
        '<p class="bonus__terms">' + esc(F.services(b)) +
          (b.status === "available" || b.status === "pending" ? " · действует до " + esc(date(b.expires_at)) : "") +
          (b.max_uses > 1 ? " · осталось " + esc(plural(left, "использование", "использования", "использований")) : "") +
          (!b.stackable ? " · не суммируется с другими акциями" : "") + "</p>" +
        (b.cancel_reason ? '<p class="bonus__terms">' + esc(b.cancel_reason) + "</p>" : "") +
        '<span class="chip-status ' + st[1] + '">' + esc(st[0]) + "</span>";
    if (b.status === "available") {
      h += '<form class="bonus__use" data-use="' + esc(b.id) + '">' +
        '<label class="field"><span>На какую услугу?</span><select name="service" required>' +
        '<option value="">Выберите услугу</option>' +
        allowed.map(function (s) { return '<option value="' + esc(s.id) + '">' + esc(s.title) + "</option>"; }).join("") +
        "</select></label>" +
        '<button class="btn btn--accent acc-submit" type="submit">Использовать скидку</button>' +
        '<p class="cab-muted cab-small">Скидку подтвердит администратор на приёме — назовите телефон из профиля.</p>' +
        '<p class="acc-status" role="status" aria-live="polite"></p></form>';
    }
    if (pending) {
      h += '<div class="bonus__pending"><p>Запрос на «' + esc(pending.service) + "» отправлен " + esc(date(pending.requested_at, true)) +
        ". Скидка будет применена на приёме.</p>" +
        '<button class="acc-link" type="button" data-cancel-req="' + esc(pending.id) + '">Отменить запрос</button></div>';
    }
    var history = (b.redemptions || []).filter(function (r) { return r.status !== "pending"; });
    if (history.length) {
      h += '<details class="bonus__history"><summary>История использования</summary><ul>' + history.map(function (r) {
        return "<li>" + esc(date(r.decided_at || r.requested_at, true)) + " — " + esc(r.service) + ": " + esc(R_STATUS[r.status] || r.status) + "</li>";
      }).join("") + "</ul></details>";
    }
    return h + "</div></article>";
  }

  function renderBonuses(d) {
    var box = $("[data-bonuses]");
    if (!d.bonuses.length) {
      var w = d.program && d.program.rules && d.program.rules.welcome;
      box.innerHTML = '<p class="cab-empty">' + (w && w.enabled
        ? "Подарок появится здесь в течение минуты после регистрации. Обновите страницу."
        : "Пока скидок нет. Следите за акциями — новые предложения появятся здесь.") + "</p>";
      return;
    }
    box.innerHTML = d.bonuses.map(function (b) { return bonusCard(b, d.services || []); }).join("");
  }

  // ------------------------------------------------------------ загрузка
  function load() {
    return SB.rpc("my_dashboard").then(render).catch(function (err) {
      if (err.code === "not_authenticated") { SB.signOut(); state("guest"); return; }
      if (err.code === "account_blocked" || err.code === "account_inactive") SB.signOut();
      $("[data-error-text]").textContent = err.message;
      state("error");
    });
  }

  // ------------------------------------------------------------ действия
  function formStatus(form, text, ok) {
    var s = form.querySelector(".acc-status") || form.parentNode.querySelector(".acc-status");
    if (!s) return;
    s.textContent = text;
    s.className = "acc-status" + (text ? (ok ? " is-ok" : " is-error") : "");
  }
  function busy(form, on) { var b = form.querySelector(".acc-submit"); if (b) { b.disabled = on; b.classList.toggle("is-busy", on); } }

  doc.addEventListener("submit", function (e) {
    var form = e.target;
    if (form.hasAttribute("data-use")) {
      e.preventDefault();
      var svc = form.elements.service.value;
      if (!svc) { formStatus(form, "Выберите услугу.", false); return; }
      if (!data.profile.phone) {
        formStatus(form, SB.message("phone_required"), false);
        var ph = $("[data-profile-form]").elements.phone; ph.focus(); return;
      }
      busy(form, true);
      SB.rpc("request_bonus", { p_bonus: form.getAttribute("data-use"), p_service: svc })
        .then(function () { toast("Запрос отправлен. Скидка будет применена на приёме"); return load(); })
        .catch(function (err) { busy(form, false); formStatus(form, err.message, false); });
    } else if (form.hasAttribute("data-profile-form")) {
      e.preventDefault();
      busy(form, true);
      SB.rpc("update_my_profile", { p_name: form.elements.name.value, p_phone: form.elements.phone.value })
        .then(function () { busy(form, false); formStatus(form, "Сохранено", true); return load(); })
        .catch(function (err) { busy(form, false); formStatus(form, err.message, false); });
    } else if (form.hasAttribute("data-refcode-form")) {
      e.preventDefault();
      var code = form.elements.code.value.trim().toUpperCase();
      if (!/^GIFT-[A-Z0-9]{5}$/.test(code)) { formStatus(form, SB.message("code_not_found"), false); return; }
      busy(form, true);
      SB.rpc("apply_ref_code", { p_code: code })
        .then(function (r) { toast(r.bonus_issued ? "Промокод применён — скидка уже в кабинете 🎁" : "Промокод применён"); return load(); })
        .catch(function (err) { busy(form, false); formStatus(form, err.message, false); });
    } else if (form.hasAttribute("data-email-form")) {
      e.preventDefault();
      busy(form, true);
      SB.account("set_email", { email: form.elements.email.value.trim(), password: form.elements.password.value })
        .then(function () { toast("Готово: теперь можно входить и по email"); return load(); })
        .catch(function (err) { busy(form, false); formStatus(form, err.message, false); });
    } else if (form.hasAttribute("data-reset-form")) {
      e.preventDefault();
      var p1 = form.elements.password.value, p2 = form.elements.password2.value;
      if (p1.length < 8 || !/[0-9]/.test(p1) || !/[A-Za-zА-Яа-яЁё]/.test(p1)) { formStatus(form, SB.message("weak_password"), false); return; }
      if (p1 !== p2) { formStatus(form, "Пароли не совпадают.", false); return; }
      busy(form, true);
      SB.updatePassword(p1)
        .then(function () { toast("Пароль обновлён"); history.replaceState(null, "", "/kabinet/"); state("loading"); return load(); })
        .catch(function (err) { busy(form, false); formStatus(form, err.message, false); });
    }
  });

  doc.addEventListener("click", function (e) {
    var t = e.target.closest("[data-copy-code],[data-copy-link],[data-share],[data-cancel-req],[data-signout],[data-delete],[data-link-tg],[data-open-auth],[data-reload]");
    if (!t) return;
    if (t.hasAttribute("data-copy-code")) copy(data.profile.ref_code, "Промокод скопирован");
    else if (t.hasAttribute("data-copy-link")) copy($("[data-ref-link]").value, "Ссылка скопирована");
    else if (t.hasAttribute("data-share")) {
      var link = $("[data-ref-link]").value;
      if (navigator.share) navigator.share({ title: "Клиника «Физиотера»", text: "Мой промокод: " + data.profile.ref_code, url: link }).catch(function () {});
      else copy(link, "Ссылка скопирована — отправьте её другу");
    } else if (t.hasAttribute("data-cancel-req")) {
      if (!confirm("Отменить запрос на скидку? Бонус снова станет доступен.")) return;
      t.disabled = true;
      SB.rpc("cancel_my_request", { p_redemption: t.getAttribute("data-cancel-req") })
        .then(function () { toast("Запрос отменён"); return load(); })
        .catch(function (err) { t.disabled = false; toast(err.message); });
    } else if (t.hasAttribute("data-signout")) {
      SB.signOut(); location.href = "/";
    } else if (t.hasAttribute("data-delete")) {
      if (!confirm("Удалить аккаунт? Неиспользованные скидки сгорят, а повторно получить подарок за регистрацию будет нельзя.")) return;
      SB.rpc("delete_my_account").then(function () { SB.signOut(); location.href = "/"; }).catch(function (err) { toast(err.message); });
    } else if (t.hasAttribute("data-link-tg")) {
      if (window.FZAuth) window.FZAuth.linkTelegram();
    } else if (t.hasAttribute("data-open-auth")) {
      if (window.FZAuth) window.FZAuth.open(t.getAttribute("data-open-auth"));
    } else if (t.hasAttribute("data-reload")) {
      location.reload();
    }
  });

  window.FZOnLinked = function () { load(); };

  // ------------------------------------------------------------ старт
  if (!SB || !SB.enabled) {
    $("[data-error-text]").textContent = "Личный кабинет скоро заработает. Записаться можно по телефону +7 (987) 600-00-37.";
    state("error");
    return;
  }
  var params = new URLSearchParams(location.search);
  var resetHash = params.get("reset");
  if (resetHash && /^[A-Za-z0-9_-]{20,200}$/.test(resetHash)) {
    SB.verifyRecovery(resetHash).then(function () { state("reset"); })
      .catch(function () {
        $("[data-error-text]").textContent = "Ссылка для смены пароля устарела или уже использована. Запросите новую в окне входа.";
        state("error");
      });
    return;
  }
  if (!SB.isSignedIn()) { state("guest"); return; }
  load();
  SB.onChange(function (signed) { if (!signed) state("guest"); });
})();
