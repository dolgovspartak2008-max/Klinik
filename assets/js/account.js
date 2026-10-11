/*
 * Вход, регистрация и подарок за регистрацию (главная страница и кабинет).
 * Работает поверх assets/js/sb.js. Пока в config.js не задан SITE_ACCOUNT.anonKey,
 * кнопки входа не показываются — сайт работает как раньше.
 */
(function () {
  "use strict";
  var doc = document;
  if (!window.SB) return;
  var SB = window.SB;
  var CODE_RE = /^GIFT-[A-Z0-9]{5}$/;
  var onCabinet = /^\/(kabinet|admin)\/?/.test(location.pathname); // страницы приложения

  function esc(v) { return String(v == null ? "" : v).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function el(html) { var t = doc.createElement("template"); t.innerHTML = html.trim(); return t.content.firstElementChild; }
  function $(root, s) { return root.querySelector(s); }

  var toastEl = doc.getElementById("toast"), toastTimer;
  function toast(msg) {
    if (!toastEl) { toastEl = el('<div class="toast" role="status" aria-live="polite"></div>'); doc.body.appendChild(toastEl); }
    toastEl.textContent = msg;
    toastEl.classList.add("is-shown");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.classList.remove("is-shown"); }, 4200);
  }
  window.FZToast = toast;

  function discountText(r) {
    if (!r || !r.discount_type) return "";
    var n = Number(r.amount);
    var v = n % 1 === 0 ? n.toFixed(0) : n.toFixed(2);
    return r.discount_type === "percent" ? v + "%" : Number(v).toLocaleString("ru-RU") + " ₽";
  }
  function servicesText(r) {
    if (!r) return "";
    if (r.all_services) return "на любую услугу";
    var list = (r.services || []).map(function (s) { return s.title; });
    return list.length === 1 ? "на услугу «" + list[0] + "»" : "на услуги: " + list.join(", ");
  }
  window.FZFormat = { discount: discountText, services: servicesText, esc: esc };

  // ------------------------------------------------ промокод из ссылки ?ref=
  (function captureRef() {
    var params = new URLSearchParams(location.search);
    var code = (params.get("ref") || "").toUpperCase().trim();
    if (!code) return;
    params.delete("ref");
    var qs = params.toString();
    history.replaceState(null, "", location.pathname + (qs ? "?" + qs : "") + location.hash);
    if (!CODE_RE.test(code)) return;
    SB.storeRef(code);
    if (SB.enabled) SB.account("ref_click", { code: code }).catch(function () {});
  })();

  if (!SB.enabled) return;

  var program = null;
  var programReady = SB.rpc("program_info").then(function (p) { program = p || {}; return program; })
    .catch(function () { program = {}; return program; });

  // ------------------------------------------------ окно входа / регистрации
  var modal = el(
    '<div class="modal acc-modal" id="authModal" role="dialog" aria-modal="true" aria-labelledby="authTitle" hidden>' +
    '<div class="modal__backdrop" data-acc-close></div>' +
    '<div class="modal__card acc-card">' +
      '<button class="modal__close" type="button" data-acc-close aria-label="Закрыть">×</button>' +
      '<h2 id="authTitle">Личный кабинет</h2>' +
      '<div class="acc-gift" data-acc-gift hidden></div>' +
      '<div class="acc-tabs" role="tablist">' +
        '<button type="button" role="tab" class="acc-tabs__btn" data-acc-tab="login" aria-selected="true">Вход</button>' +
        '<button type="button" role="tab" class="acc-tabs__btn" data-acc-tab="register" aria-selected="false">Регистрация</button>' +
      '</div>' +

      '<div class="acc-view" data-acc-view="main">' +
        '<button type="button" class="btn btn--tg acc-tg" data-acc-tg>' +
          '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 4 3 11l6 2 2 6 3-4 5 4Z"/></svg>' +
          '<span data-acc-tg-label>Войти через Telegram</span></button>' +
        '<p class="acc-or"><span>или по email</span></p>' +

        '<form class="acc-form" data-acc-form="login" novalidate>' +
          '<label class="field"><span>Email</span><input name="email" type="email" autocomplete="email" maxlength="254" required /></label>' +
          '<label class="field"><span>Пароль</span><input name="password" type="password" autocomplete="current-password" maxlength="72" required /></label>' +
          '<button class="btn btn--primary btn--lg acc-submit" type="submit">Войти</button>' +
          '<button class="acc-link" type="button" data-acc-show="reset">Забыли пароль?</button>' +
        '</form>' +

        '<form class="acc-form" data-acc-form="register" novalidate hidden>' +
          '<label class="field"><span>Имя</span><input name="name" type="text" autocomplete="given-name" maxlength="60" placeholder="Например, Анна" required /></label>' +
          '<label class="field"><span>Email</span><input name="email" type="email" autocomplete="email" maxlength="254" required /></label>' +
          '<label class="field"><span>Телефон <small>— по нему администратор найдёт вашу скидку</small></span><input name="phone" type="tel" inputmode="tel" autocomplete="tel" maxlength="20" placeholder="+7 (___) ___-__-__" /></label>' +
          '<label class="field"><span>Пароль <small>— от 8 символов, буквы и цифры</small></span><input name="password" type="password" autocomplete="new-password" minlength="8" maxlength="72" required /></label>' +
          '<label class="field"><span>Промокод друга <small>— если есть</small></span><input name="ref" type="text" autocomplete="off" autocapitalize="characters" maxlength="10" placeholder="GIFT-XXXXX" /></label>' +
          '<label class="field field--hp" aria-hidden="true">Не заполняйте<input name="website" type="text" tabindex="-1" autocomplete="off" /></label>' +
          '<label class="check"><input type="checkbox" name="consent" required /><span>Согласен(на) на&nbsp;обработку персональных данных согласно <a href="/politika.html" target="_blank" rel="noopener">политике конфиденциальности</a></span></label>' +
          '<button class="btn btn--accent btn--lg acc-submit" type="submit">Зарегистрироваться</button>' +
        '</form>' +
        '<p class="acc-status" role="status" aria-live="polite"></p>' +
      '</div>' +

      '<div class="acc-view" data-acc-view="reset" hidden>' +
        '<p class="acc-lead">Укажите email аккаунта. Ссылку для нового пароля пришлём в Telegram, если он привязан к аккаунту.</p>' +
        '<form class="acc-form" data-acc-form="reset" novalidate>' +
          '<label class="field"><span>Email</span><input name="email" type="email" autocomplete="email" maxlength="254" required /></label>' +
          '<button class="btn btn--primary btn--lg acc-submit" type="submit">Отправить ссылку</button>' +
        '</form>' +
        '<p class="acc-status" role="status" aria-live="polite"></p>' +
        '<button class="acc-link" type="button" data-acc-show="main">← Вернуться ко входу</button>' +
      '</div>' +

      '<div class="acc-view acc-wait" data-acc-view="tg" hidden>' +
        '<p class="acc-lead">Откройте бота клиники в Telegram и нажмите «Подтвердить». Проверьте, что код в боте совпадает:</p>' +
        '<p class="acc-code" data-acc-code aria-label="Код подтверждения"></p>' +
        '<a class="btn btn--tg btn--lg acc-tg" data-acc-tg-open href="#" target="_blank" rel="noopener">' +
          '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 4 3 11l6 2 2 6 3-4 5 4Z"/></svg>Открыть Telegram</a>' +
        '<p class="acc-status" data-acc-wait-status role="status" aria-live="polite">Ждём подтверждения в Telegram…</p>' +
        '<button class="acc-link" type="button" data-acc-show="main">← Другой способ входа</button>' +
      '</div>' +
    '</div></div>');
  doc.body.appendChild(modal);

  var lastFocus = null;
  var pollTimer = null;
  var linkMode = false;

  function show(view) {
    modal.querySelectorAll("[data-acc-view]").forEach(function (v) { v.hidden = v.getAttribute("data-acc-view") !== view; });
    $(modal, ".acc-tabs").hidden = view !== "main";
    if (view !== "tg") stopPoll();
    modal.querySelectorAll(".acc-status").forEach(function (s) { if (!s.hasAttribute("data-acc-wait-status")) { s.textContent = ""; s.className = "acc-status"; } });
  }
  function tab(name) {
    modal.querySelectorAll("[data-acc-tab]").forEach(function (b) { b.setAttribute("aria-selected", String(b.getAttribute("data-acc-tab") === name)); });
    $(modal, '[data-acc-form="login"]').hidden = name !== "login";
    $(modal, '[data-acc-form="register"]').hidden = name !== "register";
    $(modal, "[data-acc-tg-label]").textContent = name === "register" ? "Зарегистрироваться через Telegram" : "Войти через Telegram";
    $(modal, "#authTitle").textContent = name === "register" ? "Регистрация" : "Вход в личный кабинет";
    show("main");
  }

  function renderGift() {
    var box = $(modal, "[data-acc-gift]");
    var w = program && program.welcome, inv = program && program.invitee;
    var ref = SB.storedRef();
    var parts = [];
    if (w) parts.push("<b>Подарок за регистрацию:</b> скидка " + esc(discountText(w)) + " " + esc(servicesText(w)) + ".");
    if (inv && ref) parts.push("<b>Промокод друга " + esc(ref) + "</b> — ещё скидка " + esc(discountText(inv)) + " на первую услугу.");
    box.hidden = !parts.length;
    box.innerHTML = parts.length ? '<span class="acc-gift__ico" aria-hidden="true">🎁</span><p>' + parts.join(" ") + "</p>" : "";
  }

  function open(which) {
    linkMode = false;
    lastFocus = doc.activeElement;
    tab(which === "register" ? "register" : "login");
    var refInput = $(modal, '[data-acc-form="register"] [name="ref"]');
    if (!refInput.value) refInput.value = SB.storedRef();
    programReady.then(renderGift);
    modal.hidden = false;
    doc.body.classList.add("has-modal");
    setTimeout(function () { var f = $(modal, "[data-acc-tg]"); if (f) f.focus(); }, 60);
  }
  function close() {
    stopPoll();
    modal.hidden = true;
    doc.body.classList.remove("has-modal");
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  }

  modal.addEventListener("click", function (e) {
    var t = e.target.closest("[data-acc-close],[data-acc-tab],[data-acc-show],[data-acc-tg]");
    if (!t) return;
    if (t.hasAttribute("data-acc-close")) close();
    else if (t.hasAttribute("data-acc-tab")) tab(t.getAttribute("data-acc-tab"));
    else if (t.hasAttribute("data-acc-show")) show(t.getAttribute("data-acc-show"));
    else if (t.hasAttribute("data-acc-tg")) startTelegram("login");
  });
  doc.addEventListener("keydown", function (e) {
    if (modal.hidden) return;
    if (e.key === "Escape") { e.stopPropagation(); close(); }
    if (e.key === "Tab") {
      var f = Array.prototype.filter.call(modal.querySelectorAll("a[href],button,input:not([type=hidden]):not([tabindex='-1'])"),
        function (x) { return x.offsetParent !== null && !x.disabled; });
      if (!f.length) return;
      if (e.shiftKey && doc.activeElement === f[0]) { e.preventDefault(); f[f.length - 1].focus(); }
      else if (!e.shiftKey && doc.activeElement === f[f.length - 1]) { e.preventDefault(); f[0].focus(); }
    }
  }, true);

  function setStatus(form, text, ok) {
    var s = form.parentNode.querySelector(".acc-status");
    s.textContent = text;
    s.className = "acc-status" + (text ? (ok ? " is-ok" : " is-error") : "");
  }
  function busy(form, on) {
    var b = $(form, ".acc-submit");
    b.disabled = on;
    b.classList.toggle("is-busy", on);
  }
  function invalid(form, name, on) {
    var f = $(form, '[name="' + name + '"]');
    if (f) (f.closest(".field") || f.closest(".check")).classList.toggle("is-invalid", on);
    return on;
  }
  function done() {
    if (onCabinet) { close(); location.reload(); }
    else location.href = "/kabinet/";
  }

  modal.querySelectorAll("[data-acc-form]").forEach(function (form) {
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      var kind = form.getAttribute("data-acc-form");
      var v = function (n) { var f = form.elements[n]; return f ? String(f.value || "").trim() : ""; };
      var bad = false;
      bad = invalid(form, "email", !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v("email"))) || bad;
      if (kind !== "reset") bad = invalid(form, "password", form.elements.password.value.length < (kind === "register" ? 8 : 1)) || bad;
      if (kind === "register") {
        bad = invalid(form, "name", v("name").length < 2) || bad;
        bad = invalid(form, "consent", !form.elements.consent.checked) || bad;
        var code = v("ref").toUpperCase();
        bad = invalid(form, "ref", !!code && !CODE_RE.test(code)) || bad;
      }
      if (bad) { setStatus(form, "Проверьте отмеченные поля.", false); return; }

      busy(form, true);
      setStatus(form, "", false);
      var req;
      if (kind === "login") req = SB.account("login", { email: v("email"), password: form.elements.password.value });
      else if (kind === "register") req = SB.account("signup", {
        name: v("name"), email: v("email"), phone: v("phone"), password: form.elements.password.value,
        ref: v("ref").toUpperCase(), consent: true, website: v("website")
      });
      else req = SB.account("reset", { email: v("email") });

      req.then(function () {
        if (kind === "reset") {
          setStatus(form, "Если аккаунт с этим email существует и к нему привязан Telegram, ссылка уже в Telegram. " +
            "Telegram не привязан? Позвоните нам: +7 (987) 600-00-37 — поможем восстановить доступ.", true);
          busy(form, false);
          return;
        }
        if (kind === "register") toast("Аккаунт создан. Добро пожаловать! 🎁");
        done();
      }).catch(function (err) {
        busy(form, false);
        setStatus(form, err.message || SB.message("server_error"), false);
      });
    });
    form.addEventListener("input", function (e) {
      var f = e.target.closest(".field, .check");
      if (f) f.classList.remove("is-invalid");
    });
  });

  // ------------------------------------------------ вход через Telegram-бота
  function stopPoll() { if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; } }

  function startTelegram(mode) {
    linkMode = mode === "link";
    var btn = $(modal, "[data-acc-tg]");
    btn.disabled = true;
    SB.account("tg_start", { mode: mode, ref: SB.storedRef() || ($(modal, '[name="ref"]').value || "").toUpperCase() })
      .then(function (r) {
        btn.disabled = false;
        if (modal.hidden) { lastFocus = doc.activeElement; modal.hidden = false; doc.body.classList.add("has-modal"); }
        $(modal, "#authTitle").textContent = linkMode ? "Привязка Telegram" : "Вход через Telegram";
        show("tg");
        $(modal, "[data-acc-code]").textContent = r.code;
        var a = $(modal, "[data-acc-tg-open]");
        a.href = r.url;
        $(modal, "[data-acc-wait-status]").textContent = "Ждём подтверждения в Telegram…";
        // на телефоне сразу открываем Telegram
        if (window.matchMedia("(max-width: 760px)").matches) { try { window.open(r.url, "_blank", "noopener"); } catch (e) {} }
        a.focus();
        var deadline = Date.now() + 10 * 60 * 1000;
        (function poll() {
          pollTimer = setTimeout(function () {
            SB.account("tg_poll", { id: r.id, secret: r.secret }).then(function (p) {
              if (p.status === "ok") { toast(p.created ? "Аккаунт создан. Добро пожаловать! 🎁" : "Вы вошли через Telegram"); done(); return; }
              if (p.status === "linked") { toast("Telegram привязан к аккаунту"); close(); if (window.FZOnLinked) window.FZOnLinked(); return; }
              if (p.status === "rejected" || p.status === "expired" || Date.now() > deadline) {
                $(modal, "[data-acc-wait-status]").textContent = "Вход не подтверждён. Нажмите «Другой способ входа» и попробуйте ещё раз.";
                return;
              }
              poll();
            }).catch(function (err) {
              if (err.code === "network" || err.code === "rate_limited") return poll();
              $(modal, "[data-acc-wait-status]").textContent = err.message;
            });
          }, 2000);
        })();
      })
      .catch(function (err) {
        btn.disabled = false;
        if (modal.hidden) toast(err.message); else setStatus($(modal, '[data-acc-form="login"]'), err.message, false);
      });
  }

  window.FZAuth = {
    open: open,
    linkTelegram: function () { startTelegram("link"); },
    close: close
  };

  // ------------------------------------------------ кнопка в шапке
  var headerInner = doc.querySelector(".header__inner");
  if (headerInner && !onCabinet) {
    var accBtn = el(
      '<a class="acc-head" href="/kabinet/" data-acc-head>' +
      '<span class="acc-head__ico" aria-hidden="true"><svg viewBox="0 0 24 24"><circle cx="12" cy="8.5" r="3.8"/><path d="M4.5 20c1.2-4 4.2-5.6 7.5-5.6s6.3 1.6 7.5 5.6"/></svg></span>' +
      '<span class="acc-head__txt">Войти</span></a>');
    var cta = headerInner.querySelector(".header__cta");
    headerInner.insertBefore(accBtn, cta || headerInner.querySelector(".burger"));
    var sync = function (signed) {
      $(accBtn, ".acc-head__txt").textContent = signed ? "Кабинет" : "Войти";
      accBtn.setAttribute("aria-label", signed ? "Личный кабинет" : "Войти или зарегистрироваться");
      accBtn.classList.toggle("is-in", signed);
    };
    sync(SB.isSignedIn());
    SB.onChange(sync);
    accBtn.addEventListener("click", function (e) {
      if (SB.isSignedIn()) return;
      e.preventDefault();
      open("login");
    });

    var mobileNav = doc.getElementById("nav");
    if (mobileNav) {
      var mob = el('<button class="btn btn--glass nav__acc-mobile" type="button">Личный кабинет</button>');
      var mcta = mobileNav.querySelector(".nav__cta-mobile");
      mobileNav.insertBefore(mob, mcta ? mcta.nextSibling : null);
      mob.addEventListener("click", function () {
        if (SB.isSignedIn()) location.href = "/kabinet/";
        else setTimeout(function () { open("login"); }, 50);
      });
    }
  }

  // ------------------------------------------------ блок «Подарок за регистрацию» на главной
  var anchor = doc.getElementById("contacts");
  if (anchor && !onCabinet) {
    programReady.then(function (p) {
      var w = p && p.welcome, inv = p && p.invitee;
      if (!w && !inv) return;
      var signed = SB.isSignedIn();
      var sec = el(
        '<section class="section gift-band" aria-labelledby="giftTitle"><div class="container">' +
        '<div class="gift-band__card">' +
          '<div class="gift-band__text">' +
            '<h2 id="giftTitle"></h2><p class="gift-band__lead"></p>' +
            '<div class="gift-band__actions"></div>' +
          '</div>' +
          '<div class="gift-band__ticket" aria-hidden="true"><span class="gift-band__amount"></span><small></small></div>' +
        '</div></div></section>');
      var main = w || inv;
      $(sec, "#giftTitle").textContent = w ? "Подарок за регистрацию" : "Приведите друга — ему скидка";
      $(sec, ".gift-band__lead").textContent = w
        ? "Зарегистрируйтесь на сайте — и получите скидку " + discountText(w) + " " + servicesText(w) +
          ". В личном кабинете будет ваш промокод: поделитесь им, и друзья тоже получат скидку на первый визит."
        : "Зарегистрируйтесь и поделитесь личным промокодом: друг получит скидку " + discountText(inv) + " на первую услугу.";
      $(sec, ".gift-band__amount").textContent = discountText(main);
      $(sec, ".gift-band__ticket small").textContent = w ? "на первую услугу" : "другу";
      var act = $(sec, ".gift-band__actions");
      var b1 = el('<button class="btn btn--light btn--lg" type="button"></button>');
      b1.textContent = signed ? "Открыть личный кабинет" : "Получить подарок";
      b1.addEventListener("click", function () { if (SB.isSignedIn()) location.href = "/kabinet/"; else open("register"); });
      act.appendChild(b1);
      anchor.parentNode.insertBefore(sec, anchor);
    });
  }

  // ------------------------------------------------ подсказка о промокоде друга
  if (!onCabinet && SB.storedRef() && !SB.isSignedIn()) {
    programReady.then(function (p) {
      if (!p || !p.invitee) return;
      var chip = el('<button class="ref-chip" type="button"><span aria-hidden="true">🎁</span><span>У вас промокод друга <b></b> — получить скидку</span><span class="ref-chip__x" aria-label="Скрыть">×</span></button>');
      $(chip, "b").textContent = SB.storedRef();
      chip.addEventListener("click", function (e) {
        if (e.target.classList.contains("ref-chip__x")) { chip.remove(); return; }
        chip.remove(); open("register");
      });
      setTimeout(function () { doc.body.appendChild(chip); }, 2600);
    });
  }
})();
