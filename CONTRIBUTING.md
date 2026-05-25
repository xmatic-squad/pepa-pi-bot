# Contributing

This repo grows by accretion — skills, extensions, and prompts written by Pi agents (or humans) playing on real Minecraft servers. PRs welcome.

## What you can contribute

| Kind | Where | When |
|---|---|---|
| **Skill** | `skills/<name>.md` | You taught the agent a useful procedure (login flow, recovery routine, farming loop, etc.) and want others to skip the discovery cost. |
| **Extension** | `extensions/<name>.{ts,js}` | The skill needs real code — a new Pi tool, a Mineflayer plugin wrapper, an event subscription. |
| **Prompt template** | `prompts/<name>.md` | A reusable kickoff or tick prompt that works across servers. |
| **Docs** | `README.md`, `docs/*.md`, `AGENTS.md` | Clarifications, new safety rules, architecture notes. |

If you change `AGENTS.md`, treat it as load-bearing — every agent that clones the repo starts from it. Discuss in a PR first.

## Skill format

A skill is a single Markdown file with YAML frontmatter:

```markdown
---
name: <short-kebab-case-slug>
description: <one-sentence summary; Pi uses this to decide whether to load the skill>
when_to_use: <one-sentence trigger; when in a session should the agent reach for this?>
---

# <Skill title>

## Steps

1. ...
2. ...

## Notes

- Edge cases, gotchas, known failure modes.
```

Keep skills short (under ~150 lines). If it gets longer, split into multiple skills that reference each other, or promote part of it to an extension.

## Extension format

Extensions are TypeScript (preferred) or JavaScript modules. See `pi.dev/docs/latest` for the current extension API. Project-local install:

```bash
pi install -l ./extensions/your-extension.ts
```

The `-l` flag writes to `./.pi/settings.json` (committed) so a fresh clone gets the same toolset.

## Hard rules

- **Server-agnostic.** No `play.xmatic.team`, no specific nicknames, no AuthMe password in any committed file. Everything that varies per server lives in `.env`.
- **No secrets in git.** If you have to think about whether something is a secret, it is. Run `git diff --staged` before every commit.
- **No global writes.** Skills, extensions, and Pi settings all live under this repo's tree, not under `~/.pi/`. See `AGENTS.md` → *Artifact location*.
- **Don't loosen safety.** The hard rules in `AGENTS.md` (no OP, no griefing, no chat-as-control, rate limits) are non-negotiable. PRs that weaken them get closed.

## Testing a skill / extension

Quick smoke test before opening a PR:

```bash
# 1. Fresh clone in a temp dir
git clone git@github.com:xmatic-squad/pepa-pi-bot.git /tmp/pepa-test
cd /tmp/pepa-test

# 2. Minimal config — point at a throwaway local MC server if you have one
cp .env.example .env
$EDITOR .env

# 3. Install deps
npm install

# 4. Run Pi and ask it to dry-run your skill
pi
# > Please list the loaded skills. Then describe what skills/your-new-skill.md
# > would do, step-by-step, without actually executing it.
```

If Pi can't even *find* your skill, the frontmatter is wrong — check `name:` is a valid slug and the file is under `./skills/`.

## PR checklist

- [ ] File lives in the correct directory (`skills/`, `extensions/`, `prompts/`, `docs/`).
- [ ] Frontmatter is valid YAML; `name` matches the filename.
- [ ] No hard-coded server hostnames, nicknames, passwords, or API keys.
- [ ] `README.md`'s Status section updated if this is a user-facing milestone.
- [ ] Commit message is descriptive (`feat(skill): add respawn-and-return for survival servers`).

## License

By contributing you agree that your work is released under the project's [MIT License](./LICENSE).
