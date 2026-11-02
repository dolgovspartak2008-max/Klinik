/* Личный кабинет: «Мои курсы», заказы, активация подарочного кода. */
(function () {
  "use strict";
  var doc = document, SB = window.SB, C = window.FZC;
  if (!SB || !C || !SB.enabled) return;
  var esc = C.esc;
  function $(s, r) { return (r || doc).querySelector(s); }
  var block = $("[data-my-courses-block]");
  if (!block) return;

  var SRC = { purchase: "Куплен", bundle: "Куплен в комплекте", gift: "Получен в подарок", manual: "Выдан клиникой", promo: "Получен по промокоду" };
  var ST = { pending: "ожидает оплаты", paid: "оплачен", cancelled: "отменён", expired: "истёк срок оплаты", refunded: "возврат" };

  function date(iso) { return iso ? new Date(iso).toLocaleDateString("ru-RU", { day: "numeric", month: "long", year: "numeric" }) : ""; }

  function render(d) {
    var list = $("[data-my-courses]");
    if (d.blocked) {
      list.innerHTML = '<p class="buy-note buy-note--warn">Доступ к курсам на аккаунте приостановлен. Если это ошибка — позвоните в клинику: +7 (987) 600-00-37.</p>';
    } else if (!d.courses.length) {
      list.innerHTML = '<div class="cab-empty">У вас пока нет курсов. Видеозанятия для суставов и спины — в <a href="/kursy/"><b>каталоге курсов</b></a>.</div>';
    } else {
      list.innerHTML = d.courses.map(function (c) {
        var p = c.progress || {};
        var learn = "/kursy/" + encodeURIComponent(c.slug) + "/uroki/";
        return '<article class="my-course">' + C.cover(c) +
          "<div><h3>" + esc(c.title) + '</h3><p class="my-course__meta">' +
          esc(c.category ? c.category.title : "") + " · " + (SRC[c.source] || "Приобретён") + " " + date(c.granted_at) +
          (c.expires_at ? " · доступ до " + date(c.expires_at) : "") + "</p>" +
          '<div class="crs-progress"><i style="width:' + (p.percent || 0) + '%"></i></div>' +
          '<p class="my-course__meta">Пройдено ' + (p.completed || 0) + " из " + (p.total || 0) + " · " + (p.percent || 0) + "%" +
          (c.last_lesson_title ? " · последний урок: «" + esc(c.last_lesson_title) + "»" : "") + "</p></div>" +
          '<a class="btn btn--primary btn--sm" href="' + learn + '">' + (p.completed || p.last_lesson_id ? "Продолжить обучение" : "Начать") + "</a></article>";
      }).join("");
    }
    var orders = d.orders || [];
    $("[data-my-orders-wrap]").hidden = !orders.length;
    $("[data-my-orders]").innerHTML = orders.map(function (o) {
      return '<div class="my-order"><span><b>№ ' + o.order_no + "</b> · " + esc(o.title) + (o.is_gift ? " (подарок)" : "") + " · " + C.money(o.total) + "</span>" +
        "<span>" + (ST[o.status] || o.status) + (o.status === "pending" ? ' · <button class="acc-link" type="button" data-cancel-order="' + esc(o.id) + '">отменить</button>' : "") + "</span>" +
        (o.gift ? '<span>Подарочный код: <code>' + esc(o.gift.code) + "</code> " + (o.gift.status === "activated" ? "— активирован" : o.gift.status === "cancelled" ? "— аннулирован" : "— передайте получателю") + "</span>" : "") +
        (o.status === "pending" ? '<span class="cab-muted cab-small">Администратор свяжется с вами для оплаты. Доступ откроется автоматически после подтверждения.</span>' : "") +
        "</div>";
    }).join("");
    $("[data-course-news]").checked = !!d.course_news;
  }

  function load() {
    return SB.rpc("my_courses").then(render).catch(function (e) {
      if (e.code === "not_authenticated") { block.hidden = true; return; }
      $("[data-my-courses]").innerHTML = '<p class="acc-status is-error">' + esc(e.message) + "</p>";
    });
  }

  if (!SB.isSignedIn()) return;
  load().then(function () {
    if (location.hash !== "#courses") return;
    var n = 0, t = setInterval(function () {
      if (block.offsetParent || ++n > 40) { clearInterval(t); if (block.offsetParent) block.scrollIntoView({ block: "start" }); }
    }, 150);
  });

  block.addEventListener("click", function (e) {
    var b = e.target.closest("[data-cancel-order]");
    if (!b) return;
    if (!confirm("Отменить заказ?")) return;
    b.disabled = true;
    SB.rpc("course_order_cancel", { p_order: b.getAttribute("data-cancel-order") })
      .then(function () { if (window.FZToast) window.FZToast("Заказ отменён"); load(); })
      .catch(function (err) { b.disabled = false; if (window.FZToast) window.FZToast(err.message); });
  });

  $("[data-gift-form]").addEventListener("submit", function (e) {
    e.preventDefault();
    var f = e.target, st = $("[data-gift-status]"), btn = f.querySelector("button");
    var code = f.elements.code.value.trim().toUpperCase();
    if (!code) { st.textContent = "Введите код."; st.className = "acc-status is-error"; return; }
    btn.disabled = true;
    SB.rpc("gift_activate", { p_code: code }).then(function (r) {
      st.textContent = "Готово! «" + r.title + "» добавлен в ваши курсы."; st.className = "acc-status is-ok";
      f.reset(); load();
    }).catch(function (err) { st.textContent = err.message; st.className = "acc-status is-error"; })
      .then(function () { btn.disabled = false; });
  });

  $("[data-course-news]").addEventListener("change", function (e) {
    var on = e.target.checked;
    SB.rpc("set_course_news", { p_on: on }).then(function () {
      if (window.FZToast) window.FZToast(on ? "Будем сообщать о новых уроках" : "Уведомления о новых уроках выключены");
    }).catch(function (err) { e.target.checked = !on; if (window.FZToast) window.FZToast(err.message); });
  });
})();
