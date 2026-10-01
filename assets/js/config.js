/*
 * Контакты сайта (Центр здоровья, Салават). Чтобы поменять телефон или ссылку — правьте только этот файл.
 * Пустая строка = кнопка показывает подсказку «контакт скоро появится»
 * и никуда не ведёт (чтобы не отправлять пациентов на чужие страницы).
 *
 * Формат:
 *   telegram:  "https://t.me/username"
 *   max:       ссылка на профиль/канал в MAX
 *   salavatMap: ссылка на Яндекс Карты или 2ГИС
 */
window.SITE_CONTACTS = {
  phone: "+79930440619",            // номер для записи — на всех кнопках «Позвонить»
  phoneLabel: "8 (993) 044-06-19",
  phoneDoctor: "+79173816478",      // номер врача
  phoneDoctorLabel: "8 (917) 381-64-78",
  whatsapp: "https://api.whatsapp.com/send?phone=79173816478",
  telegram: "https://t.me/DrGorshechnikov",
  vk: "https://vk.ru/id26910903",
  instagram: "https://www.instagram.com/fiziotera.ufa/",          // Instagram клиники
  instagramDoctor: "https://www.instagram.com/dr.gorshechnikov/", // Instagram врача
  max: "https://max.ru/u/f9LHodD0cOJ5qM7mAcu-cj0ZwwqdU4QYS6IZzzRQHWl3sGrnLaILVVGCSmU",
  salavatAddress: "",
  salavatMap: ""
};

/*
 * Заявки с формы.
 *   endpoint  — серверная функция, которая сама отправляет заявку в WhatsApp/Telegram
 *               (api/lead.js, работает на Vercel). Ключи задаются в настройках Vercel, см. README.
 *   whatsapp  — номер, на который уйдёт заявка, если автоотправка не настроена или не сработала:
 *               тогда у пациента откроется WhatsApp с готовым текстом заявки.
 */
window.SITE_LEADS = {
  endpoint: "/api/lead",
  whatsapp: "79173816478"
};
