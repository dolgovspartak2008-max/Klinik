(function () {
  "use strict";

  var doc = document;
  var body = doc.body;
  var reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var finePointer = window.matchMedia("(hover: hover) and (pointer: fine)").matches;
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
  var mapKeys = { salavatMap: true };
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
    if (key === "phone" || key === "phoneDoctor") {
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

  function startPage() {
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

  /* ---------- Hero: свечение за курсором и параллакс ---------- */
  if (finePointer && !reduceMotion) {
    var panel = doc.querySelector(".hero__panel");
    var spot = doc.getElementById("heroSpot");
    var heroImg = doc.querySelector(".hero__blob img");
    var raf = 0, mx = 0, my = 0;
    panel.addEventListener("mousemove", function (e) {
      var r = panel.getBoundingClientRect();
      mx = e.clientX - r.left; my = e.clientY - r.top;
      if (raf) return;
      raf = requestAnimationFrame(function () {
        raf = 0;
        spot.style.left = mx + "px";
        spot.style.top = my + "px";
        var dx = (mx / r.width - 0.5) * 2, dy = (my / r.height - 0.5) * 2;
        heroImg.style.transform = "scale(1.12) translate(" + (dx * -12) + "px," + (dy * -10) + "px)";
      });
    });

    // «Магнитные» кнопки
    doc.querySelectorAll(".magnetic").forEach(function (btn) {
      btn.addEventListener("mousemove", function (e) {
        var r = btn.getBoundingClientRect();
        var x = (e.clientX - r.left - r.width / 2) * 0.18;
        var y = (e.clientY - r.top - r.height / 2) * 0.3;
        btn.style.transform = "translate(" + x + "px," + y + "px)";
      });
      btn.addEventListener("mouseleave", function () { btn.style.transform = ""; });
    });
  }

  /* ---------- Модальные окна (запись, выбор Instagram) ---------- */
  var openedModal = null;
  var lastFocus = null;
  function focusables(m) { return m.querySelectorAll("a[href], button:not([disabled]), input:not([tabindex='-1']), select"); }
  function openModal(m) {
    if (openedModal) closeModal();
    lastFocus = doc.activeElement;
    openedModal = m;
    m.hidden = false;
    body.style.overflow = "hidden";
    var first = m.querySelector("input[name=name]") || m.querySelector(".ig-choice__opt, .modal__opt");
    if (first) setTimeout(function () { first.focus(); }, 60);
  }
  function closeModal() {
    if (!openedModal) return;
    openedModal.hidden = true;
    openedModal = null;
    body.style.overflow = "";
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

  /* ---------- Заявки ---------- */
  var L = window.SITE_LEADS || {};
  var SERVICES = [
    ["promo", "Бесплатная консультация + процедура (акция)"],
    ["Здоровая спина 3.0", "Здоровая спина 3.0 — 4 600 ₽"],
    ["Здоровая спина 5.0 / 7.0", "Здоровая спина 5.0 / 7.0 — от 5 900 ₽"],
    ["Здоровые суставы", "Здоровые суставы — 4 600 ₽"],
    ["Резорбция грыжи", "Резорбция грыжи — 5 300 ₽"],
    ["Ударно-волновая терапия", "Ударно-волновая терапия — от 1 500 ₽"],
    ["Магнит высокой интенсивности", "Магнит высокой интенсивности — от 1 800 ₽"],
    ["Вакуумно-градиентная терапия", "Вакуумно-градиентная терапия — от 2 000 ₽"],
    ["Хиджама", "Хиджама — от 2 000 ₽"],
    ["Иглоукалывание", "Иглоукалывание — от 2 000 ₽"],
    ["Консультация по методикам", "Другое / нужна консультация"]
  ];
  function serviceLabel(v) {
    for (var i = 0; i < SERVICES.length; i++) if (SERVICES[i][0] === v) return SERVICES[i][1];
    return v;
  }
  doc.querySelectorAll("[data-service-select]").forEach(function (sel) {
    SERVICES.forEach(function (s) {
      var o = doc.createElement("option");
      o.value = s[0]; o.textContent = s[1];
      sel.appendChild(o);
    });
  });

  var booking = doc.getElementById("booking");
  var bookingSelect = booking.querySelector("[data-service-select]");
  doc.querySelectorAll("[data-open-booking]").forEach(function (b) {
    b.addEventListener("click", function () {
      var s = b.getAttribute("data-service");
      if (s) bookingSelect.value = s;
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
    return "Заявка с сайта — Центр здоровья, Салават\n" +
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

  /* ---------- Липкая кнопка акции ---------- */
  var sticky = doc.getElementById("stickyCta");
  var promoSec = doc.getElementById("promo");
  function onStick() {
    var y = window.scrollY;
    var r = promoSec.getBoundingClientRect();
    var inPromo = r.top < window.innerHeight && r.bottom > 0;
    var nearEnd = window.innerHeight + y > doc.documentElement.scrollHeight - 200;
    sticky.classList.toggle("is-shown", y > window.innerHeight * 0.8 && !inPromo && !nearEnd);
  }
  window.addEventListener("scroll", onStick, { passive: true });
  onStick();

  /* ---------- Год в подвале ---------- */
  var y = doc.getElementById("year");
  if (y) y.textContent = String(new Date().getFullYear());
})();
