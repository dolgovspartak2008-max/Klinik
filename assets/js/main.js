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
  var mapKeys = { salavatMap: true, ufaMap: true };
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

  /* ---------- Слайдер услуг ---------- */
  var track = doc.getElementById("svcTrack");
  var prev = doc.getElementById("svcPrev");
  var next = doc.getElementById("svcNext");
  var bar = doc.getElementById("svcBar");
  function step() {
    var card = track.querySelector(".svc-card");
    return card ? card.getBoundingClientRect().width + 24 : 300;
  }
  function updateSlider() {
    var max = track.scrollWidth - track.clientWidth;
    var ratio = max > 0 ? track.scrollLeft / max : 0;
    var visible = track.scrollWidth ? track.clientWidth / track.scrollWidth : 1;
    bar.style.width = Math.max(visible * 100, 12) + "%";
    bar.style.transform = "translateX(" + (ratio * (100 / Math.max(visible, 0.12) - 100)) + "%)";
    prev.disabled = track.scrollLeft < 4;
    next.disabled = track.scrollLeft > max - 4;
  }
  prev.addEventListener("click", function () { track.scrollBy({ left: -step(), behavior: "smooth" }); });
  next.addEventListener("click", function () { track.scrollBy({ left: step(), behavior: "smooth" }); });
  track.addEventListener("scroll", updateSlider, { passive: true });
  window.addEventListener("resize", updateSlider);
  track.addEventListener("keydown", function (e) {
    if (e.key === "ArrowRight") { e.preventDefault(); next.click(); }
    if (e.key === "ArrowLeft") { e.preventDefault(); prev.click(); }
  });
  updateSlider();

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

  /* ---------- Окно записи ---------- */
  var modal = doc.getElementById("booking");
  var lastFocus = null;
  function openModal() {
    lastFocus = doc.activeElement;
    modal.hidden = false;
    body.style.overflow = "hidden";
    var first = modal.querySelector(".modal__opt");
    if (first) first.focus();
  }
  function closeModal() {
    modal.hidden = true;
    body.style.overflow = "";
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  }
  doc.querySelectorAll("[data-open-booking]").forEach(function (b) { b.addEventListener("click", openModal); });
  modal.querySelectorAll("[data-close-booking]").forEach(function (b) { b.addEventListener("click", closeModal); });
  doc.addEventListener("keydown", function (e) {
    if (modal.hidden) return;
    if (e.key === "Escape") closeModal();
    if (e.key === "Tab") {
      var f = modal.querySelectorAll("a, button");
      var firstEl = f[0], lastEl = f[f.length - 1];
      if (e.shiftKey && doc.activeElement === firstEl) { e.preventDefault(); lastEl.focus(); }
      else if (!e.shiftKey && doc.activeElement === lastEl) { e.preventDefault(); firstEl.focus(); }
    }
  });

  /* ---------- Год в подвале ---------- */
  var y = doc.getElementById("year");
  if (y) y.textContent = String(new Date().getFullYear());
})();
