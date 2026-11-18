# Engineering agents

Claude Code subagents for this repo. Copied from
[alirezarezvani/claude-skills](https://github.com/alirezarezvani/claude-skills)
(`agents/engineering`, commit `f8593c4`, MIT License, © 2025 Alireza Rezvani).

| Agent | Use it for |
|---|---|
| `cs-fullstack-engineer` | Stack and architecture decisions across the bot, the web app and Supabase |
| `cs-backend-engineer` | API, database, queues and SLO decisions for the backend |
| `cs-senior-engineer` | General architecture, code review, CI/CD, security review |
| `cs-karpathy-reviewer` | Reviewing the staged diff before a commit |

The skills these agents call live in `../skills/`. Paths were rewritten from the
upstream layout to `.claude/skills/<name>/`. The scripts need only Python 3
(standard library).

Not copied, so these links stay unresolved: the "related agents"
(`cs-cto-advisor`, `cs-vpe-advisor`, `cs-ciso-advisor`, `cs-engineering-lead`,
`cs-product-manager`), `business-operations/CLAUDE.md`, and a few optional
specialists named in the composition maps (`chaos-engineering`,
`feature-flags-architect`, `adversarial-reviewer`, `api-test-suite-builder`).

These agents are generic. In this repo they must follow `AGENTS.md`: the bot
stays a single Node.js process, so treat any microservices or "split the
service" suggestion from them as out of scope.
