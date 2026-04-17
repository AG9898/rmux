# von-ralph

Headless Claude Code agent loop runner. Bash scripts handle process management and looping; a Rust/Ratatui TUI provides live monitoring and control.

## Architecture

```
~/.ralph/
  logs/     # timestamped log per instance
  pids/     # PID files + JSON metadata
```

| Component | Path | Purpose |
|-----------|------|---------|
| `ralph` | `./ralph` | Main loop runner |
| `alph` | `./alph` | Single headless run |
| `ralph-status` | `./ralph-status` | CLI monitor (list, tail, kill) |
| TUI | `ralph-tui/` | Ratatui terminal dashboard |
| Dashboard | `dashboard/` | Svelte web UI (exploratory) |

## Primary focus

`ralph-tui/` — the Rust TUI is where active development lives. Prioritize stability, UX, and feature completeness here.

## Coding standards

- **Conventional commits**: `feat:`, `fix:`, `chore:`, `refactor:`, `test:`, `docs:`
- **Minimal abstractions**: duplicate two or three times before abstracting
- **Tests**: write tests for new non-trivial Rust logic; skip for trivial getters/formatting
- **Comments**: only comment non-obvious WHY; never explain WHAT the code does

## Workflow

`docs/tasks.json` tracks tasks. Pick up tasks and update status when working a session — lightweight, no ceremony required.

## Docs

- [`docs/PRD.md`](docs/PRD.md) — product vision, target users, and feature pillars
- [`docs/DESIGN.md`](docs/DESIGN.md) — TUI design philosophy, layout, keybindings, and data model
