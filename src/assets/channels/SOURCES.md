# 渠道图标来源台账

本目录是号池渠道 / 技能工具图标的唯一素材来源，映射代码见 `src/views/proxy/channelIcons.ts`。
**图形全部取自 Agent2API 官方 provider 图标**（与官网插件目录 `plugin-assets` 逐字节相同），
因此与 Agent2API 本体及各插件里显示的完全一致；版权归各厂商，仅作渠道识别。

双区 / 双池（`*_intl`、`cline_pass`、`accio_cn` 等）与官方一致：共用同一张图，靠卡片名称区分地区，
不再自绘地区角标 —— 自绘版本无法随官方更新，且会与官方显示不一致。

刷新方式：`node tools/sync-channel-icons.cjs`（素材源位置见该脚本头部注释）。

| 渠道文件 | 官方 provider id | 图形 | 尺寸 | 字节 | SHA-256(前10) | 素材源 |
| --- | --- | --- | --- | --- | --- | --- |
| `accio.png` | `accio` | PNG | 256×256 | 14760 | `48D2E2A0C0` | Agent2API providers |
| `accio_cn.png` | `accio-cn` | PNG | 256×256 | 14760 | `48D2E2A0C0` | Agent2API providers |
| `antigravity.png` | `antigravity` | PNG | 256×256 | 22764 | `C06ADDCCE9` | Agent2API providers |
| `astudio.png` | `astudio` | PNG | 256×256 | 41999 | `993D738230` | Agent2API providers |
| `atomcode.png` | `atomcode` | PNG | 256×256 | 66478 | `3A2296873F` | Agent2API providers |
| `autoclaw.png` | `autoclaw` | PNG | 256×256 | 24031 | `303477B5E0` | Agent2API providers |
| `autoclaw_intl.png` | `autoclaw-intl` | PNG | 256×256 | 24031 | `303477B5E0` | Agent2API providers |
| `catpaw.png` | `catpaw` | PNG | 256×256 | 25222 | `572AE6BAD6` | Agent2API providers |
| `cline_free.png` | `cline-free` | PNG | 256×256 | 59248 | `0BB73A3714` | Agent2API providers |
| `cline_pass.png` | `cline-pass` | PNG | 256×256 | 59248 | `0BB73A3714` | Agent2API providers |
| `codearts.png` | `codearts` | PNG | 256×256 | 29390 | `90A52805BC` | Agent2API providers |
| `commandcode.png` | `commandcode` | PNG | 180×180 | 3226 | `521240E542` | Agent2API providers |
| `doubaowork.png` | `doubaowork` | PNG | 256×256 | 54244 | `276BDA105C` | Agent2API providers |
| `kiro.svg` | `kiro` | SVG | 矢量 | 1252 | `CCDDA289C7` | agent2api.dev plugin-assets |
| `kuku.png` | `kuku` | PNG | 256×256 | 10404 | `5B37CBFDE3` | Agent2API providers |
| `lobster.png` | `lobsterai` | PNG | 256×256 | 46677 | `64731FEB94` | Agent2API providers |
| `loomy.png` | `loomy` | PNG | 228×228 | 71494 | `2ED89C3313` | Agent2API providers |
| `minimax.svg` | `minimax-code` | SVG | 矢量 | 1803 | `52EFD99472` | Agent2API providers |
| `modelscope.png` | `modelscope` | PNG | 256×256 | 10280 | `40C1BCABDC` | Agent2API providers |
| `modelscope_intl.png` | `modelscope-intl` | PNG | 256×256 | 10280 | `40C1BCABDC` | Agent2API providers |
| `monkeycode.png` | `monkeycode` | PNG | 256×256 | 30063 | `4AD40125F0` | Agent2API providers |
| `officeace.png` | `officeace` | PNG | 256×256 | 27613 | `6FF61968D9` | Agent2API providers |
| `orcaterm.png` | `orcaterm` | PNG | 192×192 | 10004 | `8645CF7FAA` | Agent2API providers |
| `qoder.png` | `qoder` | PNG | 256×256 | 7609 | `AE5B98B0B0` | Agent2API providers |
| `qwen_office.svg` | `qwenwork` | SVG | 矢量 | 2344 | `963AE50156` | agent2api.dev plugin-assets |
| `qwen_office_intl.svg` | `qwenwork-intl` | SVG | 矢量 | 2344 | `963AE50156` | agent2api.dev plugin-assets |
| `raccoon.png` | `raccoon` | PNG | 256×256 | 55660 | `2649D5B627` | Agent2API providers |
| `trae.png` | `trae` | PNG | 48×48 | 488 | `49D523938A` | Agent2API providers |
| `workbuddy.png` | `workbuddy` | PNG | 256×256 | 23166 | `E4C96F3305` | Agent2API providers |
| `zcode.png` | `zcode` | PNG | 256×256 | 33410 | `AD0E1D32FE` | Agent2API providers |
