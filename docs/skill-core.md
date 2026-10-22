# Kernsatz an Skills

Entscheidung vom 22.10.2026 (Issue #692, Freigabe Milan). Ohne `skills` im Profil `.github/workflow-project.json` gelten nur diese zehn Skills. Alle anderen Skills des Kits schaltet das Projekt selbst zu.

**Kernsatz:** `spec-review`, `find-skills`, `pr`, `code-review`, `ponytail`, `ponytail-review`, `grilling`, `writing-for-agents`, `codebase-design`, `to-tickets`. Die Liste steht im Code als `coreSkills` in `scripts/project-profile.mjs`.

## Warum diese

Zwei Quellen, beide gezählt.

1. **Echte Nutzung.** 522 Claude-Code-Transkripte (`~/.claude/projects/*/*.jsonl`, Stand 22.10.2026), gezählt wurden die Aufrufe des Tools `Skill`. Es gibt nur zwei Projekte mit Kit-Skills (ein Produktprojekt und das Kit selbst), die Zahlen zeigen also eine Tendenz, keine Statistik. Aufrufe (Projekte): `grilling` 58 (2), `pr` 21 (2), `writing-for-agents` 17 (2), `impeccable` 15 (2), `codebase-design` 11 (2), `code-review` 9 (1), `ponytail-audit` 5 (1), `domain-modeling` 3 (1), `to-tickets` 3 (1), `spec-review` 2 (1), `to-spec` 2 (1), `prototype` 2 (1), `ponytail-review` 1 (1), `tdd` 1 (1), `diagnosing-bugs` 1 (1), `chief-of-staff` 1 (1). Alle übrigen Skills: kein Aufruf.
2. **Was der Kit-Ablauf selbst nennt.** `spec-review` (AGENT_RULES, Board-Feld), `find-skills` (README), `pr` (Anweisung in `board-checkout`), `code-review` und `ponytail-review` (Selbstprüfung in `docs/parallel-drivers.md`), `to-tickets` (CONTRIBUTING, Tickets schneiden). `ponytail` gehört dazu, weil `ponytail-review` seine Regeln braucht.

`grilling`, `writing-for-agents` und `codebase-design` sind nach Aufrufen die häufigsten Skills ohne Kit-Verweis.

## Warum nicht mehr

- `impeccable` (15 Aufrufe) ist nur für Projekte mit Oberfläche nützlich und hat mit 909 Zeichen die längste Beschreibung. Projekte mit Web- oder Mobile-Oberfläche nehmen es ins Profil auf (`parallel-drivers.md`, Regel zur Selbstprüfung).
- `grill-me`, `grill-with-docs` sind Dubletten von `grilling`; die übrigen Ponytail-Geschwister, `migrate-to-shoehorn`, `scaffold-exercises` und weitere sind kursspezifisch oder nie aufgerufen.

## Wirkung

Beschreibungen aller 47 Skills im Kit: etwa 9.700 Zeichen, grob 2.400 Token pro Session. Der Kernsatz: etwa 2.800 Zeichen, grob 700 Token. Gemessen an `name` plus `description` der `SKILL.md`, geteilt durch 4.

## Zuschalten

```json
{ "skills": ["core", "tdd", "impeccable"] }
```

`"core"` steht für den Kernsatz, `"all"` (statt einer Liste) behält jeden Skill des Kits, eine Liste ohne `"core"` nimmt genau die genannten Namen.

## Längengrenze

`scripts/tests/skill-core.test.mjs` begrenzt die Beschreibung auf 600 Zeichen bei den Skills, deren Text das Kit selbst schreibt oder ändert (`spec-review`, `retro`, `implement`, `implement-spec`, `chief-of-staff`, `code-review`). Upstream-Texte nimmt der Test aus.
