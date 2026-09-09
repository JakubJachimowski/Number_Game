# Ten's Ledger — Expo

Gra liczbowa w klimacie księgi rachunkowej (jak Number Match): zaznaczasz pary liczb równych albo
sumujących się do 10, aż wyczyścisz całą planszę.

## Uruchomienie (tymczasowo, przez Expo Go)

Wymagany Node.js (18+) i telefon z zainstalowaną aplikacją **Expo Go** (Android/iOS) w tej samej
sieci Wi-Fi co komputer.

```bash
cd ten-ledger-app
npm install
npx expo install --fix   # dopasowuje wersje pakietów do zainstalowanego SDK Expo
npx expo start
```

Po uruchomieniu w terminalu pojawi się kod QR — zeskanuj go aplikacją Expo Go (Android) lub aparatem
(iOS), a gra otworzy się na telefonie. To jest tryb deweloperski — nic nie trzeba budować ani
publikować w sklepie, żeby zagrać.

Jeśli wolisz emulator Androida zamiast telefonu: uruchom Android Studio z gotowym emulatorem, a
potem w terminalu z `expo start` naciśnij `a`.

## Budowa właściwego pliku APK/AAB (na później)

Gdy będziesz gotowy na build instalowalny bez Expo Go:

```bash
npx eas build -p android --profile preview
```

Wymaga darmowego konta na expo.dev i `npx eas login` (EAS Build buduje w chmurze Expo, więc nie
potrzebujesz lokalnie Android Studio ani zainstalowanego SDK Androida).

## Struktura projektu

- `App.js` — cała logika gry i UI (jeden ekran, bez nawigacji).
- `app.json` — konfiguracja Expo (nazwa, identyfikator pakietu Androida).
- `package.json` — zależności (Expo SDK 51, React Native 0.74).

## Zasady gry

- Wybierz dwie liczby, które są **równe** albo **sumują się do 10**.
- Muszą sąsiadować (również po przekątnej) albo być połączone linią, w której wszystkie liczby
  pomiędzy nimi są już skreślone (z zawijaniem do kolejnej linii planszy).
- **Dołóż pozostałe liczby** — gdy utkniesz, dokłada nieskreślone liczby jako nowe wiersze na dole.
- **Podpowiedź** — podświetla dostępną parę do skreślenia.
- Punktacja: +2 za parę sąsiednią, +4 za parę odległą, +10 za w pełni skreślony wiersz, +150 za
  wyczyszczenie całej planszy.
