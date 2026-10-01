# Центр здоровья (Салават) — сайт

Одностраничный сайт Центра здоровья в Салавате: акция «бесплатная консультация и процедура»,
услуги и цены, с чем помогаем, о центре, контакты и форма заявки.

Прошлая версия (Салават + Уфа на одном сайте) сохранена в ветке `archive/salavat-ufa`.

Чистый HTML/CSS/JS без сборки + одна серверная функция для заявок (`api/lead.js`).

## Структура

```
index.html            — вся страница
assets/css/style.css  — стили (белый + индиго, акцент — коралловый для акции)
assets/js/config.js   — КОНТАКТЫ и настройки заявок
assets/js/main.js     — интро, меню, фильтр услуг, окна записи и Instagram, отправка формы
assets/img/           — фото (hero, promo, svc-*, case-*, center-salavat)
assets/video/laser.mp4 — видео лазерной процедуры (карточка «Здоровые суставы»)
api/lead.js           — приём заявок → WhatsApp (GREEN-API) и/или Telegram
```

## Контакты

`assets/js/config.js`. Пустое поле — кнопка помечается «скоро» и никуда не ведёт.
Не заполнены: `salavatAddress`, `salavatMap`.
Instagram на сайте — одна кнопка; при нажатии пациент выбирает «Клиника» (`instagram`) или «Врач» (`instagramDoctor`).

## Заявки

Форма есть в блоке акции и в окне «Записаться».

**Без настройки** (или на GitHub Pages) — у пациента открывается WhatsApp с готовым текстом заявки
на номер `SITE_LEADS.whatsapp`, ему остаётся нажать «Отправить».

**Автоотправка** (сайт на Vercel): Vercel → Project → Settings → Environment Variables, затем Redeploy.

WhatsApp через [GREEN-API](https://green-api.com):
1. Зарегистрироваться, создать инстанс, отсканировать QR телефоном, с которого будут уходить заявки
   (лучше отдельный номер, не тот, на который они приходят).
2. Добавить переменные:
   - `GREEN_API_ID` — idInstance
   - `GREEN_API_TOKEN` — apiTokenInstance
   - `GREEN_API_URL` — apiUrl из кабинета (если отличается от https://api.green-api.com)
   - `WHATSAPP_TO` — куда присылать заявки, только цифры, напр. `79173816478`

Telegram (можно вместе с WhatsApp — заявка уйдёт в оба):
1. Создать бота у @BotFather → токен.
2. Написать боту любое сообщение, открыть `https://api.telegram.org/bot<ТОКЕН>/getUpdates` → взять `chat.id`.
3. Переменные `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`.

Если автоотправка не сработала, пациенту всё равно предлагается отправить заявку через WhatsApp.

## Локальный просмотр

```
python3 -m http.server 8000
```
и откройте http://localhost:8000 (форма будет работать в режиме «через WhatsApp»).

## Публикация

- **Vercel** (нужен для автоотправки заявок): New Project → импорт репозитория → Framework: *Other*, без команды сборки → Deploy.
- **GitHub Pages**: Settings → Pages → Deploy from branch → `main` / root (заявки — только через WhatsApp пациента).
