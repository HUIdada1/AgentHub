# 预设渠道图标来源

本目录的图标仅用于「本地网关 · 自定义提供商」的渠道识别，**版权归各厂商所有**。
素材取自参考项目 ZCode 的 `packages/ui/src/assets/provider-icons/`，其
`model-provider-logo-sources.json` 记录了每个文件的官方出处，下表摘录 `sourceUrl` 与 `sourceOwner`。

| brand | 源文件名 | sourceOwner | sourceUrl |
| --- | --- | --- | --- |
| `bigmodel` | `logo-bigmodel.svg` | BigModel | `repository-existing:logo-bigmodel.svg`（项目内既有透明 16×16 蓝色渐变矢量） |
| `zai` | `model-provider-zai-app.png` | Z.AI | `repository:packages/desktop/build/icons/128x128.png` |
| `kimi` | `model-provider-moonshot-kimi.png` | Moonshot AI | https://raw.githubusercontent.com/MoonshotAI/Branding-Guide/67b20b1315f96d05f3192b24050635745abd3d90/scenarios/03-icon-without-kimi/kimi-icon-right-angle.png |
| `minimax` | `model-provider-minimax.png` | MiniMax | https://file.cdn.minimax.io/public/MiniMax_Logo.zip |
| `deepseek` | `model-provider-deepseek.png` | DeepSeek | https://github.com/deepseek-ai.png?size=512 |
| `bailian` | `model-provider-alibaba-cloud.png` | Alibaba Cloud | https://github.com/aliyun.png?size=512 |
| `mimo` | `model-provider-xiaomi-mimo.png` | Xiaomi MiMo | https://platform.xiaomimimo.com/static/logo.5c3d18dc51d9cbea.jpg |
| `tokenhub` | `model-provider-tencent-cloud.png` | Tencent Cloud | https://github.com/TencentCloud.png?size=80 |
| `volcengine` | `model-provider-volcengine.png` | volcengine | https://github.com/volcengine.png?size=80 |
| `stepfun` | `model-provider-stepfun.png` | stepfun-ai | https://github.com/stepfun-ai.png?size=80 |
| `openai` | `model-provider-openai.png` | OpenAI | https://images.ctfassets.net/j22is2dtoxu1/intercom-img-d177d076c9a5453052925143/49d5d812b0a6fcc20a14faa8c629d9fb/icon-ios-1024_401x.png |
| `anthropic` | `model-provider-anthropic.png` | Anthropic | https://cdn.prod.website-files.com/67ce28cfec624e2b733f8a52/67d31dd7aa394792257596c5_webclip.png |
| `xai` | `model-provider-xai.png` | xAI | https://avatars.githubusercontent.com/u/130314967?v=4 |
| `siliconflow` | `model-provider-siliconflow.png` | siliconflow | https://github.com/siliconflow.png?size=80 |
| `openrouter` | `model-provider-openrouter-light.svg` / `model-provider-openrouter-dark.svg` | OpenRouter | https://openrouter.ai/brand/logos/transparent/glyph/svg/glyph-grape-square.svg （深色：`glyph-volt-square.svg`） |
| `opencode` | `model-provider-opencode-light.svg` / `model-provider-opencode-dark.svg` | OpenCode | https://opencode.ai/brand |

- `openrouter` / `opencode` 各保留 `-light` / `-dark` 两份；当前界面只用 light 版（与 `views/proxy/channelIcons.ts` 一致，不做主题切换）。
- `tokenrhythm`（基元律动 TokenRhythm）没有官方素材，不落图，界面走首字母徽章兜底。

素材仅作渠道识别，版权归各厂商；任一厂商要求下架则删单个文件并回落首字母徽章。
