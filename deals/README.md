# SKNews Deals – geprüfter Zwischenstand

Stand der Untersuchung: 19.11.2026, Europe/Berlin. Keine geheimen Werte in diesem Paket.

## Bestehender Aufbau

- Die hochgeladene `sknews-bot-compose.yml` lädt beim Start nur `bot.py`, `memory.py` und `requirements.txt` aus GitHub. Sie ist älter als das heutige System. Selbst das vorhandene `heim.py` würde diese Datei nicht laden.
- `scottyblue77/sknews`: statisches Dashboard in `docs/`, Sammler per GitHub Actions, Veröffentlichung durch Wrangler auf Cloudflare Pages unter `news.skzone.de`. Die News werden nach 14 Tagen aus den öffentlichen JSON-Daten entfernt. Diese Datenhaltung eignet sich nicht als langfristiges Preisarchiv.
- Backup-Ordner: Architektur-Dashboard, HA-Monitoring, n8n-Wächter, HA-Sicherungen. HA läuft auf `192.168.1.17:8123`, n8n auf `:5678`, Loki auf `:3100`, Ollama auf `192.168.1.50:11434`. Backup-Dateien wurden nur aufgelistet; kein HA-Archiv vollständig entpackt oder wiederhergestellt.
- Tatsächlich läuft auf dem NAS `sk-bot`, Image `sk-ki-os:v0.4.4`, mit `/DATA/AppData/sk-ki-os/data:/data`. Der alte SKNews-Bot läuft nicht. Die Anwendung enthält bereits News-Synchronisierung und einen Melder mit Ruhezeiten, Push-Budget, Sammelmeldungen und Deduplizierung.
- Im aktuellen öffentlichen SKNews-Repository, allen neun vorhandenen Zweigen und der geladenen Historie wurde kein bisheriges Deals-Modul gefunden. Auch die Python-Module des aktiven Bots enthalten keine Treffer für die Preisportale.

## Umsetzung

`docs/deals.html` und `docs/deals.js` werden Teil der vorhandenen SKNews-Seite, mit einem Eintrag im gemeinsamen Menü. Die Watchlist liegt in `config/deals.json`. Bearbeitung verwendet dieselben GitHub-Einstellungen und denselben Konfliktschutz per Dateiversion wie die News-Seite. Ein paralleler Schreibzugriff wird abgelehnt statt überschrieben.

Preisbeobachtung läuft getrennt auf dem NAS: `worker.py` liest die Watchlist, ruft Quellen ab, schreibt eine dauerhafte SQLite-Datenbank und erzeugt den Snapshot für die Website sowie einen lokalen Ereignis-Feed. Kein zusätzlicher Webport ist erforderlich. Das Preismodul benötigt kein Sprachmodell und keine Anthropic-Schlüssel. Nach erfolgreicher Konfiguration kann der Worker den Snapshot mit einem eigenen GitHub-Schlüssel veröffentlichen. Der vorhandene GitHub-Workflow bleibt unverändert und veröffentlicht den jeweils aktuellen Deals-Snapshot beim nächsten regulären News-Lauf. Ein Snapshot-Commit allein startet noch keinen zusätzlichen Deploy.

`integration/skbot_deals.py` passt zum heutigen SK-KI-OS und gibt Ereignisse an dessen vorhandenen Melder weiter. Kein zweiter Telegram-Long-Poller und kein zweiter Telegram-Bot nötig. Der Adapter zieht noch wartende Meldungen zurück, wenn der lokale Feed veraltet ist oder ein Angebot aus dem Feed verschwindet. Eine vollständige erneute Händlerprüfung beim tatsächlichen Versand ist noch nicht implementiert; es bleibt das Abrufintervall als Unsicherheitsfenster.

## Preisregeln und Grenzen

- Endpreis = Artikelpreis einschließlich MwSt. + explizit bekannte DE-Versandkosten, in ganzen Cent. Keine stillschweigende Annahme „versandkostenfrei“.
- Nur exakt passende GTIN, EUR, Neuware und bekannte Verfügbarkeit. Andere Modellvarianten bleiben getrennt. Der erste Eintrag ist der Samsung Odyssey Neo G9 G95NC 57 Zoll, LS57CG954NUXEN, GTIN 8806094972313. Die Variante LS57CG952NUXEN wird nicht mitgemischt, auch wenn ein Portal beide unter einer Produktseite gruppiert.
- Konfigurierbar: Zielpreis, Prozent unter dem Median der Tagesbestpreise aus den letzten 30 Tagen, neuer beobachteter Bestpreis, UND/ODER, Mindestzahl beobachteter Tage, Push-Abstand, Pause.
- 30-/90-/365-Tage-Tief und gesamter beobachteter Tiefstpreis; die Rohbeobachtungen werden nicht nach 14 Tagen gelöscht. Ein beobachteter Jahrestiefpreis bedeutet nicht, dass bereits ein volles Jahr abgedeckt ist. Die Anzahl gemessener Tage wird angezeigt.
- Viele Abrufe an einem Tag zählen als ein Historientag. Fehlende Tage werden nicht aufgefüllt. Frische Angebote verfallen nach sechs Stunden.
- Alarme werden dauerhaft gespeichert; Neustarts erzeugen keine Wiederholung desselben Preises. Ein erneut schlechterer Preis muss um mindestens 3 % steigen, um die gleiche Preisstufe wieder scharfzuschalten; weitere Preisverbesserungen ab 1 % können nach dem Push-Abstand einen neuen Alarm auslösen.
- Black Friday, Black Week oder „MwSt. geschenkt“ sind keine Rabattbelege. Eine 19-%-MwSt.-Aktion kann rechnerisch 19/119 ≈ 15,97 % vom ursprünglichen Bruttopreis bedeuten. Entscheidend bleibt der bestätigte Endpreis, nicht die Werbe-Prozentzahl. Bedingte Gutscheine, Mitgliedschaften, Cashback, Bundles und Ratenkäufe werden noch nicht automatisch auf Anwendbarkeit geprüft und dürfen von späteren Adaptern nicht als bedingungsloser Endpreis übernommen werden.
- Die Datenbank beginnt mit eigenen Beobachtungen. Es wurde keine bestehende Jahreskurve von einem Portal importiert. `import_prices.py --historical` ist die vorbereitete Schnittstelle für normalisierte, freigegebene Historienexporte und erzeugt absichtlich keine Pushs.

## Echte Portaltests

Produktseiten des Samsung-Monitors wurden vom Mac und vom NAS geprüft. Ergebnis:

| Quelle | Ergebnis am NAS | Stand |
|---|---|---|
| idealo | HTTP 403 im Abrufpfad | Kein funktionierender Live-Adapter bestätigt |
| billiger.de | HTTP 403 im Abrufpfad | Partner-API/Export-Zugang erforderlich |
| guenstiger.de | HTTP 403 im Abrufpfad | Kein funktionierender Live-Adapter bestätigt |
| Geizhals | HTML abrufbar, keine vollständig passenden JSON-LD-Angebote | Produktspezifischer oder freigegebener Partner-Adapter erforderlich |

Der mitgelieferte JSON-LD-Adapter ist ein konservativer erster Importweg, keine zugesicherte Integration aller vier Portale. Er respektiert robots.txt, folgt keinen unbekannten Weiterleitungen und umgeht keine Zugriffssperren. Fehlende Händler-/Versand-/GTIN-Daten führen zu einem sichtbaren Quellenfehler und niemals zu einem geschätzten Angebot. Offizielle Partner-API-Endpunkte, Berechtigungen und Antwortformate sind nicht erfunden oder voreingestellt.

Billiger.de beschreibt offiziell Datenzugang per API, Export und Widget für freigeschaltete Publisher: https://www.solutions.billiger.de/de/partnerprogramm/ . Geizhals stellt Kooperationsmöglichkeiten unter https://unternehmen.geizhals.at/haendler/kooperationen/ bereit. Für idealo und guenstiger.de wurde keine frei nutzbare Verbraucher-Preisverlaufs-API bestätigt. Händler-Upload-Schnittstellen sind kein Nachweis für einen lesenden Preiszugang.

Samsung-Modell/GTIN: https://www.samsung.com/de/business/monitors/gaming/odyssey-neo-g9-g95nc-57-inch-240hz-curved-dual-uhd-ls57cg954nuxen/

## Noch benötigte Zugriffe und Schritte

1. Einen tatsächlich nutzbaren Preiszugang festlegen: bestehender Partner-API-/Export-Zugang und Dokumentation, zunächst idealerweise billiger.de/solute. Ein Widget allein liefert dem Hintergrundsammler keine auswertbare Historie. Die vier Portal-Links sind bereits in der Watchlist vorbereitet.
2. Für dauerhafte Veröffentlichung einen eigenen Fine-grained GitHub-Token nur für `scottyblue77/sknews` mit Contents Read/Write konfigurieren (`DEALS_GITHUB_TOKEN`). Im aktiven SK-Bot waren weder `GITHUB_TOKEN` noch `SKNEWS_TOKEN` gesetzt. Es wurden nur Vorhandenseinsprüfungen ausgeführt; keine Schlüsselwerte ausgegeben oder kopiert. Der Browser kann weiterhin die bereits vorhandene GitHub-Synchronisierung verwenden.
3. Auf dem NAS ein Verzeichnis `/DATA/AppData/sknews-deals` für UID/GID 1000 schreibbar anlegen; tatsächliche NAS-UID vorher prüfen. `.env.example` nach `.env` kopieren, Schlüssel dort mit Dateirecht 600 speichern. `.env` bleibt außerhalb von Git. `DEALS_PUBLISH=true` veröffentlicht Watchlist-/Preisdaten im öffentlichen Repository. Die bestehende SKNews-Architektur ist öffentlich; sie bietet damit keine private Watchlist.
4. `docker compose -f compose.yml up -d --build` startet den getrennten Worker. Er hat keine Ports, keine Docker-Socket-Einbindung und keinen Zugriff auf andere App-Daten. Die bisherige `sknews-bot-compose.yml` nicht anstelle des aktuellen SK-Bots starten.
5. Im SK-KI-OS-Projekt `integration/skbot_deals.py` als `app/deals.py` aufnehmen und `git apply --unidiff-zero integration/planer.patch` auf den geprüften v0.4.4-Stand anwenden. Dem SK-Bot `/DATA/AppData/sknews-deals:/deals:ro` hinzufügen und `DEALS_FEED_PATH=/deals/feed.json` setzen. Änderung im Quellprojekt mit neuem Image bauen, nicht bloß den laufenden Container verändern. Der Adapter läuft vor dem Melder, damit abgelaufene Angebote zurückgezogen werden können. Änderungen an späteren SK-KI-OS-Versionen erneut abgleichen.
6. Erst nach erfolgreichem echten Preisabruf einen kontrollierten Preisalarm an den vorhandenen Telegram-Kanal testen. Es wurde kein Test-Push an dich gesendet, der aktuelle Bot wurde nicht neu gestartet oder verändert.
7. SQLite über die SQLite-Backup-Funktion sichern, nicht nur die laufende `.db` ohne WAL kopieren. Das neue Verzeichnis muss in das bestehende NAS-/Synology-Backup aufgenommen werden. Die vorhandene Bot-Sicherung sichert diese separate Datenbank nicht automatisch.

Optional lässt sich die veröffentlichte Deals-Seite als Webseitenkarte im Home-Assistant-Dashboard einbetten. Home Assistant wird nicht zur Langzeit-Preisdatenbank; Telegram bleibt der nachgewiesene vorhandene Push-Kanal. Ein HA-Mobile-App-Notify-Ziel ist in den geprüften Monitoring-Dateien nur als auskommentierter Platzhalter vorhanden und wurde nicht als aktiver Kanal angenommen.

## Verifikation

`python3 -m unittest discover -s tests -v` prüft zehn Szenarien: Endpreis inklusive Versand, historische Baseline, neue Tiefpreise, Tagesgewichtung, Neustart/Deduplizierung/Push-Abstand, Varianten-/Währungs-/Zeitvalidierung, Verfügbarkeit, atomarer Import, strukturierte Angebotsdaten, Worker-Snapshot/Feed und Übergabe an den Bot-Melder einschließlich Rücknahme bei veraltetem Feed. Keine echte Nachricht wird versendet.

Die Website wurde mit isoliertem Chrome auf 1440px und 390px geprüft: Menü, Produktbearbeitung, unveränderliche GTIN, neues Produkt, keine Browserfehler und kein horizontaler Überlauf. Die Tests mit Beispieldaten bestätigen die Logik, ersetzen aber keine noch ausstehende Portal-Ende-zu-Ende-Prüfung oder einen echten Push-Test.

Die Hauptdomain `skzone.de`, Hostinger-Hosting, DNS und Abonnements sind von dieser Erweiterung unabhängig.
