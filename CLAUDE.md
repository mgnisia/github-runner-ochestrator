# Project Instructions for AI Agents

This file provides instructions and context for AI coding agents working on this project.

<!-- BEGIN BEADS INTEGRATION v:1 profile:minimal hash:ca08a54f -->
## Beads Issue Tracker

This project uses **bd (beads)** for issue tracking. Run `bd prime` to see full workflow context and commands.

### Quick Reference

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --claim  # Claim work
bd close <id>         # Complete work
```

### Rules

- Use `bd` for ALL task tracking — do NOT use TodoWrite, TaskCreate, or markdown TODO lists
- Run `bd prime` for detailed command reference and session close protocol
- Use `bd remember` for persistent knowledge — do NOT use MEMORY.md files

## Session Completion

**When ending a work session**, you MUST complete ALL steps below. Work is NOT complete until `git push` succeeds.

**MANDATORY WORKFLOW:**

1. **File issues for remaining work** - Create issues for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **PUSH TO REMOTE** - This is MANDATORY:
   ```bash
   git pull --rebase
   bd dolt push
   git push
   git status  # MUST show "up to date with origin"
   ```
5. **Clean up** - Clear stashes, prune remote branches
6. **Verify** - All changes committed AND pushed
7. **Hand off** - Provide context for next session

**CRITICAL RULES:**
- Work is NOT complete until `git push` succeeds
- NEVER stop before pushing - that leaves work stranded locally
- NEVER say "ready to push when you are" - YOU must push
- If push fails, resolve and retry until it succeeds
<!-- END BEADS INTEGRATION -->


## Build & Test

Tooling is pinned with **mise** (`mise install`) and JS deps use **bun**. Infra is **OpenTofu** in `tofu/` (see README for the two-phase deploy).

```bash
mise install       # provision Node 22, bun, opentofu (versions in mise.toml)
bun install        # install JS dependencies
bun run build      # type-check (tsc --noEmit)
bun test           # run jest unit tests
bun run init       # tofu init — S3 backend bucket read from .env (TF_STATE_BUCKET)
bun run synth      # bundle Lambdas + tofu plan (dry run)
bun run deploy     # bundle Lambdas + tofu apply (Phase A infra; Phase B once both MICROVM_IMAGE_ARN_* are set in .env)
bun run build:image:docker     # build github-runner-docker image, write MICROVM_IMAGE_ARN_DOCKER to .env
bun run build:image:no-docker  # build github-runner-no-docker image, write MICROVM_IMAGE_ARN_NO_DOCKER to .env
bun run build:images           # build both images sequentially (required before Phase B deploy)
```

## Architecture Overview

_Add a brief overview of your project architecture_

## Conventions & Patterns

_Add your project-specific conventions here_
