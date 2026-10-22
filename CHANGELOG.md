# Changelog

## Unveröffentlicht

- **Standard-Skills geändert (#692).** Ein Projekt ohne `skills` im Profil `.github/workflow-project.json` bekommt nur noch zehn Kern-Skills statt aller Kit-Skills; `kit setup` und `setup-skills` entfernen die anderen Projektkopien. Wer die übrigen Skills weiter will, trägt `"skills": "all"` ein oder `"skills": ["core", "tdd", ...]`. Welche Skills zum Kern gehören und warum: `docs/skill-core.md`.
- `kit setup` meldet Skills, die auch als Claude-Code-Plugin installiert sind, und nennt den Profil-Eintrag, der die Projektkopie weglässt.
