(function () {
  "use strict";

  var doc = document;
  var body = doc.body;
  var reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var C = window.SITE_CONTACTS || {};

  /* ---------- Toast ---------- */
  var toastEl = doc.getElementById("toast");
  var toastTimer;
  function toast(msg) {
    if (!toastEl) return;
    toastEl.textContent = msg;
    toastEl.classList.add("is-shown");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.classList.remove("is-shown"); }, 3200);
  }

  /* ---------- Контакты из config.js ---------- */
  var mapKeys = { map: true };
  doc.querySelectorAll("[data-contact]").forEach(function (a) {
    var key = a.getAttribute("data-contact");
    var val = (C[key] || "").trim();
    if (!val) {
      if (a.classList.contains("modal__opt")) { a.hidden = true; return; }
      if (a.classList.contains("social")) a.classList.add("is-soon");
      a.addEventListener("click", function (e) {
        e.preventDefault();
        toast(mapKeys[key]
          ? "Адрес скоро появится — уточните его по телефону"
          : "Этот контакт скоро появится — пока позвоните или напишите в WhatsApp");
      });
      return;
    }
    if (key === "phone") {
      a.href = "tel:" + val.replace(/[^\d+]/g, "");
    } else {
      a.href = val;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
    }
  });
  doc.querySelectorAll("[data-contact-text]").forEach(function (el) {
    var val = (C[el.getAttribute("data-contact-text")] || "").trim();
    if (val) el.textContent = val;
  });

  /* ---------- Intro ---------- */
  var intro = doc.getElementById("intro");
  var seen = false;
  try { seen = sessionStorage.getItem("introSeen") === "1"; } catch (e) {}
  var introDone = false;

  var qs = new URLSearchParams(location.search);
  var bookParam = qs.get("book"), toParam = qs.get("to");
  if (bookParam || toParam) history.replaceState(null, "", location.pathname);
  function startPage() {
    window.scrollTo({ top: 0, left: 0, behavior: "instant" });
    setTimeout(function () {
      if (toParam && doc.getElementById(toParam)) {
        var t = doc.getElementById(toParam);
        window.scrollTo({ top: t.getBoundingClientRect().top + window.scrollY - 70, behavior: "instant" });
      }
      if (bookParam && window.__openBooking) window.__openBooking(bookParam);
    }, 50);
    body.classList.remove("is-loading");
    body.classList.add("is-ready");
  }
  function finishIntro() {
    if (introDone) return;
    introDone = true;
    try { sessionStorage.setItem("introSeen", "1"); } catch (e) {}
    if (!intro || reduceMotion) { if (intro) intro.classList.add("is-gone"); startPage(); return; }
    intro.classList.add("is-leaving");
    setTimeout(startPage, 380);
    setTimeout(function () { intro.classList.add("is-gone"); }, 1050);
  }

  if (!intro || reduceMotion) {
    finishIntro();
  } else if (seen) {
    // Повторный заход в этой вкладке — короткая версия
    intro.classList.add("is-gone");
    introDone = true;
    startPage();
  } else {
    var minTime = 2350;
    var t0 = performance.now();
    var go = function () {
      var wait = Math.max(0, minTime - (performance.now() - t0));
      setTimeout(finishIntro, wait);
    };
    if (doc.readyState === "complete") go(); else window.addEventListener("load", go);
    setTimeout(finishIntro, 4500); // страховка при медленной сети
    intro.addEventListener("click", finishIntro);
    doc.addEventListener("keydown", function onKey(e) {
      if (e.key === "Escape" || e.key === "Enter" || e.key === " ") { finishIntro(); doc.removeEventListener("keydown", onKey); }
    });
  }

  /* ---------- Header ---------- */
  var header = doc.getElementById("header");
  function onScroll() { header.classList.toggle("is-scrolled", window.scrollY > 30); }
  window.addEventListener("scroll", onScroll, { passive: true });
  onScroll();

  var burger = doc.getElementById("burger");
  var nav = doc.getElementById("nav");
  function setMenu(open) {
    nav.classList.toggle("is-open", open);
    header.classList.toggle("menu-open", open);
    burger.setAttribute("aria-expanded", String(open));
    burger.setAttribute("aria-label", open ? "Закрыть меню" : "Открыть меню");
    body.style.overflow = open ? "hidden" : "";
    doc.documentElement.classList.toggle("menu-lock", open);
    var tc = doc.querySelector('meta[name="theme-color"]');
    if (tc) tc.setAttribute("content", open ? "#050b24" : "#0b1742");
  }
  burger.addEventListener("click", function () { setMenu(!nav.classList.contains("is-open")); });
  nav.querySelectorAll("a, button").forEach(function (el) {
    el.addEventListener("click", function () { if (nav.classList.contains("is-open")) setMenu(false); });
  });

  // Активный пункт меню
  var links = Array.prototype.slice.call(doc.querySelectorAll(".nav__link"));
  var sections = links.map(function (l) { return doc.querySelector(l.getAttribute("href")); }).filter(Boolean);
  if ("IntersectionObserver" in window) {
    var navIO = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (!en.isIntersecting) return;
        var id = "#" + en.target.id;
        links.forEach(function (l) { l.classList.toggle("is-active", l.getAttribute("href") === id); });
      });
    }, { rootMargin: "-45% 0px -50% 0px" });
    sections.forEach(function (s) { navIO.observe(s); });
  }

  /* ---------- Reveal on scroll ---------- */
  var revealEls = doc.querySelectorAll("[data-reveal]");
  if ("IntersectionObserver" in window && !reduceMotion) {
    // лёгкая задержка «лесенкой» для соседних элементов
    var groups = new Map();
    revealEls.forEach(function (el) {
      var p = el.parentElement;
      var i = groups.get(p) || 0;
      el.style.setProperty("--d", Math.min(i * 0.08, 0.4) + "s");
      groups.set(p, i + 1);
    });
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (en.isIntersecting) { en.target.classList.add("is-in"); io.unobserve(en.target); }
      });
    }, { threshold: 0.12, rootMargin: "0px 0px -40px 0px" });
    revealEls.forEach(function (el) { io.observe(el); });
  } else {
    revealEls.forEach(function (el) { el.classList.add("is-in"); });
  }

  /* ---------- Услуги: фильтр Комплексы / Процедуры ---------- */
  var grid = doc.getElementById("priceGrid");
  doc.querySelectorAll(".tabs__btn").forEach(function (btn, _, all) {
    btn.addEventListener("click", function () {
      var f = btn.getAttribute("data-filter");
      all.forEach(function (b) { var on = b === btn; b.classList.toggle("is-active", on); b.setAttribute("aria-selected", String(on)); });
      grid.querySelectorAll(".price-card").forEach(function (c) {
        c.hidden = !(f === "all" || c.getAttribute("data-kind") === f);
        c.classList.add("is-in");
      });
      grid.hidden = f === "massage";
      doc.querySelectorAll("[data-kind-block]").forEach(function (blk) {
        blk.hidden = !(f === "all" || blk.getAttribute("data-kind-block") === f);
        blk.classList.add("is-in");
      });
    });
  });

  // Видео в карточке играет только когда видно
  var vids = doc.querySelectorAll("video[data-autoplay]");
  if ("IntersectionObserver" in window && !reduceMotion) {
    var vio = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        var v = en.target;
        if (en.isIntersecting) { var pr = v.play(); if (pr && pr.catch) pr.catch(function () {}); } else v.pause();
      });
    }, { threshold: 0.35 });
    vids.forEach(function (v) { vio.observe(v); });
  }

  /* ---------- Модальные окна (запись, выбор Instagram) ---------- */
  var openedModal = null;
  var lastFocus = null;
  function focusables(m) { return m.querySelectorAll("a[href], button:not([disabled]), input:not([tabindex='-1']):not([type=hidden])"); }
  function openModal(m) {
    if (openedModal) closeModal();
    lastFocus = doc.activeElement;
    openedModal = m;
    m.hidden = false;
    body.style.overflow = "hidden";
    doc.documentElement.classList.add("menu-lock");
    var first = m.querySelector("input[name=name]") || m.querySelector(".ig-choice__opt, .modal__opt");
    if (first) setTimeout(function () { first.focus(); }, 60);
  }
  function closeModal() {
    if (!openedModal) return;
    openedModal.hidden = true;
    openedModal = null;
    body.style.overflow = "";
    doc.documentElement.classList.remove("menu-lock");
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  }
  doc.querySelectorAll("[data-close-modal]").forEach(function (b) { b.addEventListener("click", closeModal); });
  doc.addEventListener("keydown", function (e) {
    if (!openedModal) return;
    if (e.key === "Escape") closeModal();
    if (e.key === "Tab") {
      var f = focusables(openedModal);
      var firstEl = f[0], lastEl = f[f.length - 1];
      if (e.shiftKey && doc.activeElement === firstEl) { e.preventDefault(); lastEl.focus(); }
      else if (!e.shiftKey && doc.activeElement === lastEl) { e.preventDefault(); firstEl.focus(); }
    }
  });

  /* ---------- Instagram: выбор клиника / врач ---------- */
  var igModal = doc.getElementById("igModal");
  doc.querySelectorAll("[data-open-ig]").forEach(function (b) { b.addEventListener("click", function () { openModal(igModal); }); });
  doc.querySelectorAll("[data-ig-handle]").forEach(function (el) {
    var url = (C[el.getAttribute("data-ig-handle")] || "").trim();
    var m = url.match(/instagram\.com\/([^/?#]+)/i);
    el.textContent = m ? "@" + m[1] : "скоро появится";
  });
  igModal.querySelectorAll("a").forEach(function (a) { a.addEventListener("click", function () { if (a.target === "_blank") closeModal(); }); });

  /* ---------- Видео «Что взять на приём» ---------- */
  var pv = doc.getElementById("prepVideo"), pb = doc.getElementById("prepPlay");
  if (pv && pb) {
    var withSound = false;
    if ("IntersectionObserver" in window && !reduceMotion) {
      new IntersectionObserver(function (en) {
        en.forEach(function (e) {
          if (e.isIntersecting) { var pr = pv.play(); if (pr && pr.catch) pr.catch(function () {}); }
          else pv.pause();
        });
      }, { threshold: 0.4 }).observe(pv);
    }
    pb.addEventListener("click", function () {
      withSound = true;
      pv.muted = false; pv.loop = false; pv.currentTime = 0; pv.controls = true;
      var pr = pv.play(); if (pr && pr.catch) pr.catch(function () {});
      pb.hidden = true;
    });
    pv.addEventListener("ended", function () { if (withSound) { pb.hidden = false; pv.controls = false; pv.muted = true; pv.loop = true; withSound = false; } });
  }

  /* ---------- Подробнее об услуге — отдельная страница ---------- */
  doc.querySelectorAll(".price-card[data-info]").forEach(function (card) {
    var url = "usluga.html?s=" + card.getAttribute("data-info");
    var cta = card.querySelector(".price-card__cta");
    var row = doc.createElement("div"); row.className = "price-card__actions";
    var more = doc.createElement("a"); more.className = "btn btn--outline price-card__more"; more.href = url; more.textContent = "Подробнее";
    cta.parentNode.insertBefore(row, cta);
    row.appendChild(more); row.appendChild(cta);
    card.addEventListener("click", function (e) {
      if (e.target.closest("button, a")) return;
      location.href = url;
    });
  });

  /* ---------- Заявки ---------- */
  var L = window.SITE_LEADS || {};
  var SERVICES = [
    { v: "promo", name: "Бесплатная консультация и процедура", price: "0 ₽", group: "Акция" },
    { v: "Здоровая спина 3.0", name: "Здоровая спина 3.0", price: "4 600 ₽", group: "Комплексные программы" },
    { v: "Здоровая спина 5.0 / 7.0", name: "Здоровая спина 5.0 / 7.0", price: "от 5 900 ₽" },
    { v: "Здоровые суставы", name: "Здоровые суставы", price: "4 600 ₽" },
    { v: "Резорбция грыжи", name: "Резорбция грыжи", price: "5 300 ₽" },
    { v: "Ударно-волновая терапия", name: "Ударно-волновая терапия", price: "от 1 500 ₽", group: "Процедуры" },
    { v: "Магнит высокой интенсивности", name: "Магнит высокой интенсивности", price: "от 1 800 ₽" },
    { v: "Лазер высокой интенсивности", name: "Лазер высокой интенсивности", price: "от 2 000 ₽" },
    { v: "Вакуумно-градиентная терапия", name: "Вакуумно-градиентная терапия", price: "от 1 500 ₽" },
    { v: "Кресло Emsella", name: "Кресло Emsella", price: "от 1 500 ₽" },
    { v: "Хиджама", name: "Хиджама", price: "от 2 000 ₽" },
    { v: "Иглоукалывание", name: "Иглоукалывание", price: "от 2 000 ₽" },
    { v: "Массаж всего тела", name: "Массаж всего тела", price: "от 2 950 ₽", group: "Массаж" },
    { v: "Массаж спины", name: "Массаж спины", price: "2 500 ₽" },
    { v: "Массаж шейно-воротниковой зоны", name: "Массаж шейно-воротниковой зоны", price: "2 000 ₽" },
    { v: "Массаж ног", name: "Массаж ног", price: "2 000 ₽" },
    { v: "Массаж для беременных", name: "Массаж для беременных", price: "3 500 ₽" },
    { v: "Антицеллюлитный массаж", name: "Антицеллюлитный массаж", price: "3 000 ₽" },
    { v: "Спортивный массаж", name: "Спортивный массаж", price: "3 290 ₽" },
    { v: "Детский массаж", name: "Детский массаж", price: "2 000 ₽" },
    { v: "Консультация по методикам", name: "Другое — подберёт врач", price: "", group: "Другое" }
  ];
  function findService(v) {
    for (var i = 0; i < SERVICES.length; i++) if (SERVICES[i].v === v) return SERVICES[i];
    return null;
  }
  function serviceLabel(v) {
    var s = findService(v);
    return s ? s.name + (s.price ? " (" + s.price + ")" : "") : v;
  }

  /* Собственный выпадающий список услуг (одинаково выглядит на всех устройствах) */
  var dds = [];
  function makeDD(root) {
    var btn = root.querySelector(".dd__btn");
    var val = root.querySelector(".dd__val");
    var list = root.querySelector(".dd__list");
    var input = root.querySelector("input[type=hidden]");
    var uid = "dd" + dds.length;
    var items = [];
    SERVICES.forEach(function (s, i) {
      if (s.group) {
        var g = doc.createElement("li");
        g.className = "dd__group"; g.setAttribute("role", "presentation"); g.textContent = s.group;
        list.appendChild(g);
      }
      var li = doc.createElement("li");
      li.className = "dd__opt"; li.id = uid + "-" + i;
      li.setAttribute("role", "option"); li.setAttribute("data-v", s.v);
      li.innerHTML = '<span class="dd__name"></span><span class="dd__price"></span>';
      li.firstChild.textContent = s.name; li.lastChild.textContent = s.price;
      li.addEventListener("click", function () { set(s.v); close(true); });
      li.addEventListener("mousemove", function () { highlight(i); });
      list.appendChild(li);
      items.push(li);
    });
    btn.id = uid + "-btn";
    list.setAttribute("aria-labelledby", btn.id);
    var active = 0;
    function highlight(i) {
      active = Math.max(0, Math.min(items.length - 1, i));
      items.forEach(function (el, k) { el.classList.toggle("is-active", k === active); });
      list.setAttribute("aria-activedescendant", items[active].id);
      var el = items[active], top = el.offsetTop, bottom = top + el.offsetHeight;
      if (top < list.scrollTop) list.scrollTop = top - 30;
      else if (bottom > list.scrollTop + list.clientHeight) list.scrollTop = bottom - list.clientHeight;
    }
    function set(v) {
      var s = findService(v) || SERVICES[0];
      input.value = s.v;
      val.innerHTML = '<span></span>' + (s.price ? '<small></small>' : "");
      val.firstChild.textContent = s.name;
      if (s.price) val.lastChild.textContent = s.price;
      items.forEach(function (el) { el.setAttribute("aria-selected", String(el.getAttribute("data-v") === s.v)); });
    }
    function open() {
      dds.forEach(function (d) { if (d !== api) d.close(); });
      root.classList.add("is-open");
      btn.setAttribute("aria-expanded", "true");
      var r = btn.getBoundingClientRect();
      root.classList.toggle("dd--up", window.innerHeight - r.bottom < 300 && r.top > window.innerHeight - r.bottom);
      var cur = 0;
      items.forEach(function (el, k) { if (el.getAttribute("data-v") === input.value) cur = k; });
      list.scrollTop = 0;
      highlight(cur);
      requestAnimationFrame(function () { list.focus({ preventScroll: true }); });
    }
    function close(focusBtn) {
      if (!root.classList.contains("is-open")) return;
      root.classList.remove("is-open");
      btn.setAttribute("aria-expanded", "false");
      if (focusBtn) btn.focus({ preventScroll: true });
    }
    btn.addEventListener("click", function () { root.classList.contains("is-open") ? close(true) : open(); });
    btn.addEventListener("keydown", function (e) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        if (!root.classList.contains("is-open")) open(); else { highlight(active + (e.key === "ArrowDown" ? 1 : -1)); list.focus({ preventScroll: true }); }
      }
    });
    list.addEventListener("keydown", function (e) {
      if (e.key === "ArrowDown") { e.preventDefault(); highlight(active + 1); }
      else if (e.key === "ArrowUp") { e.preventDefault(); highlight(active - 1); }
      else if (e.key === "Home") { e.preventDefault(); highlight(0); }
      else if (e.key === "End") { e.preventDefault(); highlight(items.length - 1); }
      else if (e.key === "Enter" || e.key === " ") { e.preventDefault(); set(items[active].getAttribute("data-v")); close(true); }
      else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(true); }
      else if (e.key === "Tab") { close(false); }
    });
    doc.addEventListener("click", function (e) { if (!root.contains(e.target)) close(false); });
    var api = { root: root, set: set, close: close };
    set(input.value || "promo");
    dds.push(api);
    return api;
  }
  doc.querySelectorAll("[data-dd]").forEach(makeDD);

  var booking = doc.getElementById("booking");
  var bookingDD = dds.filter(function (d) { return booking.contains(d.root); })[0];
  window.__openBooking = function (svc) { if (bookingDD) bookingDD.set(svc); openModal(booking); };
  doc.querySelectorAll("[data-open-booking]").forEach(function (b) {
    b.addEventListener("click", function () {
      var s = b.getAttribute("data-service");
      if (s && bookingDD) bookingDD.set(s);
      openModal(booking);
    });
  });

  // Проверяем, настроена ли автоотправка (Vercel-функция)
  var autoSend = false;
  if (L.endpoint && location.protocol.indexOf("http") === 0) {
    fetch(L.endpoint, { method: "GET", headers: { Accept: "application/json" } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) { autoSend = !!(j && j.configured); })
      .catch(function () {});
  }

  function normPhone(v) {
    var d = String(v || "").replace(/\D/g, "");
    if (d.length === 11 && d.charAt(0) === "8") d = "7" + d.slice(1);
    if (d.length === 10) d = "7" + d;
    return d;
  }
  function leadText(data) {
    return "Заявка с сайта — Физиотера, Уфа\n" +
      "Имя: " + data.name + "\n" +
      "Телефон: +" + data.phone + "\n" +
      "Интересует: " + serviceLabel(data.service);
  }
  function waLink(data) {
    return "https://wa.me/" + String(L.whatsapp || "").replace(/\D/g, "") + "?text=" + encodeURIComponent(leadText(data));
  }

  doc.querySelectorAll("[data-lead-form]").forEach(function (form) {
    var status = form.querySelector(".lead-form__status");
    var submit = form.querySelector(".lead-form__submit");
    function setStatus(html, kind) {
      status.innerHTML = html;
      status.className = "lead-form__status" + (kind ? " is-" + kind : "");
    }
    form.querySelectorAll("input, select").forEach(function (el) {
      el.addEventListener("input", function () { el.closest(".field, .check") && el.closest(".field, .check").classList.remove("is-invalid"); });
    });

    form.addEventListener("submit", function (e) {
      e.preventDefault();
      var f = form.elements;
      if (f.website.value) return; // бот
      var data = {
        name: f.name.value.trim(),
        phone: normPhone(f.phone.value),
        service: f.service.value,
        page: location.href.split("#")[0]
      };
      var bad = [];
      if (data.name.length < 2) bad.push(f.name);
      if (data.phone.length !== 11) bad.push(f.phone);
      if (!f.consent.checked) bad.push(f.consent);
      bad.forEach(function (el) { el.closest(".field, .check").classList.add("is-invalid"); });
      if (bad.length) {
        setStatus(bad[0] === f.phone ? "Проверьте номер телефона" : bad[0] === f.consent ? "Нужно согласие на обработку данных" : "Укажите имя", "error");
        bad[0].focus();
        return;
      }

      function done() {
        form.classList.add("is-sent");
        setStatus("<b>Спасибо, " + data.name.replace(/[<>&"]/g, "") + "!</b> Заявка принята — администратор скоро перезвонит.", "ok");
        form.reset();
        dds.forEach(function (d) { if (form.contains(d.root)) d.set("promo"); });
        if (typeof window.ym === "function") try { window.ym("reachGoal", "lead"); } catch (err) {}
      }
      function viaWhatsApp(openNow) {
        var url = waLink(data);
        if (openNow) window.open(url, "_blank", "noopener");
        setStatus("Осталось нажать «Отправить» в&nbsp;WhatsApp. <a href=\"" + url + "\" target=\"_blank\" rel=\"noopener\">Открыть WhatsApp →</a>", "ok");
      }

      if (!autoSend) { viaWhatsApp(true); return; }

      submit.disabled = true;
      setStatus("Отправляем заявку…");
      var ctrl = "AbortController" in window ? new AbortController() : null;
      var timer = setTimeout(function () { if (ctrl) ctrl.abort(); }, 9000);
      fetch(L.endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
        signal: ctrl ? ctrl.signal : undefined
      })
        .then(function (r) { return r.json().catch(function () { return {}; }); })
        .then(function (j) { if (j && j.ok) done(); else viaWhatsApp(false); })
        .catch(function () { viaWhatsApp(false); })
        .then(function () { clearTimeout(timer); submit.disabled = false; });
    });
  });

  /* ---------- Год в подвале ---------- */
  var y = doc.getElementById("year");
  if (y) y.textContent = String(new Date().getFullYear());
})();
