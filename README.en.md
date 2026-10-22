<p align="center">
  <img src="./logo.png" alt="AgentHub Logo" width="128" />
</p>

# AgentHub — Agent Control Center

<p align="center">
  <a href="./README.md">简体中文</a> · <a href="./README.en.md">English</a>
</p>

> Four things — skills, usage, quota and memory — pulled into one Windows desktop app.

AgentHub is a locally-run control center (Electron + Vue 3 + TypeScript). It ships no model of its own; it simply takes what is scattered across your AI coding tools and puts it under one roof: duplicate skill installs, where this month's tokens actually went, whether your subscription quota can be used by other clients, and agents that never remember your project. Those four problems map to the four sections below.

The **Windows desktop app** carries all four sections (see [Windows download & install](#windows-download--install)). The former **Docker image** has been retired together with the Proxy Gateway module.

| Section | In one line | Who it's for |
| --- | --- | --- |
| **Skill Library** | Collect every tool's skills into one central library, maintain once, mount back everywhere | People running Codex / Claude Code / ZCode / Cursor side by side |
| **Usage Stats** | Aggregate token usage and cost from 21 data sources, sliced by day / project / model | Anyone who wants to know what this month actually cost |
| **Pool Keeper** | Collect accounts from every channel into one pool: balances, check-ins, cross-device sync (the former Proxy Gateway is no longer maintained) | People holding quota across channels (Trae / WorkBuddy / Raccoon / ModelScope / ZCode / Qoder / Cline and 14 channels in total) who want to know what is left |
| **Memory Hub** | A local Markdown memory store plus an MCP server, so agents remember your project and preferences | Anyone tired of re-explaining context in every new session |

---

## Community & Support

- **QQ group**: `110336924` (search the number in QQ to join) — usage questions and issue reports live here
- **Donate**: the project is completely free and open source. If it saved you some tokens, you are welcome to [buy the author a drink](./SPONSOR.md)
- **Business**: sponsorship, product placement in this README, custom development (ERP, dashboards, WeChat mini programs) — [get in touch](./SPONSOR.md)

Full details are in [SPONSOR.md](./SPONSOR.md).

---

## Table of Contents

- [Windows download & install](#windows-download--install)
- [Section 1: Skill Library](#section-1-skill-library)
- [Section 2: Usage Stats](#section-2-usage-stats)
- [Section 3: Pool Keeper](#section-3-pool-keeper)
- [Section 4: Memory Hub](#section-4-memory-hub)
- [FAQ](#faq)
- [Development & self-test](#development--self-test)
- [Disclaimer](#disclaimer)

---

## Windows download & install

### Installer

1. Open the [Releases page](https://github.com/HUIdada1/AgentHub/releases/latest)
2. Download `AgentHub-Setup-x.y.z.exe`
3. Double-click to install. You can change the install directory; the installer creates an "AgentHub" shortcut on the desktop and in the Start menu
4. After launch the app stays in the system tray — closing the window does not exit. Double-click the tray icon to bring the window back; the right-click menu lets you pause sync and check today's usage

### Requirements

- Windows 10 / 11 (x64)
- No need to pre-install Node, a browser or anything else — the runtime is bundled
- Some tools need their client to have been logged in on this machine (usage stats read local databases, for example)

### Data, updates and backup

- All configuration and data live in `%APPDATA%\AgentHub`; uninstalling does not remove it
- Auto-update: checks GitHub Releases **once an hour** by default. When a new version appears, a red dot shows on the settings gear in the sidebar and on the update button in Settings · General. You can turn the check off in Settings · General
- The bottom-left "Settings" holds global options (General / WebDAV sync / Sync schedule / Data & backup). Each section also has its own "Configure" button in the top-right corner

---

## Section 1: Skill Library

### The problem

You installed the same skill separately in Codex, Claude Code, ZCode and Cursor, and changing one leaves three stale copies. The Skill Library collects every tool's skill directory into one central repository and mounts it back to each tool: maintain in the center, and one update takes effect everywhere.

### Pages

| Page | What it does |
| --- | --- |
| Dashboard | Overview of the central library and each tool's connection: how many skills collected, mount health, orphan directories |
| Central library | Skill list and details; inspect / collect / mount one by one, repair broken mounts in one click |
| Dedupe & conflicts | Lists differences when the same skill differs across tools, and lets you decide which copy wins; also decides where a tool's link should point when it points somewhere else |
| Sync center | Scan preview → confirm and run → view report, all in one pass: what to collect, what to mount, what needs a decision |
| WebDAV sync | Cross-device sync of the central repository (server configured in Settings · WebDAV sync) |

### How to use

1. Open **Skill Library · Dashboard** and confirm your tools are detected (ZCode / Codex / Claude Code / Antigravity / the generic `~/.agents` are built in; other tools are suggested from local directories)
2. Go to **Sync center**, run a scan first — previews write nothing, so you can see what will be collected and where it will be mounted
3. Run it. Skills are mounted back from the central repository as junctions, so they take almost no extra space
4. When you add or change a skill somewhere, run the sync center again; conflicts land in **Dedupe & conflicts** for you to decide
5. Multiple machines: fill in the WebDAV server under **Settings · WebDAV sync**, then run the **WebDAV sync** page once to push the central repository across

---

## Section 2: Usage Stats

### The problem

Usage is scattered across each tool's own local database, and nobody tells you what the month cost in total. Usage Stats reads **local client data files** directly, normalises 21 sources onto one schema, and gives you totals, trends, cost and cross-device comparison.

### Supported sources (21)

ZCode, SenseTime Raccoon, Xiaomi MiMo, Codex, DeepSeek Harness, WorkBuddy, WorkBuddy AI, Reasonix, CodeBuddy, Qoder, Qoder CN, Antigravity, Antigravity IDE, Antigravity legacy recovery, Trae, Trae CN, TRAE SOLO, TRAE SOLO CN, OpenSquilla, Grok, AutoClaw.

Under **Configure · Usage stats** you can toggle each source and point it at a custom data directory — sources you never installed are skipped silently.

### Pages

| Page | What it does |
| --- | --- |
| Overview | KPI cards, yearly heatmap, usage trend (hourly for today), and per-machine breakdown |
| Records | Filter by source / model / project, page through entries, export to CSV |
| Cost | Cost converted from model prices; configure prices under Billing rules first |
| Billing rules | Model price table, remote price sources, model alias merging (variant names billed at the target price) |
| Sync log | Time, window, row count and result of every sync — the first place to look when something is off |

### Sync cadence

- Local collection: every **30 minutes** (fixed, no toggle)
- Cross-device sync: configured under **Settings · Sync schedule**, either hourly or once a day, and can be triggered manually at any time
- WebDAV is optional: without it the app runs in local mode and only counts this machine

---

## Section 3: Pool Keeper

> The former **Proxy Gateway** module is no longer maintained and has been turned into **Pool Keeper**: account management, balances, check-ins and cross-device sync stay; **API forwarding is gone**. The full maintenance notice is at the end of this section.

### The problem

Subscription quota is scattered across a dozen clients: how much is left, when it expires, whether today's check-in ran, and you have to log in again on every new machine. Pool Keeper collects those accounts into one local pool so you can watch balances, run check-ins and sync across devices, with credentials encrypted at rest by Windows DPAPI.

### Pages

| Page | What it does |
| --- | --- |
| Overview | Balance per channel, account availability, expiry warnings, recent activity |
| Pool | Manage accounts per channel: status, balance, plan expiry, strategy, add account, one-click check-in, switch the local IDE |
| Credits calendar | All credit packs from all accounts flattened and sorted by expiry; only packs with remaining balance by default |
| Pool sync | Share one pool across machines: accounts and credentials packed and synced over WebDAV, optionally for a single channel |
| Log | Operation log with time / level / type filters and Excel export |

### Supported channels

| Channel | Subscription | Login | Daily check-in |
| --- | --- | --- | --- |
| **Trae SOLO CN** | Trae SOLO (China) | Official auth page + local loopback callback | Daily |
| **WorkBuddy CN** | WorkBuddy (China) | Official login page + local polling | Daily |
| **WorkBuddy AI** | WorkBuddy (international) | Official login page + local polling | One-off booster pack |
| **SenseTime Raccoon** | SenseTime Raccoon | In-app auth window capture (no system browser) | Daily |
| **ModelScope** | ModelScope free inference credit (Magic Beans) | OAuth page (app self-registers) + paste `ms-` token as fallback (**no client install needed**) | Daily tasks (login / bind cloud / like to earn) |
| **LobsterAI (Youdao)** | NetEase Youdao Lobster | Official login page + local loopback callback (**no client install needed**) | Daily, 100 credits |
| **ZCode (Zhipu)** | Z.ai GLM coding plan | Z.ai auth page + local polling | Claim rewards |
| **CatPaw (Meituan)** | CatPaw desktop session quota | Import from the local CatPaw client (read live, no re-login) | No check-in |
| **Qoder CN** | Qoder (China) | Device-code polling on the official page (no client needed) / import from local software | Daily credits |
| **Qoder International** | Qoder (international) | Same as above | Daily credits |
| **AutoClaw CN** | Zhipu AutoGLM acceleration | Phone + SMS code / import from the local AutoClaw client | Daily points |
| **AutoClaw International** | AutoGLM international | OAuth login (with risk check) / import from local | Daily points |
| **Cline Free** | Cline free pool | WorkOS device authorization (confirm in browser, **no client needed**) / import from local Cline / paste credentials | No check-in |
| **Cline Pass** | ClinePass subscription pool | Same as above (one Cline login can be imported into both channels) | No check-in |

Each channel's pool, check-in and policies are fully independent: switch channels at the top of the pool page and everything below shows only that channel's accounts.

> **About the two Cline channels (Free / Pass)**
>
> - Cline is a **standard OpenAI-compatible upstream** (`api.cline.bot`) with no signing and no desktop dependency: device authorization needs one confirmation click in the browser and credentials renew themselves (the access token rotates hourly).
> - **Free and Pass are two separate channels**, not two modes of one channel: accounts, model lists, toggles and mappings are independent. The free pool has a daily allowance (in credits, shown negative when overdrawn); the subscription pool only exposes models to accounts with ClinePass.
> - Model ids carry a pool prefix (e.g. `cline-free/deepseek-v4.1-flash`) — that is the upstream's **billing-channel selector**. This module no longer forwards requests, so the prefix is informational only.

> **Two notes on the Qoder channels**
>
> - **Inference depends on a locally installed Qoder client**: each request's signature headers and body encoding are produced at runtime by a wasm module bundled with the client and cannot be constructed by hand. AgentHub extracts that capability from the installed client on first use and caches it per version (rebuilt automatically after a client upgrade, no reinstall of AgentHub needed). So **credentials alone, without the client installed, put the account in the pool but cannot send requests** — keep the client installed; the default location, the launcher's default path and custom install paths are all detected.
> - **Daily credits**: the button on the pool page is "Claim credits" (100 per day, refreshed at 10:00 UTC+8, valid for 30 days, repeated clicks count as already claimed). The claim endpoint requires the client's own risk-control identity, so the client must be installed. The international free tier excludes DeepSeek / GLM Flash models; a subscription is required to use them.

### How to use

Open **Pool Keeper → Pool**, pick a channel at the top, then click **Add account**. Every channel supports four ways in:

1. **OAuth login** (recommended) — the official auth page opens, the account lands in the pool automatically, no token typing
2. **Import from local software** — scan credentials already logged in on this machine, zero requests
3. **From a JSON / ZIP file** — bulk import account files
4. **Paste JSON** — paste one credential or a batch

Afterwards the pool lists each account's balance, plan expiry and status (`online` / `cooling` / `exhausted` / `relogin` / `disabled`). Use **Check in** (or claim a booster / credits) to maintain accounts, or turn on scheduled check-in to run every channel at a fixed time each day.

### What changed from Proxy Gateway

**Retired** (code archived, no longer maintained): the API forwarding service (OpenAI / Anthropic / Responses), API keys, model catalog, gateway usage stats, custom providers, CC Switch integration, network proxy (egress pool), the Docker image and remote instances, hot-reloaded rules.

**Kept**: pool account management, balance queries, check-in, pool sync, operation log, IDE account switching.

### Maintenance notice

> The **Proxy Gateway** module is now in maintenance-stop state and has been reworked into the **Pool Keeper** module.
>
> Scope: no further feature work or code updates; upstream protocol changes and anti-bot strategies will no longer be tracked; new issues and pull requests for this module will not be accepted.
>
> Reason: this is a personal tool without the capacity for long-term protocol adaptation or anti-bot work. Upstream changes make the stability and usable lifetime of the forwarding path unpredictable, so continued adaptation work has limited value.
>
> Repository state: the repository stays in its current usable state; merged fixes will not be reverted.
>
> Risk notice: please assess the risk yourself. Affected by upstream policy changes, the feature may stop working at any time; any account risk control, restriction or ban resulting from using unofficial clients is the user's own responsibility.

---

## Section 4: Memory Hub

### The problem

Every new agent session forgets your project background, technical decisions and past mistakes. The Memory Hub keeps a local **Markdown memory store**, distils facts worth keeping from conversations, and exposes them to agents over **MCP** — your memory stays a pile of local, readable, diffable md files.

The default store lives in `~/AgentHub/memory`: `projects/<project>/l1/<agent>/<date>.md` holds raw facts, `projects/<project>/l2/...` holds distilled summaries, decisions and knowledge.

### Pages

| Page | What it does |
| --- | --- |
| Dashboard | Total memories, growth trend, distribution across projects and agents |
| Browse | Four views — list / heatmap / pending / trash; the three kinds of entries needing a human decision are handled under Pending |
| Projects | Per-project summaries and provenance; rename or merge projects |
| Profile | Preferences and persona distilled from long-term records |
| Agent access | One-click MCP and instruction-block injection for each agent, with three-level verification |
| Search & index | Full-text search (Chinese bigram tokenisation + synonym expansion), index status and self-healing |
| Automation | Nine background tasks: toggles, cadence, run-now and history |
| Import & dedupe | Import memories from each tool's conversation history, merge duplicates |
| WebDAV sync | Cross-device sync of the memory store |

### How to use

1. **Connect an agent**: open **Agent access**, find your agent (ZCode, Codex CLI, WorkBuddy, Claude Code, DeepSeek Harness, Trae Solo, Cursor and the generic `~/.agents` are built in) and click inject. It does two things: adds an MCP launch entry to the agent config, and writes a controlled block into its instruction file (`AGENTS.md` / `CLAUDE.md` etc.). Both are backed up first, and uninstalling removes only its own parts
2. **Verify**: the three-level check on the card confirms in order "config entry present → the bridge can actually launch and list tools → this agent has really called it". Only a heartbeat at level three proves it is in use
3. **Import history**: open **Import & dedupe** to bring existing conversation history in as base material (Codex, ZCode, WorkBuddy and others are supported), with a dry-run preview first
4. **Turn on automation**: open **Automation** and enable what you need. The nine tasks fall into two groups:
   - Local algorithms: project grouping suggestions, index self-healing (no tokens)
   - Model-based: structured extraction, summaries, auto-tagging, staleness decisions, L2 distillation, dedupe merging, persona / preference profiling
5. **Give memory tasks a model**: choose the model source on the Memory Hub config page — your own OpenAI-compatible API (key stored locally, masked in the UI) — and configure a fallback chain

### Pending inbox

After automation runs, three kinds of conclusions do not take effect immediately but queue for your confirmation: **staleness decisions** (does a new fact supersede an old one), **project grouping suggestions** and **dedupe merge suggestions**. They live under **Browse → Pending**; accept or reject one by one, each with a recommendation, or accept all recommendations at once.

---

## FAQ

**Q: Why can't Trae switch to the IDE?**
Trae's local login state is a ByteCrypto encrypted envelope bound to a device key; a valid file cannot be built externally. The app says so instead of damaging your login state.

**Q: What should I watch with multiple Raccoon accounts?**
Add them all through AgentHub's **OAuth login**. **Do not click "Log out" in the desktop Raccoon app** — SenseTime's server revokes the old credentials, which invalidates the accounts in your pool.

**Q: After syncing the pool to a second machine over WebDAV, a Raccoon account shows "needs re-login".**
No re-login needed; let it recover. Raccoon's refresh token rotates on every use (each refresh on machine one invalidates the synced copy). Since v1.68.1, a rejected refresh automatically fetches the latest credentials from the other device and retries, and the first machine pushes its fresh copy immediately after its next refresh — so **keep both machines on, with network and WebDAV working, and wait one quota refresh cycle (30 minutes by default)**. Log the same account in only once inside AgentHub: **do not log in again on the second machine via OAuth or the client** — that creates a second session and the server kicks one out, including the first machine. When it really drops, the account bubble explains why (server rejection / concurrent refresh / suspected login elsewhere).

**Q: Does "Switch to IDE" interrupt the client I'm using?**
Yes: the app closes the client, writes the login state and reopens it (which is why it always asks first). Save your work before clicking.

**Q: Are my credentials safe?**
Account tokens are encrypted with Windows DPAPI before touching disk and stay in the main process, never exposed to the renderer. Requests only go to the official endpoints of the services you use and to the WebDAV server you configure — never through a third-party server.

**Q: Is a lot of functionality unavailable without WebDAV?**
No. Usage Stats falls back to local mode automatically, and the single-machine features of the Skill Library, Pool Keeper and Memory Hub all work. WebDAV is only for sharing across machines.

**Q: When does scheduled check-in run?**
Off by default. Once enabled it runs every channel at the configured time (09:00 by default, changeable) and records results per channel, so each channel keeps its own history.

---

## Development & self-test

```bash
# Requires Node >= 18
npm install

npm run dev          # desktop development (Electron + Vite HMR)
npm run dev:web      # browser-only UI preview (mock data, no Electron)
npm run build        # type check + frontend build
npm run electron:build   # package the installer into release/
```


