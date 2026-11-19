# Mapa ticketów

Lokalna strona, która dla każdego niewydanego ticketu przypisanego do mnie w Notion pokazuje
jego gałęzie i merge requesty we wszystkich repozytoriach: z czego gałąź wyszła, w co celuje jej
MR i w co powinien celować (najnowszy otwarty RC). Druga zakładka pokazuje gałęzie
`release-candidate/*`: czy nowszy RC zawiera starszy, czy RC zawiera `main` i czy `main` ma już
to, co RC.

## Uruchomienie

```bash
npm start          # http://localhost:4455, otwiera przeglądarkę
npm test
```

Wymaga Node 20+, zalogowanego `glab` oraz CLI `claude` z podpiętym MCP Notion. Serwer słucha
tylko na `127.0.0.1`.

Flagi: `--no-open` (bez otwierania przeglądarki), `--no-notion` (Notion tylko po kliknięciu
„Odśwież z Notion”). Port: `PORT=4456 npm start`.

## Skąd są dane

| Co | Skąd | Jak często |
| --- | --- | --- |
| Tickety (numer, tytuł, status, osoby, wersja wydania, zadania nadrzędne i podzadania) | Notion, zapisany widok „Moje otwarte tickety” na prywatnej stronie | co 15 min, gdy strona jest otwarta |
| Merge requesty, gałęzie, tagi, wdrożenia STG/preprod/UAT | GitLab przez `glab api`, wyłącznie odczyt | pełny odczyt co 2 min; zmiana w MR-ze jest wykrywana w ok. 15 s |
| Niewypchnięte gałęzie testów | lokalny checkout `internal-qa-automation`, bez `fetch` | przy każdym odczycie |

Notion jest dostępny tylko przez MCP z logowaniem OAuth, więc serwer uruchamia `claude -p` jako
kuriera: podaje mu dokładne wywołania narzędzi, a wiersze czyta z surowych wyników w strumieniu.
Wywołanie z innymi argumentami niż zadane jest odrzucane. Sesja kuriera jest odcięta od ustawień
użytkownika, skilli i wbudowanych narzędzi.

Widok zamiast zwykłego zapytania, bo zapytania `rows`/`sql` mają w Notion limit ok. 10 na godzinę
na cały workspace, a odczyt zapisanego widoku limitu nie ma. Bez `notion.viewUrl` narzędzie wraca
do zapytania z limitem.

## Jak czytać mapę

- Wiersz to repozytorium. Po lewej gałęzie ticketu, po prawej miejsca docelowe: otwarte RC,
  gałąź domyślna, a w repozytorium testów ewentualny `rc-next`.
- Niebieska linia: MR celuje w tę gałąź. Zielona przerywana: tu powinien celować. Pomarańczowa
  albo czerwona: cel do poprawy (starszy RC, RC już wydany, gałąź usunięta).
- W polu gałęzi: `z main +2 −7` znaczy, że gałąź wyszła z `main`, ma 2 własne commity i jest
  7 commitów w plecy. Pochodzenie to gałąź, względem której własnych commitów jest najmniej.
- Gałąź, której MR celuje w inną gałąź tego samego ticketu, stoi pod nią z wcięciem.
- Kliknięcie gałęzi pokazuje szczegóły, w tym odległość od każdej gałęzi docelowej.

Merge request należy do ticketu, gdy numer ticketu jest w nazwie gałęzi, w tytule albo w linii
`Ticket:` / `Notion:` opisu. Podzadanie bez własnych gałęzi pokazuje gałęzie ticketu nadrzędnego,
zawężone do swojego produktu.

## Zakładka „Wydania i RC”

Łańcuch każdego repozytorium: gałąź domyślna, potem otwarte RC od najstarszego. Etykieta na
strzałce mówi, czy gałąź po prawej zawiera wszystko z tej po lewej. Commit, który gałąź ma pod
innym SHA (ten sam autor i tytuł, czyli ślad po rebase), nie liczy się jako brak, tylko jako
kopia do rebase'u. Pod nazwą RC: ile commitów nie ma jeszcze w gałęzi domyślnej.

Otwarty RC to taki, którego wersja jest wyższa niż najwyższy tag produktu i którego to
repozytorium jeszcze nie scaliło. To ta sama reguła, której używa `release-sync-train`.

## Konfiguracja

`config.json`:

- `gitlab.products`: zapasowa lista repozytoriów produktów; na co dzień czytana z
  `release-train.json` w `release-sync-train`.
- `gitlab.libraries`: biblioteki przypisane do produktu, żeby trafiały do jego grupy.
- `gitlab.qa`: repozytorium testów, ścieżka lokalnego checkoutu, wzorzec gałęzi zbiorczej.
- `gitlab.maxAgeSeconds`, `gitlab.changeCheckSeconds`: odstępy pełnego odczytu i sprawdzania zmian.
- `notion.viewUrl`: widok z ticketami; `notion.maxAgeMinutes`: jak często go czytać.
- `tickets.aliases`: dawne numery ticketu, np. `{ "1209": [1116] }`, gdy gałęzie noszą stary numer.

Katalog `data/` to stan roboczy (ostatnie tickety z Notion i pamięć podręczna porównań). Można
go usunąć; pierwszy odczyt po tym trwa dłużej.

## Ograniczenia

- MR bez numeru ticketu w tytule i opisie jest znajdowany po nazwie gałęzi tylko wtedy, gdy był
  zmieniany w ciągu ostatnich 120 dni i leży w repozytorium produktu albo testów.
- Odległości między gałęziami są liczone do 100 commitów; powyżej widać `100+`.
- Bezpośredni push do gałęzi bez MR-a (np. rebase RC) jest widoczny dopiero po pełnym odczycie.
