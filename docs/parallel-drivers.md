# Parallele Driver

Beobachtungen und Verweise für mehrere Agent-Driver, die gleichzeitig auf einem
Rechner arbeiten. Verbindlich bleibt
[AGENT_RULES.md](../AGENT_RULES.md); die [Driver-Regeln](#driver-regeln) am Ende
legen sie für Driver-Subagenten aus. Ein Briefing verweist darauf und nennt nur die
Besonderheiten des Issues.

**Ein Driver je Issue.** Jeder Driver arbeitet in einem eigenen Worktree auf der
eigenen Issue-Branch. Nur der Driver claimt und ändert den Status; Subagents
bekommen begrenzte Aufträge ([Delegation](CONTRIBUTING.md#starting-work)).

**Übergeben vor Starten.** Solange eigene Issues in „Automated review“ liegen, startet eine
Chief-Session keinen neuen Driver und kein neues Issue: zuerst dort Konflikte lösen, rote Checks
reparieren, Reviews abarbeiten und nach „Human review“ übergeben.

**Nachweis-Sperre.** Schwere lokale Nachweise (zum Beispiel Backend-E2E oder eine
Browser-Testsuite) stören sich gegenseitig, sobald mehrere gleichzeitig laufen. Ein Symptom ist die
Meldung „Could not find a valid Docker environment“ ohne echten Fehler im Test. Eine Sperre dafür
gehört ins Projekt, nicht ins Kit. Ein Projekt ohne eine solche Sperre spricht schwere Nachweise ab.

**Migrationsnummern.** Legen zwei Driver parallel Migrationen an, können die Nummern kollidieren.
Die Regel und ihre mechanische Prüfung gehören ins Projekt, nicht ins Kit.

**Merge-Vollmacht.** Agents mit Merge-Vollmacht mergen nur über `board.mjs merge PR` und
bauen kein eigenes Gate nach: der Befehl prüft CI, Reviews, Sonar und offene Threads, zieht bei
überschneidenden Änderungen die Basis nach, wartet erneut auf die CI und löscht danach den
Branch ([README](../README.md#board-commands), [#319](https://github.com/snagg-app/workflow-kit/issues/319)).
Einen ganzen Stapel gestapelter PRs mergt `board.mjs merge OBERSTE --stack` in einem Durchgang
(jede Ebene wird geprüft, nur der oberste Kopf braucht CI, [#389](https://github.com/snagg-app/workflow-kit/issues/389)).

**GitHub-Kontingent.** Das GraphQL-Kontingent (5.000 Punkte pro Stunde) gilt für das ganze
Konto und wird von allen Drivern gemeinsam verbraucht; ist es leer, scheitert jeder
`board.mjs`-Befehl bis zum Reset. Gemessene Kosten: eine Lesung von `wait`/`done` kostet
2 Punkte, `start` 1 (2 bei einem Issue, das nur offene Vorgänger hält), `next` 3 (4 bei einem Stapel-Kandidaten, je weitere 30 offene Issues 1 mehr). `wait` fragt zuerst nach 60 s, dann mit wachsendem Abstand bis
5 Minuten (bei Neuigkeiten wieder von vorn), also etwa 20 bis 40 Punkte pro Stunde und Driver
statt 120 bei festem Minutentakt. Als Budget gilt: Zahl der Driver mal 40 Punkte, dazu der eigene
Verbrauch der Agents; höchstens 20 parallele `wait` (rund 800 Punkte pro Stunde, ein Sechstel
des Kontingents). `wait` fragt GraphQL nur noch, wenn sich laut REST etwas geändert hat (Head, Checks,
Status, Aktualisierungszeit), spätestens alle 5 Minuten und zur Bestätigung jedes Endes; `wait PR --merged` liest nur REST
([#324](https://github.com/snagg-app/workflow-kit/issues/324)). `wait` und `done` melden den Rest in einer Zeile (`quota: …`).
`node scripts/quota-sample.mjs OUT.jsonl` misst den Verbrauch des ganzen Kontos: eine Stunde lang jede Minute `used` und `usedDelta` (die Abfrage kostet selbst einen Punkt pro Minute).
`done` schläft bei einer Sperre oder bei weniger als 50 Punkten bis zum Reset
(`rate limited until …`) und fragen danach weiter. `wait` schläft nicht: bei einer Sperre oder unter 300 Punkten liest es
PR und Checks weiter über REST (Zähler in der Zeile `waiting:`, ohne Urteil) und holt Threads und Urteil nach dem Reset;
bei `--max-minutes` endet es mit Exit 4 und der Reset-Zeit. Bei
einer kurzen Drosselung („secondary rate limit“) wartet `done` 1, 2, dann 4 Minuten statt bis zum
Reset. Alle anderen Befehle brechen mit der Zeit des nächsten Versuchs ab (Uhrzeit und Minuten bis dahin). Eigene Schleifen um `gh api graphql` sind deshalb nicht nötig.
Rest und Reset stammen aus den Headern `x-ratelimit-remaining` und `x-ratelimit-reset` der eigenen Antworten
(auch der abgewiesenen); zeigt eine Abweisung selbst freies Kontingent, fragt der Befehl sofort erneut,
statt auf eine Reset-Zeit zu warten. `gh api rate_limit` ist kein Beleg: es zeigte am 07.10.2026 für GraphQL einen
veralteten Wert. Wer die Zeit selbst braucht, fragt `gh api graphql -f query='query{rateLimit{remaining resetAt}}'`;
diese Abfrage antwortet auch bei leerem Kontingent.
Viele Issues auf einmal: `board.mjs new --from FILE` statt einer Schleife um `new`. Jede Abfrage und jede
Mutation kostet 1 Punkt, ein einzelnes `new` braucht 4 Anfragen (vorher 8 bis 9), die Sammel-Anlage 1 plus 3 je 5 Issues
(13 Issues: 10, [README](../README.md#board-commands)). Lesen Sie Issues und Kommentare über REST
(`gh api repos/OWNER/REPO/issues/N`): `gh issue view` und `gh pr view` fragen GraphQL.

**Review-Bots im Quota.** Ein Reviewer, auf den das Projekt nicht angewiesen ist
(CodeRabbit auf dem Free-Plan), steht als `"optionalReviewers"` in
`.github/workflow-project.json` ([SETUP](../SETUP.md#3-board-and-labels)). Für ihn gibt es
kein erneutes Anfordern, kein Warten und kein Ersatz-Review; `board.mjs` wartet nie auf
seine Spuren. Die Übergabe nennt ihn nur, wenn er etwas gefunden hat. Ist ein Pflicht-Reviewer
wegen Quota nicht verfügbar, gilt der Schritt „confirmed unavailable“ im
[Review loop](CONTRIBUTING.md#review-loop): Reviewer, Ursache und Beleg in der PR
festhalten und die Einschränkung im Übergabekommentar nennen.

**Eigene Scratch-Verzeichnisse.** Hilfsdateien (Kommentartexte, Skripte, Logs) liegen
je Issue in einem eigenen Verzeichnis, zum Beispiel im Session-Scratchpad oder neben
dem Klon in `<issue>-scratch/`, nie unter gemeinsamen Dateinamen.

**Worktree-Schutzprüfung von Claude Code.** Sie lehnt zusammengesetzte Shell-Befehle
ab, auch im Bypass-Modus: `$(…)` in Pipes, Schleifen mit `git` oder `gh`,
Inline-`node` oder `python`, Heredocs und Umleitungen auf Pfade außerhalb des
Worktrees, `cd … && git` sowie Variablen in `gh`-Pfaden. Stattdessen einfache
Einzelbefehle oder eine Skriptdatei im eigenen Scratch-Verzeichnis verwenden, statt
mehrfach zu probieren. Die Prüfung gehört zu Claude Code, nicht zum Kit; das Kit kann
sie nicht lockern (#849). Sie lehnt Inline-`node -e`/`-p` schon ab, wenn das Wort „git“
nur im Skripttext steht (`echo` und Dateiargumente sind davon nicht betroffen). Der
eine Weg, der funktioniert: das Skript mit dem Write-Werkzeug als Datei im Scratch
schreiben und `node <Datei>` ausführen. Dateien, Kommentartexte und PR-Bodies mit dem Write-Werkzeug
schreiben und per `--body-file` übergeben, nicht per Heredoc.

## Driver-Regeln

Allgemeine Regeln für jeden Driver-Subagenten. Projektspezifische Regeln und die
Modellwahl stehen hier nicht.

0. **Neuer Worktree: Kit zuerst.** Ein Worktree mit `isolation: worktree` startet ohne die Verknüpfung
   `.vendor/workflow-kit`, weil die Start-Hooks für das Projektverzeichnis der Eltern laufen. Fehlt sie,
   legt `node <gemeinsamer-Kit-Checkout>/scripts/kit-hook.mjs SessionStart --agent claude` sie an (mit
   `CLAUDE_PROJECT_DIR=<Worktree>`); dann AGENT_RULES.md lesen.
1. **Ein Issue bis „Human review“ treiben.** Früher enden nur bei einem menschlichen
   Gate (Merge, Secrets, Backlog→Ready, Produktentscheidung) oder bei einem Blocker
   (`board.mjs start` meldet BLOCKED oder UNKNOWN, eine Voraussetzung ändert sich;
   [Blockers and scope](CONTRIBUTING.md#blockers-and-scope)): erst im Issue
   kommentieren, dann berichten. „Human review“ heißt mergebar: Meldet `board.mjs sweep` danach
   einen Konflikt (Issue zurück auf „Automated review“, Kommentar), löst der Owner ihn und ruft `done` erneut auf.
2. **Regeln vom Ziel-Release-Branch lesen.** AGENTS.md und Kit-Regeln stammen vom
   Release-Branch, auf den die PR zielt, nicht nur von `main`; eine Regel kann nur
   dort stehen. Danach [Start or resume](../AGENT_RULES.md#start-or-resume):
   `board.mjs start ISSUE --session ID` öffnet den Entwurfs-PR mit `Agent: …, Session: …` und zweigt den
   Issue-Branch vom Ziel-Release-Branch ab (die Basis nennt das Projektfeld, nicht `main`). Bei
   STACKABLE ist es der Branch des Basis-PR
   ([Stacked pull requests](CONTRIBUTING.md#stacked-pull-requests)). Er bleibt ein fremder
   Branch (Regel 3): der Driver zweigt davon ab und liest ihn, pusht ihn aber nie.
3. **Fremde Branches in Ruhe lassen.** `codex/*`-Branches und Branches anderer
   Driver nicht anfassen, auch wenn der eigene Branch `codex/*` heißt; nur der eigene
   Issue-Branch gehört dem Driver. Überschneidungen melden.
4. **Warten ohne Handarbeit.** Abweichend von [AGENT_RULES.md](../AGENT_RULES.md#economy)
   und [Review loop](CONTRIBUTING.md#review-loop) Schritt 3 gilt für Driver-Subagenten:
   `board.mjs done` (oder `wait PR`) im Vordergrund ausführen, weil ein Subagent erst am Ende seines
   Zuges von Hintergrundaufgaben erfährt. `done` und `wait` enden nach 9 Minuten von selbst (`--max-minutes N`,
   0 = unbegrenzt) mit Exit-Code 4 und der Zeile `still waiting: call … again`, damit das
   Bash-Werkzeug es nicht nach 10 Minuten in den Hintergrund schiebt: bei Exit 4 einfach erneut
   aufrufen. Jeder Vordergrund-Aufruf von `done`, `wait`, `merge` und `quota-wait` setzt den Timeout des
   Shell-Werkzeugs auf 600000 ms (Standard: 2 Minuten, dann Hintergrund); `--max-minutes` bleibt bei höchstens 9. Nach DONE nicht auf einen Reviewer
   ohne Spur pollen (ein Review, das nie startet) und keinen Review von Hand anfordern
   (kein `@codex review`); fehlt die Spur, nennt der Übergabe-Kommentar das
   ([Review loop](CONTRIBUTING.md#review-loop) Schritt 3). Freitext-Ankündigungen anderer Bots
   erkennt `wait` nicht ([README](../README.md#board-commands)); eine angekündigte
   Review verfolgt der Driver von Hand bis zum Ergebnis oder Stall und führt
   `done` erst danach aus. Review-Subagenten ebenfalls im Vordergrund starten;
   `tasks/*.output` nicht pollen, die Datei bleibt leer.
5. **Shell und Werkzeuge.** Ein einfacher Befehl pro Bash-Aufruf, vom Worktree-Root aus,
   mit literalen Pfaden; Details im Absatz zur Worktree-Schutzprüfung oben.
   - Tests: lokal nur die betroffenen (`--test-name-pattern` oder eine Testdatei), die
     ganze Suite läuft in der CI. Die Testdateien zu den geänderten Dateien nennt
     `node scripts/affected-tests.mjs` (im Kit; ein Projekt ergänzt eigene Befehle in `.github/affected-tests.json`, [README](../README.md#project-test-map)); mit `--run` startet er sie auch. Führt die Projekt-CI sie für diesen Head nicht aus,
     läuft sie einmal vor der Übergabe im Hintergrund mit Logdatei; der Driver wartet auf deren
     Benachrichtigung oder beendet den Lauf, bevor er berichtet (ein verwaister Lauf hält die
     Prüf-Warteschlange für alle). Das Kit fährt sie in
     seiner CI, Kit-Driver testen lokal nur gezielt.
   - Dateien: mit Edit und Write oder mit einem Node-Skript aus einer Datei ändern;
     Heredoc, Python und sed verlieren Backslashes.
   - Scratch-Dateien (PR-Texte, Kommentare, Hilfsskripte) nur in `.scratch/` des Worktrees
     (von Git ignoriert) oder im Scratchpad der Session, nie im Repo-Baum. Stagen:
     nur die Pfade des Issues, nicht `git add -A`.
   - Suchen: auf Pfade eingrenzen oder erst mit `-l` die Dateien finden.
   - Ziel-Stand: Suchen und Lesen laufen gegen den Stand des Ziel-Branches, bei abweichendem
     Checkout mit `git grep … origin/<Ziel-Branch>`.
   - Jeder eigene Subagent (Suche, Explore, die Review-Agenten von `code-review`) im Vordergrund
     (`run_in_background: false`): ein Hintergrund-Ergebnis landet bei der Eltern-Session,
     nicht beim Driver. Hintergrund nur für lange Prüfläufe mit eigener Benachrichtigung.
   - Warten: auf die Benachrichtigung der eigenen Hintergrundaufgabe; Prozessnamen
     (`node.exe`) gehören auch anderen Drivern.
   - Keine eigenen Schleifen um `gh`: `gh api graphql` meldet die Kontingentsperre als Text und kann mit Exit 0 enden
     (Driver #1095 wartete so 9 Minuten umsonst). Warten mit `board.mjs wait` oder `board.mjs quota-wait`
     ([#324](https://github.com/snagg-app/workflow-kit/issues/324)).
   - GitHub lesen mit `gh api repos/…` (REST, kostet kein GraphQL-Kontingent) statt `gh pr view|checks|list`
     und `gh issue view|list` (GraphQL); Status und Felder schreibt weiter `board.mjs`.
   - Kommentare eines Issues: `gh api repos/OWNER/REPO/issues/N/comments`.
   - Kit-Befehle in einem fremden Klon: `board.mjs --cwd KLON-PFAD start N` (die Option steht vor
     dem Befehl) liest `.github/workflow-project.json` aus dem Klon statt aus dem Arbeitsverzeichnis.
     `init-project.mjs`, `setup-skills.mjs` und `affected-tests.mjs` nehmen dieselbe Option als erstes
     Argument (`affected-tests.mjs --cwd KLON-PFAD --run`) und arbeiten dann im Klon.
     Ohne sie bestimmt das Arbeitsverzeichnis das Projekt, und ein Status oder Kommentar kann im
     falschen Issue landen; ein `cd … &&` ist dafür nicht nötig.
   - Worktree: der Driver arbeitet im eigenen Worktree, nie in dem der Eltern-Session;
     hat er keinen, legt er ihn als Erstes an. Scratch-Dateien tragen die Issue-Nummer.
   - Kit-Stand: Alle Worktrees teilen einen Kit-Checkout auf `main`, der bei jedem Sessionstart
     nachzieht; ein Pin gibt es nicht mehr. Kit-Treiber arbeiten in einem eigenen Worktree des
     Kit-Repos, nie im gemeinsamen Checkout.
5a. **Selbstprüfung vor Ready.** Nennt das Projekt `"selfReview"` in `.github/workflow-project.json`
   (zum Beispiel `ponytail-review` und `code-review`), laufen diese Prüfungen einmal je PR im
   Vordergrund vor „Ready for Review“, und der PR-Text hat den Abschnitt `## Selbstprüfung` mit jedem Namen
   und dem Ergebnis; Ergebnisse nennen Belege und unterscheiden geprüftes Verhalten von Mocks und Konfiguration.
   `board.mjs done` und `merge` prüfen Abschnitt und Namen, nicht Ergebnis oder Qualität
   ([Review loop](CONTRIBUTING.md#review-loop) Schritt 1).
6. **Reibung statt Retro-Skill.** Driver rufen den Skill `retro` nicht auf; er kostet
   zu viele Tokens pro Issue. Sie schreiben höchstens 3 Reibungszeilen aus der eigenen
   Session (Fehlversuche, Wartezeiten, Ablehnungen) in den `Retro`-Abschnitt der
   Übergabe, jede mit Auflösung wie in [Review loop](CONTRIBUTING.md#review-loop)
   Schritt 5, und wiederholen sie im Abschlussbericht. Die Retro mit dem Skill macht
   die Eltern-Session gesammelt über ihre Driver.
7. **Abschlussbericht** mit höchstens 12 Zeilen: PR, zurückgelesener Status,
   Folge-Issues, Überschneidungen, Reibung.
