# RU ⇄ HI Переводчик v1.1 (вшитый ключ + работа без VPN + фикс клавиатуры)

## 1. Как вшить свой API-ключ прямо в APK (безопасно)
1. На GitHub откройте **Settings → Secrets and variables → Actions → New repository secret**.
2. Создайте секрет:
   - **Name:** `GEMINI_API_KEY`
   - **Secret:** ваш ключ из Google AI Studio (`AIza...`)
3. Загрузите обновлённые файлы из этого архива в репозиторий (включая `.github/workflows/build-android.yml`).
4. После сборки `.apk` ключ уже будет внутри приложения — вводить его на телефоне не придётся.

## 2. Как сделать работу БЕЗ VPN из любой страны (включая Россию)
1. Зайдите на бесплатный [Cloudflare Workers](https://dash.cloudflare.com/) → **Workers & Pages → Create → Create Worker**.
2. Вставьте код из файла `cloudflare-worker/worker.js` и нажмите **Deploy**.
3. (Рекомендуется) В настройках воркера (**Settings → Variables and Secrets**) добавьте `GEMINI_API_KEY` — тогда ключ будет храниться на сервере Cloudflare.
4. Скопируйте адрес вашего воркера (вида `https://ru-hi-proxy.ваш-ник.workers.dev`) и добавьте его в GitHub Secrets под именем `API_BASE_URL` (или просто вставьте в поле «Прокси URL» в настройках приложения).
5. Перезапустите **Build Android APK** во вкладке **Actions** — новый `.apk` будет работать везде без VPN и без ввода ключа.
