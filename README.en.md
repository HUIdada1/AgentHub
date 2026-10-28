<p align="center">
  <img src="./logo.png" alt="AgentHub Logo" width="128" />
</p>

# AgentHub — Agent Control Center

<p align="center">
  <a href="./README.md">简体中文</a> · <a href="./README.en.md">English</a>
</p>

> Six things — skills, usage, quota, memory, prompts and local forwarding — pulled into one Windows desktop app.

AgentHub is a locally-run control center (Electron + Vue 3 + TypeScript). It ships no model of its own; it simply takes what is scattered across your AI coding tools and puts it under one roof: duplicate skill installs, where this month's tokens actually went, whether your subscription quota can be used by other clients, agents that never remember your project, the same prompt you keep rewriting in every new session, and quota you hold but cannot plug into your own IDE. Those six problems map to the six sections below.

The **Windows desktop app** carries all six sections (see [Windows download & install](#windows-download--install)). The former **Docker image** has been retired together with the Proxy Gateway module; its API forwarding capability is succeeded by the new **Local Gateway** section, embedded in the main process and read-only over the pool.

| Section | In one line | Who it's for |
| --- | --- | --- |
| **Usage Stats** | Aggregate token usage and cost from 21 data sources, sliced by day / project / model | Anyone who wants to know what this month actually cost |
| **Memory Hub** | A local Markdown memory store plus an MCP server, so agents remember your project and preferences | Anyone tired of re-explaining context in every new session |
| **Prompt Library** | Expand a one-liner into a well-formed prompt, keep the good ones, plus a curated catalogue of 60 | Anyone rewriting the same prompt, or unsure how to state a request clearly |
| **Pool Keeper** | Collect accounts from every channel into one pool: balances, check-ins, cross-device sync | People holding quota across channels (Trae / WorkBuddy / Raccoon / ModelScope / ZCode / Qoder / Cline and 14 channels in total) who want to know what is left |
| **Local Gateway** | Wrap your pool accounts into one local OpenAI / Anthropic compatible endpoint — change a single `base_url` | Anyone who wants their IDE, scripts or own services to use the pool's quota |
| **Skill Library** | Collect every tool's skills into one central library, maintain once, mount back everywhere | People running Codex / Claude Code / ZCode / Cursor side by side |

> The table order is the default left-sidebar navigation order (Usage Stats → Memory Hub → Prompt Library → Pool Keeper → Local Gateway → Skill Library). It can be dragged in **Settings · General**; once changed, the section numbers in this document no longer match the sidebar position — trust the sidebar.

---

## Community & Support

- **QQ group**: `110336924` (search the number in QQ to join) — usage questions and issue reports live here
- **Donate**: the project is completely free and open source. If it saved you some tokens, you are welcome to [buy the author a drink](./SPONSOR.md)
- **Business**: sponsorship, product placement in this README, custom development (ERP, dashboards, WeChat mini programs) — [get in touch](./SPONSOR.md)

Full details are in [SPONSOR.md](./SPONSOR.md).

---

## Table of Contents

- [Windows download & install](#windows-download--install)
- [Section 1: Usage Stats](#section-1-usage-stats)
- [Section 2: Memory Hub](#section-2-memory-hub)
- [Section 3: Prompt Library](#section-3-prompt-library)
- [Section 4: Pool Keeper](#section-4-pool-keeper)
- [Section 5: Local Gateway](#section-5-local-gateway)
- [Section 6: Skill Library](#section-6-skill-library)
- [FAQ](#faq)
- [Development & self-test](#development--self-test)
- [Disclaimer](#disclaimer)
- [Full statement](#full-statement)

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

- Configuration and most data live in `%APPDATA%\AgentHub`; uninstalling does not remove it
- Exception: the three "user assets" live in your home directory so you can back them up or commit them directly — Skill Library `~/.agent_skills` (override with `AGENT_SKILLS_HOME`), Memory Hub `~/AgentHub/memory`, Prompt Library `~/AgentHub/prompts`
- Auto-update: checks GitHub Releases **once an hour** by default. When a new version appears, a red dot shows on the settings gear in the sidebar and on the update button in Settings · General. You can turn the check off in Settings · General
- The bottom-left "Settings" holds global options (General / WebDAV sync / Sync schedule / Data & backup). Each section also has its own "Configure" button in the top-right corner

---

## Section 1: Usage Stats

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

## Section 2: Memory Hub

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


## Section 3: Prompt Library

### The problem

You rewrite the same prompt in every new session, and "write me a weekly report" is too vague to get a good answer. The Prompt Library splits this into three steps: **let the model expand it** (Optimize), **keep the good ones** (My Library), **grab ready-made ones** (Online).

### Pages

| Page | What it does |
| --- | --- |
| Optimize | Source box on top, result below; 6 built-in styles + extra requirements + angle hints; streams as it generates |
| History | The last 50 runs with input / output / duration / tokens; refill and re-run in one click |
| My Library | Category tree, tags, favourites, version history, trash, import/export, full-text search |
| Online Library | 60 curated prompts + 10 templates built in; update check; import your own dataset |
| WebDAV sync | Cross-device sync of the library, with per-item conflict resolution |

### The 6 built-in styles

| Style | When to use it |
| --- | --- |
| General | Default. Adds context, tightens constraints, structures the result, keeps the language |
| **Multi-angle** | **When the input is very short** (e.g. "write me a weekly report"). Scans 9 angles for gaps, fills them with reasonable assumptions, then emits a standard structure |
| Concise | Subtraction only: removes redundancy, adds nothing |
| Structured | Forces layers: goal / input / constraints / output format / acceptance |
| Constraints | Focuses on edge cases, prohibitions and checkable acceptance criteria |
| Coding | Preset for a coding assistant: technical context and verifiable done criteria |

Two design points behind **Multi-angle**:

- **Never invents facts**: names, organisations, numbers, dates, amounts and model numbers stay as `{{variables}}`
- **Assumptions stay visible**: up to 3 assumptions are listed under the result, each with "if this is wrong, the output changes like this". Select the matching text in the result and click **→ variable** to turn it into a fillable slot

### Three details worth trying

1. **Extra requirements** — need "for a non-technical boss"? Put it in the box under the source text instead of editing the source. Editing the source pollutes the prompt's lineage, and you would have to undo it to try another variant
2. **Streaming** — text appears as it is generated, with an elapsed timer. If the upstream does not support streaming the app falls back to a single response (slow once, then it remembers that provider); if the stream stalls for 20 seconds it aborts with an explanation instead of spinning forever
3. **Take over an assumption** — each assumption can be converted into a variable, turning "what the model guessed" into "what you fill in once"

### Online Library

- **60 prompts built in** across 8 categories (writing / coding / analysis / office / image / role-play / learning / life) plus **10 templates**. Templates carry the method: when to use it, how to do it, what usually goes wrong
- **Works offline**: the catalogue ships inside the installer, so there is content on first launch; once online, **Check for updates** pulls only the changed shards
- **Importing never overwrites your edits**: imported prompts are tagged `online`, and when the catalogue updates the card shows **update available** — but anything you have edited is never overwritten silently
- **Import your own dataset**: `{items:[...]}`, `{prompts:[...]}` or a bare array. Imported entries stay on your machine; licensing is your responsibility

### Where the data lives

| Content | Location | Synced |
| --- | --- | --- |
| Prompt library (one `.md` per prompt) | `~/AgentHub/prompts` | Yes (WebDAV) |
| Optimize history (last 50) | `%APPDATA%\AgentHub\prompts\history.json` | No, local only |
| Styles (including custom) | `%APPDATA%\AgentHub\prompts\styles.json` | No, local preference |
| Online catalogue cache | `%APPDATA%\AgentHub\prompts\catalog` | No, app asset |

### How to use

1. Open **Optimize**, paste what you want to improve. Pick **Multi-angle** when the input is thin, **General** when it is already fairly complete
2. Put any extra requirement in the box below the source; if you are unsure what is missing, click an angle chip (audience / scene / format / boundary / example / acceptance)
3. Review the result, re-run it, or edit it in place. If you edited it, **Re-optimize** asks before overwriting your changes
4. Happy with it? **Save to My Library** — `{{variables}}` in the body are detected automatically
5. Want something ready-made? Browse the **Online Library** by category, or use **Find by variable** in the left rail to search from the material you already have
6. Multiple machines: configure the server under **Settings · WebDAV sync**, then run it on the **WebDAV sync** page

---

## Section 4: Pool Keeper

> The former **Proxy Gateway** module is no longer maintained and has been turned into **Pool Keeper**: account management, balances, check-ins and cross-device sync stay. Its API forwarding capability has been succeeded by the new **Section 5: Local Gateway** (embedded in the main process, read-only over the pool). The full maintenance notice is at the end of this section.

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
| **ModelScope** | ModelScope free inference credit (Magic Beans) | OAuth page (app self-registers) + paste `ms-` token as fallback (**no client install needed**) | Daily tasks (login / bind cloud; likes are no longer auto-clicked) |
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

### Compliance boundary: account management only

The pool exists to **manage your own accounts**, not to manufacture activity on their behalf. Concretely:

- **No automatic check-in after login / import** (off by default): adding an account only stores it in the pool and produces no record on the provider's side. Turn it on explicitly under **Settings · Pool Keeper** if you want it. The manual **Check in** button is unaffected.
- **Balance polling can be turned off on its own** (on by default, 15-minute minimum interval): balance queries are outbound requests, so **Settings · Pool Keeper** has a dedicated switch; turning it off leaves only manual refresh.
- **No qualification circumvention**: the app does not lend a device fingerprint across accounts to get around "one device, one claim per week" style limits. The **fingerprint repair** in the pool only restores a colliding account to **its own** stable fingerprint, never borrowing from another account.

### What changed from Proxy Gateway

**Retired** (code archived, no longer maintained): the standalone Proxy Gateway process and its external-plugin form, the Docker image and remote instances, custom providers, CC Switch integration, network proxy (egress pool), hot-reloaded rules.

**Kept**: pool account management, balance queries, check-in, pool sync, operation log, IDE account switching.

**Succeeded**: API forwarding (OpenAI / Anthropic), API keys, model catalog and gateway request stats are reimplemented by the new [Section 5: Local Gateway](#section-5-local-gateway) as a main-process-embedded module that talks to the pool read-only — no separate gateway process, no Docker form.

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

## Section 5: Local Gateway

### The problem

Your pool already holds a pile of channel accounts, but when your IDE, a script or your own service wants to call a model, you still have to dig up each channel's login state and hand-build its request format. The Local Gateway wraps the accounts **already configured in the pool** into **one local OpenAI / Anthropic compatible endpoint**: point `base_url` at `http://127.0.0.1:9527/v1` and leave the rest as it is.

It does not create a second account model — **Pool Keeper** remains the single source of truth for accounts, and the gateway reads it read-only.

### Pages

| Page | What it does |
| --- | --- |
| Overview | Run state, today's requests / tokens, success rate, average latency, channel online status, live request stream, a three-step quick start |
| Services & Keys | Create / revoke / rename API keys; name them per caller, scope which channels they may reach, plus concurrency, per-minute cap and expiry |
| Model Catalog | Merge each channel's models, with aliases and overrides (map an upstream real model name to the name you want to expose) and custom models; control whether they appear in `/v1/models` |
| Usage Stats | KPIs, trend, channel and status breakdown, model ranking and detail rows for today / last 7 days / last 30 days / a custom range, plus cleanup by retention |
| Routing & Channels | Strategy (smart / fixed / round-robin / score), failover and cooldown backoff, per-channel on/off, single-channel connectivity test |
| Custom Providers | Bring your own upstream provider (base URL / keys / model list / extra headers and body), fetch its model catalog and merge it as added / existing / retired |
| Ecosystem Integration | Point Claude Code / Codex CLI / Claude Desktop at this gateway in one click; keeps **routing** (the takeover switch stored in the DB) distinct from **link** (where the client actually points) |
| Network Proxy | Outbound exit pool (direct / fixed / rotate) with connectivity tests; the same page also carries an **Outbound Spoofing** tab |
| Request Log | Newest first, filter by channel / status, export as JSONL or CSV; the **敏** column marks requests whose fingerprints were scrubbed |
| Access & Docs | Local listen address, curl examples, one-click copy of IDE configuration |

> **Settings** (top right) opens the config page with five sub-tabs: Listen & Security / Performance & Limits / Module Wiring / Extension Points / **Outbound Spoofing**. The Outbound Spoofing tab and the one on the Network Proxy page read and write the same config — editing either has the same effect.

### Endpoints

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/health` | Liveness, **no auth** (returns run state and port only) |
| GET | `/v1/models` | OpenAI-style model catalogue |
| POST | `/v1/chat/completions` | OpenAI chat completions, streaming (SSE) supported |
| POST | `/v1/messages` | Anthropic Messages, streaming supported; inbound field translation and outbound SSE frame mapping |
| GET | `/v1/anthropic/models` | Compatibility placeholder (Anthropic has no such endpoint; returns an empty catalogue) |

Both `Authorization: Bearer <key>` and Anthropic's `x-api-key` header are accepted.

### Key design points

- **Credentials never leave the process**: upstream credentials are read from the pool vault only — never written into the gateway config, never into logs
- **Disabled in the pool means circuit-broken here**: an account disabled in Pool Keeper is equally unusable through the gateway
- **API keys are never stored in clear**: the database keeps only `HMAC-SHA256(raw + internal secret)` plus a display prefix; the full key appears exactly once, in the create response
- **Port conflicts self-heal**: if 9527 is taken it probes 9528 ~ 9530, and the UI shows the port that is **actually in effect**
- **No autostart, loopback only by default**: installing it does not open a port; `autostart` defaults to off and `bind` defaults to `127.0.0.1`
- **Outbound spoofing & scrubbing (one policy per channel)**: upstreams audit the request body by **literal exact match** (not semantically), and every official client has a fixed request shape. The **Outbound Spoofing** tab in Settings gives **each upstream channel** its own policy, with a global default inherited by channels you have not configured:
  - **Mode**: `mimic` (rewrite the outbound request per policy) or `passthrough` (send headers and body as-is). **Custom provider channels default to passthrough** — their peer is not an official agent backend, so there is no risk-control fingerprint to mimic
  - **Mimic profiles**: built-in request shapes (UA and shape headers) for official clients such as Claude Code / Codex CLI / Cursor / Gemini CLI, plus your own profiles. Shape only — it never proxies for, or launches, any agent software
  - **Header override / removal**: add, change or drop outbound headers per channel (swap the UA, strip a client's self-reported field), leaving auth headers alone
  - **Keyword scrubbing and sentence rewrites**: scope by **message role** (system / user / assistant / tool) and replace literally or by regex. Built-in fingerprint scrubbing (header key/value segments, `cc_*` billing field names, template sentences such as `official CLI for Claude`, the bare error code `11128`) is one built-in rule group, on by default
  - **Only the copy sent upstream is changed**: the response your client sees is unchanged, and affected requests are tagged in the **敏** column of the Request Log, where hovering shows which rules hit
  - **Dry run**: paste sample text and click **Dry run** to see the before/after difference and the hit list, with no upstream call
- **Zero regression on the pool's own egress**: the pool's own requests carry no outbound context, so a policy only affects requests the gateway forwards; switching a channel back to passthrough (or clearing its policy) restores the original behaviour
- **Disabling the section stops the service**: toggling the module off immediately closes the listener and releases connections

### Where the data lives

| Content | Location | Synced |
| --- | --- | --- |
| API keys (HMAC + prefix) | `localgw_keys` table in `%APPDATA%\AgentHub\proxy\stats.db` | No (same DB and backup as the pool) |
| Request log | `localgw_logs` table in the same DB, pruned by `logRetentionDays` | No |
| Gateway config | the `localgw` block of `%APPDATA%\AgentHub\config.json` | No |

### How to use

1. First add at least one channel account to the pool in **Pool Keeper** (the gateway takes its accounts from there; with none, the Overview shows a three-step guide)
2. Back in **Local Gateway → Overview**, click **Start** — the status badge becomes "Running · 9527"
3. Go to **Services & Keys** and create your first API key — **the page shows it exactly once**, so copy it immediately
4. Go to **Access & Docs**, copy the curl example or the IDE configuration, point `base_url` at `http://127.0.0.1:9527/v1` and paste the `sk-lgw-...` key
5. To see which channel is slow, filter by channel in **Request Log**, or read the P95 latency on the Overview

---

## Section 6: Skill Library

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
No. Usage Stats falls back to local mode automatically, and the single-machine features of the Skill Library, Pool Keeper, Memory Hub and Prompt Library all work. WebDAV is only for sharing across machines.

**Q: When does scheduled check-in run?**
Off by default. Once enabled it runs every channel at the configured time (09:00 by default, changeable) and records results per channel, so each channel keeps its own history.

**Q: Optimize keeps spinning — what now?**
First check that **Settings · Model Gateway** has a usable model (if not, the app says so and offers a jump). Then look at the timeout under **Advanced**. While streaming, if the upstream sends nothing new for 20 seconds the app aborts and explains why instead of spinning forever. On an unstable proxy, turn off **Streaming** under **Config · Optimize preferences** to skip that failed round-trip.

**Q: Can I use the Online Library entries commercially?**
The 60 built-in prompts and 10 templates are original content; the licence is shown under **Source & licence** in the detail drawer. For **datasets you import yourself**, licensing and compliance are your responsibility — the app only loads them locally and never redistributes them.

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

Regression gate (plain Node, no network, no real data — every `scripts/test-*.cjs` plus the `tools/` cockpit compatibility contract self-test; any failure exits non-zero):

```bash
npm test
```

Prompt Library self-test (plain Node, no network, no real data — the catalogue test swaps `dataDir` for a temp directory):

```bash
node tools/prompts-smoke.cjs   # built-in styles / {extra} rendering / <ASSUMPTIONS> extraction / SSE decoding for 3 formats / local fake upstream end-to-end (incl. fallback and cancel) / online catalogue / IPC channel consistency
```

---

## Disclaimer

> Please read this section in full before using the project. **Downloading, installing, launching or using this project in any way means you have read, understood and fully accepted the terms below.**

### 1. For learning and exchange only

This project is a hands-on project for learning **local credential management, multi-upstream account and quota aggregation, HTTP reverse proxying with SSE streaming pass-through, OpenAI / Anthropic protocol adaptation, cross-tool skill directory management and Electron desktop packaging**. It is for personal learning and research only and is not an official product of any company.

This project is **not affiliated with** the following companies or their products in any way, and has not received their authorisation, endorsement, sponsorship or backing:

Tencent and WorkBuddy / CodeBuddy; ByteDance and Trae / TRAE SOLO; SenseTime and Raccoon; Zhipu and ZCode / AutoClaw / AutoGLM; Meituan and CatPaw; Alibaba and Qoder / ModelScope / Accio; Huawei Cloud and CodeArts; iFLYTEK and Loomy; NetEase Youdao and LobsterAI; Xiaomi and MiMo; DeepSeek and DeepSeek Harness; OpenAI and Codex; Google and Antigravity; Cline; and any other service provider mentioned in this document.

All product names, trademarks, service names and protocol names appearing here belong to their respective owners and are used only for identification and explanation, and do not imply any affiliation or authorisation.

### 2. Third-party accounts and platform rules

The Pool Keeper reuses the login state of **your own accounts** on your own machine for balance queries, check-ins and account management. It does not crack or bypass any payment or permission check, and the quota it reads always comes from what your own account already has.

The Local Gateway adds a **loopback-only** API forwarding layer on top: it exposes your own account's quota as an **OpenAI / Anthropic compatible endpoint** on `127.0.0.1` (off by default, loopback-only by default, credentials never leave the local process). The old standalone "reverse proxy gateway" process and its Docker form are no longer maintained and have been removed; the Local Gateway replaces them, and it likewise **no longer tracks upstream protocol or risk-control changes**, with no availability guarantee.

Be clear about this, however: reusing a login state **in the shape of a non-official client** **may not comply with the upstream service's user agreement or terms of use**; whether you use it, and every consequence that follows (including but not limited to rate limiting, risk control, downgrading, freezing or banning of your account, termination of a subscription, or zeroing of points/quota), **is borne solely by you, and the author accepts no responsibility**.

The author has **not retrieved or verified the original terms of each platform one by one**; every statement in this project about "whether platform rules are met" is an inference from observed behaviour and **is not legal advice**. Please read and follow the terms of the services you use before using this project.

### 3. Prohibited uses

You may not use this project for:

- any commercial purpose, redistribution for profit, or selling accounts or quota with this project as the vehicle
- bulk account operation, buying or selling accounts, automated farming of rewards, account warming
- bypassing upstream billing, quota, risk control or permission limits
- attacking, scraping, scanning or disrupting the normal operation of any service
- any other activity that violates local laws or the upstream service's terms

These prohibitions are also written into the "Additional terms of use" in Part 2 of the [LICENSE](./LICENSE) and form part of this project's licence and usage terms — **they are not merely an appeal**.

If you need to call the relevant model services in production or commercially, use the **official channels and official APIs**.

### 4. Credential and data risks

This project needs to read and write account credentials (accessToken / refreshToken, etc.) and local data files of clients already logged in on this machine:

- Credentials are encrypted with Windows DPAPI before touching disk. Encrypted packages produced by pool sync and local backups contain recoverable credentials — keep them safe yourself. "Export selected accounts" in the Pool page exports metadata only (no tokens); do not mistake it for a credential file
- Never commit exported credential files to a public repository, upload them to cloud storage, send them to a chat group or share them with others
- If you bind the service to `0.0.0.0` (for LAN access), every device on the same network can reach it — assess the risk yourself and set per-key daily quotas and rate limits
- "Switch to IDE" closes and rewrites the local client's login state; save your work first
- Any loss caused by credential leakage, someone else using your device, misconfiguration or a wrong operation **is borne solely by you, and the author accepts no responsibility**
- Uninstalling **does not delete** `%APPDATA%\AgentHub`; delete that directory yourself if you want it gone

### 5. No warranty and rights notice

This project is provided "AS IS", and the author **makes no express or implied warranty or guarantee** as to its availability, stability, security, legality, accuracy or fitness for a particular purpose.

- Upstream interfaces, authentication methods and protocol fields may change at any time; this project may stop working at any time and is no longer maintained, and the author has no obligation to update, fix or answer questions
- Any direct or indirect loss caused by using this project (including but not limited to account loss, quota loss, data loss, business interruption, third-party claims, regulatory penalties) **is not the author's responsibility in any way**
- Interface shapes and protocol fields in this project come from **observing and organising the public network traffic of the official clients**, for learning and research only; the rights to the relevant trademarks and services belong to their respective owners
- If a rights holder believes this project is inappropriate, please contact the author and it will be adjusted or removed promptly

**The complete terms are in [LICENSE](./LICENSE).** If you disagree with any part of this section, stop using the project immediately and delete it and its related data.

---

## Full statement

> This is the complete statement for using this project and is consistent with the [Disclaimer](#disclaimer) above; **where they differ, the [LICENSE](./LICENSE) prevails**.

### For learning and exchange only

This project is a hands-on project for learning **local credential management, multi-upstream account and quota aggregation, HTTP reverse proxying with SSE streaming pass-through, OpenAI / Anthropic protocol adaptation, cross-tool skill directory management and Electron desktop packaging**. It is for personal learning and research only. It is not an official product and is **not affiliated with** the following companies or their products in any way, and has not received their authorisation, endorsement or sponsorship:

Tencent and WorkBuddy / CodeBuddy, ByteDance and Trae / TRAE SOLO, SenseTime and Raccoon, Zhipu and ZCode / AutoClaw / AutoGLM, Meituan and CatPaw, Alibaba and Qoder / ModelScope / Accio, Huawei Cloud and CodeArts, iFLYTEK and Loomy, NetEase Youdao and LobsterAI, Xiaomi and MiMo, DeepSeek and DeepSeek Harness, OpenAI and Codex, Google and Antigravity, Cline, and any other service provider mentioned in the documentation, code or UI.

All product names, trademarks, service names and protocol names belong to their respective owners and are used only for identification and explanation.

### About the reverse-proxy behaviour

This project implements a **local reverse proxy**: the Pool Keeper reuses the login state of **your own accounts** on your own machine for balance queries, check-ins and account management; the Local Gateway then exposes that quota as an **OpenAI / Anthropic compatible endpoint** on `127.0.0.1` (off by default, loopback-only by default, credentials never leaving the local process) and forwards requests to the official upstream gateway.

It does not crack or bypass any payment or permission check, and the quota used always comes from what your own account already has. Be clear, however, that forwarding a login state **in the shape of a non-official client** **may not comply with the upstream service's user agreement or terms of use**; whether you use it and every consequence that follows (including but not limited to rate limiting, risk control, downgrading, freezing or banning of your account, termination of a subscription, or zeroing of points/quota) **is borne solely by you, and the author accepts no responsibility**.

### Prohibited uses

Do not use this project for any commercial purpose, redistribution for profit, selling accounts or quota with this project as the vehicle, bulk account operation, automated farming of rewards, account warming, bypassing upstream billing or quota limits, attacking or disrupting the normal operation of any service, or any other activity that violates local laws or upstream terms.

If you need to call the relevant model services in production or commercially, use the **official channels and official APIs**.

### No warranty and rights notice

This project is provided "AS IS" and the author makes no commitment as to its availability, stability, security or fitness for a particular purpose. Upstream interfaces may change at any time and the project may stop working at any time without further maintenance.

Interface shapes and protocol fields in this project come from **observing and organising the public network traffic of the official clients**, for learning and research only; the rights to the relevant trademarks and services belong to their respective owners. If a rights holder believes this project is inappropriate, please contact the author and it will be adjusted or removed promptly.

**The complete terms are in [LICENSE](./LICENSE).** If you disagree with any part of this statement, stop using the project immediately and delete it and its related data.


