# Changelog

## Unveröffentlicht

- **Das Projekt-Profil wird an einer Stelle gelesen und geprüft (#756).** `readProfile` und `readProfileAt` (`scripts/project-profile.mjs`) prüfen jedes bekannte Feld einmal und liefern Standardwerte; alle Skripte nutzen sie. Eine kaputte Datei bricht überall mit derselben Meldung ab (Datei und Feld genannt); auch ein falscher Wert in `staleHours` oder `reviewerGraceMinutes` stoppt jetzt jeden `board.mjs`-Befehl, nicht nur die betroffenen. Die UI-Erkennung für `"impeccable": "auto"` merkt sich ihr Ergebnis je Commit (höchstens eine Stunde) im Git-Verzeichnis.

- **Hooks und Downloads nur, wo ein Projekt sie braucht (#693).** Das Profil `.github/workflow-project.json` kennt die Schalter `"impeccable"` (`true`, `false` oder `"auto"`, Standard) und `"ponytail"` (`true`, Standard, oder `false`). Bei `"auto"` zählt ein Projekt mit UI-Dateien (`.tsx`, `.jsx`, `.vue`, `.svelte`, `.astro` oder ein UI-Framework in einer `package.json`) als UI-Projekt; Projekte mit UI ändern sich nicht. Ein Projekt ohne UI bekommt keinen Impeccable-Hook (kein Lauf bei jedem Edit und beim Stop) und lädt das 19-MB-Programm nicht herunter; ein vorhandener Eintrag verschwindet beim nächsten `init-project` oder `kit setup`. Falsche Erkennung: `"impeccable": true` oder `false` eintragen.

- **Standard-Skills geändert (#692).** Ein Projekt ohne `skills` im Profil `.github/workflow-project.json` bekommt nur noch zehn Kern-Skills statt aller Kit-Skills; `kit setup` und `setup-skills` entfernen die anderen Projektkopien. Wer die übrigen Skills weiter will, trägt `"skills": "all"` ein oder `"skills": ["core", "tdd", ...]`. Welche Skills zum Kern gehören und warum: `docs/skill-core.md`.
- `kit setup` meldet Skills, die auch als Claude-Code-Plugin installiert sind, und nennt den Profil-Eintrag, der die Projektkopie weglässt.
