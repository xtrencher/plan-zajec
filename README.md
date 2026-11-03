# Plan zajęć ZZIBS1-2311

Aplikacja z odliczaniem do następnych zajęć. Plan aktualizuje się sam: co 5 minut GitHub Actions
pobiera kalendarz z Apollo2Calendar (UEK), zapisuje go w `site/data.json` i publikuje stronę na GitHub Pages.

- `site/` – aplikacja (index.html, data.json, ikony)
- `scripts/update.mjs` – pobieranie planu i wykrywanie zmian
- `config.json` – link do kalendarza UEK, Twoje lektoraty, temat powiadomień ntfy
- `.github/workflows/update.yml` – harmonogram co 5 minut

## Uruchomienie (jednorazowo)
1. Settings → Pages → Source: **GitHub Actions**.
2. Actions → „Aktualizacja planu” → **Run workflow**.
3. Strona: `https://<twoja-nazwa>.github.io/<nazwa-repo>/`

## Powiadomienia
Zainstaluj aplikację **ntfy** i zasubskrybuj temat z pola `ntfyTopic` w `config.json`.
