> **Just want to look?** `npm install && npm run demo` needs only Node 22 and git: a populated factory with real pull requests to open and merge, no Docker, no agent, no accounts.

# Setup guide

Agent Factory needs three things on the machine that runs it: **Node 22+**, **Docker** and **git**. Everything else (the coding agent's CLI, its login, the sandbox image) is handled by `init`, which runs the agent inside Docker, so you do **not** need Codex or Claude installed yourself.

## 1. Prerequisites

| | Linux | macOS | Windows |
|---|---|---|---|
| Node 22+ | `nvm install 22` or your package manager | `brew install node@22` | use **WSL2** (Ubuntu), then as Linux |
| Docker | Docker Engine; add yourself to the `docker` group so `docker ps` works without sudo | Docker Desktop | Docker Desktop with WSL2 integration |
| git | `apt install git` | `xcode-select --install` | inside WSL2 |

Check with: `node -v` (22+), `docker ps`, `git --version`. `npm run doctor` (after init) re-checks everything and prints a fix for anything wrong.

## 2. Install and initialise

```bash
git clone https://github.com/stevenmcsorley/agent-factory.git && cd agent-factory
npm install
npm run init        # interactive: prerequisites, sandbox image, agent login, first project
npm start           # prints the UI link (it includes your private token)
```

No clone? Use a fresh directory and `npx`:

```bash
mkdir my-factory && cd my-factory
npx github:stevenmcsorley/agent-factory init
npx github:stevenmcsorley/agent-factory start
```

`init` is safe to re-run; it never deletes your projects.

### Choosing and logging in the agent

| Agent | You need | What `init` does |
|---|---|---|
| **Codex** (ChatGPT subscription) | a ChatGPT plan with Codex access | shows a link and one-time code (device login) *inside Docker*, saving a **dedicated** login for the factory (never your personal one) |
| **Claude Code** | a Claude subscription **or** an Anthropic API key | runs `claude setup-token` inside Docker to mint a long-lived token (or you paste an API key); stored in an owner-only file |

Check your provider's current terms before running an unattended agent on a consumer subscription.

## 3. Connect your tools

Open the UI, then **Add a project**. You choose where your **code** lives and where your **tickets** live; both have *Test connection* buttons.

| Service | Token to create | Where |
|---|---|---|
| GitHub | none: uses `gh auth login` | install the [GitHub CLI](https://cli.github.com) |
| GitLab | access token, scope `api`, Developer role or higher | User settings → Access tokens (or Project → Settings → Access tokens) |
| Bitbucket Cloud | app password: repositories read+write, pull requests read+write | Personal settings → App passwords |
| Any git remote | optional https token; or use an ssh URL with your ssh keys | your git server |
| Ossicone | API token (read + write); the wizard links you to sign up if the server allows it | AI Agent page → Generate token |
| Jira Cloud | API token + your account email | id.atlassian.com → Security → API tokens |
| Jira Data Center | personal access token | Profile → Personal Access Tokens |
| Linear | personal API key | Settings → Security & access |

Tokens are verified before saving and kept in `state/secrets.env` (owner-only), never in `agent-factory.json`.

## 4. Your first ticket

Click into the prompt bar on the Overview page and describe a small, concrete change (name the files or functions and say how you will know it is done). The live pipeline shows it being claimed, built in the sandbox, tested and turned into a draft PR. Vague tickets are bounced with a question; that is the safety net working, not an error.

## 5. Keep it running

```bash
node src/cli.mjs service       # prints a systemd unit with the right paths (Linux)
```

Follow the three commands in its header, and the factory restarts on failure and survives logout. On macOS use `launchd` or just leave `npm start` in a terminal/tmux; on Windows run it inside WSL2.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `docker: permission denied` | add your user to the `docker` group and log in again |
| Doctor says the agent image is missing | `npm run build-image` |
| Doctor says "No dedicated Codex login" | re-run `npm run init` in an interactive terminal |
| "Run now" does nothing | check the Health page; a paused factory or a missing token blocks work |
| A ticket never gets picked up | it must be authored by *you* and carry the `agent-ready` label (or use the prompt bar) |
| `Could not connect` in the wizard | the message comes straight from the service; usually a wrong token scope or URL |
| UI asks for a token | run `node src/cli.mjs token` to print the sign-in link |
