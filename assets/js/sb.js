/*
 * Мини-клиент Supabase для сайта (без внешних библиотек).
 * Сессия хранится в localStorage и обновляется автоматически.
 * Запросы идут на свой домен (/sb/…), Vercel проксирует их в Supabase —
 * поэтому сайт работает, даже если прямой доступ к supabase.co ограничен.
 */
(function () {
  "use strict";
  var CFG = window.SITE_ACCOUNT || {};
  var BASE = String(CFG.supabaseUrl || "").replace(/\/+$/, "");
  var KEY = CFG.anonKey || "";
  var STORE = "fz.session";
  var listeners = [];
  var refreshing = null;

  var ERRORS = {
    not_authenticated: "Войдите в аккаунт, чтобы продолжить.",
    account_blocked: "Аккаунт заблокирован. Если это ошибка — позвоните нам: +7 (987) 600-00-37.",
    account_inactive: "Аккаунт удалён.",
    rate_limited: "Слишком много попыток. Подождите несколько минут и попробуйте снова.",
    bad_email: "Проверьте email — похоже, в адресе опечатка.",
    weak_password: "Пароль — минимум 8 символов, хотя бы одна буква и одна цифра.",
    bad_name: "Напишите настоящее имя буквами — например, Анна или Иван Петров.",
    bad_phone: "Проверьте номер телефона: например, +7 987 600-00-37.",
    consent_required: "Нужно согласие на обработку персональных данных.",
    email_taken: "Этот email уже зарегистрирован. Войдите или восстановите пароль.",
    invalid_credentials: "Неверный email или пароль.",
    email_not_verified: "Email ещё не подтверждён — мы отправили код на почту.",
    bad_code: "Неверный код. Проверьте цифры из письма.",
    code_expired: "Код устарел или введён неверно слишком много раз. Запросите новый.",
    code_cooldown: "Код уже отправлен. Новый можно запросить через минуту.",
    code_failed: "Не удалось создать код. Попробуйте ещё раз через минуту.",
    mail_failed: "Не удалось отправить письмо. Попробуйте позже или войдите через Telegram.",
    code_empty: "Введите промокод.",
    code_not_found: "Такого промокода нет. Проверьте написание: GIFT-XXXXX.",
    own_code: "Это ваш собственный промокод — его можно только дарить друзьям.",
    already_referred: "Промокод друга уже применён к вашему аккаунту. Применить можно только один раз.",
    not_first_visit: "Промокод друга действует только до первой подтверждённой услуги.",
    program_disabled: "Реферальная программа сейчас не действует.",
    code_inactive: "Этот промокод больше не действует.",
    bonus_not_found: "Бонус не найден.",
    bonus_pending: "Запрос на этот бонус уже отправлен — администратор подтвердит его на приёме.",
    bonus_used: "Этот бонус уже использован.",
    bonus_expired: "Срок действия бонуса истёк.",
    bonus_cancelled: "Бонус отменён.",
    bad_service: "Выберите услугу из списка.",
    service_not_covered: "Этот бонус не действует на выбранную услугу.",
    phone_required: "Укажите телефон в профиле — по нему администратор узнает вас на приёме.",
    not_stackable: "Этот бонус нельзя совместить с другим, который уже ожидает подтверждения.",
    already_claimed: "На этот номер телефона подарок уже был оформлен. Он положен одному клиенту один раз.",
    phone_locked: "Телефон нельзя изменить, пока есть оформленные скидки. Позвоните нам, если номер сменился.",
    telegram_taken: "Этот Telegram уже привязан к другому аккаунту.",
    other_telegram_linked: "К аккаунту уже привязан другой Telegram.",
    telegram_not_configured: "Вход через Telegram временно недоступен.",
    email_already_set: "Email уже указан.",
    forbidden: "Нет доступа.",
    not_found: "Не найдено.",
    not_pending: "Запрос уже обработан.",
    not_confirmed: "Услуга ещё не подтверждена.",
    rule_incomplete: "Чтобы включить скидку, заполните размер, тип и срок действия (и услуги, если не «все»).",
    rule_bad_value: "Проверьте числа: размер скидки, срок и количество использований.",
    cannot_block_self: "Нельзя заблокировать себя.",
    bad_bonus: "Проверьте числа: размер скидки, срок и количество использований.",
    bad_title: "Напишите, как скидка будет называться у клиента (минимум 3 символа).",
    bad_amount: "Размер скидки: от 1 до 100% или от 1 до 100 000 ₽.",
    bad_days: "Срок действия — от 1 до 3650 дней.",
    bad_uses: "Количество использований — от 1 до 100.",
    no_services: "Отметьте хотя бы одну услугу или выберите «на все услуги».",
    user_not_active: "Клиент заблокирован или удалил аккаунт.",
    text_too_short: "Текст рассылки слишком короткий.",
    text_too_long: "Текст рассылки слишком длинный — максимум 3500 символов.",
    duplicate_broadcast: "Такая рассылка уже отправлена в течение последнего часа.",
    broadcast_limit: "Достигнут лимит: не больше 5 рассылок в сутки.",
    no_audience: "Пока никто не подписался на новости — отправлять некому.",
    no_telegram: "Привяжите Telegram к своему аккаунту, чтобы получить проверочное сообщение.",
    network: "Нет связи с сервером. Проверьте интернет и попробуйте ещё раз.",
    server_error: "Что-то пошло не так на сервере. Попробуйте ещё раз через минуту.",
    not_configured: "Личный кабинет скоро заработает."
  };

  function message(code) { return ERRORS[code] || ERRORS.server_error; }

  function SbError(code, status) { this.code = code; this.status = status; this.message = message(code); }

  function load() {
    try { var s = JSON.parse(localStorage.getItem(STORE) || "null"); return s && s.access_token ? s : null; }
    catch (e) { return null; }
  }
  function save(s) {
    try {
      if (s) localStorage.setItem(STORE, JSON.stringify({
        access_token: s.access_token, refresh_token: s.refresh_token,
        expires_at: s.expires_at || Math.floor(Date.now() / 1000) + (s.expires_in || 3600)
      }));
      else localStorage.removeItem(STORE);
    } catch (e) { /* приватный режим — сессия живёт до закрытия вкладки */ }
    memory = s ? load() || s : null;
    listeners.forEach(function (fn) { try { fn(!!memory); } catch (e) {} });
  }
  var memory = load();

  function headers(token) {
    var h = { "Content-Type": "application/json", apikey: KEY };
    h.Authorization = "Bearer " + (token || KEY);
    return h;
  }

  function call(path, opts) {
    return fetch(BASE + path, opts).catch(function () { throw new SbError("network", 0); })
      .then(function (r) {
        return r.text().then(function (t) {
          var j = null; try { j = t ? JSON.parse(t) : null; } catch (e) {}
          if (!r.ok) {
            var code = (j && (j.error_code || j.error || j.message)) || "server_error";
            if (typeof code !== "string") code = "server_error";
            if (r.status === 401 && !ERRORS[code]) code = "not_authenticated";
            throw new SbError(code, r.status);
          }
          return j;
        });
      });
  }

  function refresh() {
    var s = load();
    if (!s || !s.refresh_token) { save(null); return Promise.resolve(null); }
    if (refreshing) return refreshing;
    refreshing = call("/auth/v1/token?grant_type=refresh_token", {
      method: "POST", headers: headers(), body: JSON.stringify({ refresh_token: s.refresh_token })
    }).then(function (ns) { save(ns); return load(); })
      .catch(function (e) { if (e.code !== "network") save(null); throw e; })
      .finally(function () { refreshing = null; });
    return refreshing;
  }

  function token() {
    var s = load();
    if (!s) return Promise.resolve(null);
    if (s.expires_at - 60 > Date.now() / 1000) return Promise.resolve(s.access_token);
    return refresh().then(function (ns) { return ns && ns.access_token; });
  }

  function rpc(fn, args) {
    return token().then(function (t) {
      if (!t && fn !== "program_info") throw new SbError("not_authenticated", 401);
      return call("/rest/v1/rpc/" + fn, { method: "POST", headers: headers(t), body: JSON.stringify(args || {}) });
    }).then(function (res) {
      if (res && res.ok === false && res.error) throw new SbError(res.error, 400);
      return res;
    });
  }

  function account(action, body) {
    return token().catch(function () { return null; }).then(function (t) {
      var payload = Object.assign({ action: action }, body || {});
      return call("/functions/v1/account", { method: "POST", headers: headers(t), body: JSON.stringify(payload) });
    }).then(function (res) {
      if (res && res.session) save(res.session);
      return res;
    });
  }

  function verifyRecovery(tokenHash) {
    return call("/auth/v1/verify", {
      method: "POST", headers: headers(), body: JSON.stringify({ type: "recovery", token_hash: tokenHash })
    }).then(function (s) { save(s); return s; });
  }

  function updatePassword(pw) {
    return token().then(function (t) {
      return call("/auth/v1/user", { method: "PUT", headers: headers(t), body: JSON.stringify({ password: pw }) });
    });
  }

  function signOut() {
    var s = load();
    save(null);
    if (s) fetch(BASE + "/auth/v1/logout?scope=local", { method: "POST", headers: headers(s.access_token) }).catch(function () {});
  }

  window.SB = {
    enabled: !!(BASE && KEY),
    isSignedIn: function () { return !!load(); },
    onChange: function (fn) { listeners.push(fn); },
    rpc: rpc,
    account: account,
    verifyRecovery: verifyRecovery,
    updatePassword: updatePassword,
    signOut: signOut,
    message: message,
    // реферальный код из ссылки ?ref=GIFT-XXXXX хранится 30 дней
    storedRef: function () {
      try {
        var r = JSON.parse(localStorage.getItem("fz.ref") || "null");
        return r && r.until > Date.now() ? r.code : "";
      } catch (e) { return ""; }
    },
    storeRef: function (code) {
      try { localStorage.setItem("fz.ref", JSON.stringify({ code: code, until: Date.now() + 30 * 864e5 })); } catch (e) {}
    }
  };

  // Проверка имени — те же правила, что app.name_ok в БД (supabase/migrations/20261014000005_name_check.sql).
  // Мягкая: пропускает обычные имена (в т.ч. «Анна-Мария», «Мкртчян Арам»), отсекает «алшамлпмкшо», «фыва», «ааа».
  var KB_ROWS = ["йцукенгшщзхъ", "фывапролджэ", "ячсмитьбю", "qwertyuiop", "asdfghjkl", "zxcvbnm"];
  var STOP = ["тест", "test", "admin", "админ", "user", "имя", "name", "нет", "хз", "аноним", "anonymous", "qwerty", "asdf"];
  window.FZName = {
    clean: function (n) { return String(n || "").replace(/\s+/g, " ").trim(); },
    ok: function (n) {
      var v = window.FZName.clean(n).toLowerCase();
      if (v.length < 2 || v.length > 60) return false;
      if (!/^[a-zа-яё]+([ '-][a-zа-яё]+){0,3}$/.test(v)) return false;
      if (/[a-z]/.test(v) && /[а-яё]/.test(v)) return false;
      if (/(.)\1\1/.test(v)) return false;
      if (/[бвгджзйклмнпрстфхцчшщъь]{6}/.test(v) || /[bcdfghjklmnpqrstvwxz]{6}/.test(v)) return false;
      var words = v.split(/[ '-]/);
      for (var i = 0; i < words.length; i++) {
        if (!/[аеёиоуыэюяaeiouy]/.test(words[i]) || words[i].length > 20 || /^[ъьы]/.test(words[i])) return false;
      }
      for (var r = 0; r < KB_ROWS.length; r++) {
        for (var j = 0; j + 4 <= KB_ROWS[r].length; j++) {
          var seq = KB_ROWS[r].substr(j, 4);
          if (v.indexOf(seq) >= 0 || v.indexOf(seq.split("").reverse().join("")) >= 0) return false;
        }
      }
      return STOP.indexOf(v) < 0;
    }
  };

  // синхронизация входа/выхода между вкладками
  window.addEventListener("storage", function (e) {
    if (e.key === STORE) { memory = load(); listeners.forEach(function (fn) { try { fn(!!memory); } catch (x) {} }); }
  });
})();
