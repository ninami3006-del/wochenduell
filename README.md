# Wochenduell

Fitness-Challenge unter Freunden: Punkte für Schritte, verbrannte Kalorien, Workouts und das eigene Kalorienziel. Jede Woche gibt es einen Sieger.

Live: https://ninami3006-del.github.io/wochenduell/ (auf dem iPhone über Safari → Teilen → „Zum Home-Bildschirm“ als App ablegen)

## Aufbau

- `docs/` ist die Web-App, die GitHub Pages ausliefert: `index.html`, `styles.css`, `app.js` (Logik), `i18n.js` (Deutsch und Englisch), `config.js` (öffentliche Supabase-Adresse und Anon-Key).
- `supabase/migrations/` enthält die Datenbank: Profile, Gruppen mit Einladungscode, Tageswerte, Workouts und „Respekt“, jeweils mit Row Level Security. Alle sehen nur die Leute aus ihrer eigenen Gruppe.
- `supabase/tests/rls_check.sql` prüft die Zugriffsregeln mit Wegwerf-Nutzern und macht danach alles rückgängig. Erwartetes Ergebnis: `ALL_TESTS_PASSED`.
- `supabase/config.toml` enthält nur die Anmelde-Einstellungen, die per `supabase config push` gesetzt werden.
- `wochenduell.html` ist der ursprüngliche klickbare Prototyp.

## Punkte

Schritte 1 Punkt pro 1.000 (max. 25), aktive Kalorien 1 Punkt pro 50 kcal (max. 20), Workouts 10 Punkte ab 20 Minuten und 15 ab 45 Minuten (max. 2 pro Tag), Ess-Ziel 10 Punkte bei höchstens 10 % Abweichung und 5 bei 20 %.

## Noch offen

- Apple Health automatisch per iPhone-Kurzbefehl
- Whoop-Anbindung
- Passwort zurücksetzen per E-Mail (braucht einen eigenen Mail-Dienst)
