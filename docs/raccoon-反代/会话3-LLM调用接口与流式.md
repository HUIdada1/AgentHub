# 会话3：LLM 调用接口与流式协议（独立审查）

> 审查对象：box-agent（PyInstaller/Python 3.12，`box_agent/llm/*`）+ Electron 主进程（`build/electron/main/*`）+ 桌面渲染层 chunks。
> 证据来源全部为静态反汇编/反编译，未做真实抓包。凡是只能推断、未能静态坐实的点都明确标注 **未确认/需抓包验证**。

---

## 0. 结论速览

- 上行 LLM 走 **OpenAI Chat Completions 兼容协议**，端点 `POST {api_base}/chat/completions`，官方 api_base = `https://xiaohuanxiong.com/api/web/llm/v2`。
- 流式是标准 OpenAI SSE：`stream:true` + `stream_options.include_usage:true`，**usage 统计在最后一个携带 `usage` 字段的 chunk 里**（客户端从 chunk.usage 里取，而不是单独事件）。
- 上行请求体**只有 6 个字段**（messages / max_tokens / stream / stream_options / model / tools）+ 条件性的 `reasoning_effort` 或 `extra_body`。**对默认模型 `raccoon-chat-ml-5-5` 且 thinking 关闭时，不传任何 reasoning/extra_body 参数**（推翻了总纲里"extra_body 双层嵌套必发"的印象——双层嵌套只在 deepseek/doubao/qwen 等第三方模型分支出现）。
- SenseNova 私有方言（XML 伪 tool_calls、reasoning_content 重放）只在**模型名带 `sensenova-`/`sn-` 前缀或命中回放名单**时触发；`raccoon-chat-ml-5-5` 不在其中（未确认 `raccoon-chat-ml-5-5` 上游是否内部映射到 sensenova，但从客户端视角它就是标准 OpenAI 协议）。
- 反代只要 1:1 透传 OpenAI 协议即可，**无需实现 SenseNova 方言**（那是客户端在收到响应后的后处理，不是上行协议）。
- 模型清单走独立端点 `GET {api_base}/model_catalog`，返回带计费倍率的模型数组。
- 图片生成走 `POST {endpoint}`（默认 `…/llm/v2/images/gen`），**非流式**，JSON 请求/响应或二进制图片直返。

---

## 1. LLM 接口完整规格

### 1.1 端点与方法

| 用途 | 方法 | 路径（相对 api_base） | 说明 |
|---|---|---|---|
| 聊天（非流式） | POST | `/chat/completions` | OpenAI SDK `chat.completions.with_raw_response.create`，body 无 `stream` |
| 聊天（流式） | POST | `/chat/completions` | 同上，body `stream:true` + `stream_options:{include_usage:true}` |
| 模型清单 | GET | `/model_catalog` | 渲染层 `fetchWithAuth` 调用，10s 超时 |
| 文生图 | POST | 独立 endpoint，默认 `…/llm/v2/images/gen` | 非流式，JSON |
| 图生图/编辑 | POST | 由 gen endpoint 派生（`/images/edits`） | multipart/form-data |

api_base 规范化（渲染层 `7476-…js` 模块 8742）：去掉尾部 `/`，若路径以 `/chat/completions` 结尾则截掉这 17 字符，以 `/messages` 结尾截掉 9 字符。provider 判定：URL 路径以 `/messages` 结尾 → anthropic，否则 openai。

### 1.2 上行请求头（每个 LLM 请求都带）

来自 `box_agent/llm/base.pyc` `_auth_headers` / `_request_headers` / `_agent_headers`：

| Header | 取值 | 证据 |
|---|---|---|
| `Authorization` | `Bearer <access_token>`（hosted 模式 api_key 是占位符 `box-agent-no-auth`/`box-agent-auth-json`，真实鉴权走 auth.json 的 JWT） | base.pyc `_auth_headers`（`Bearer ` 常量）、`request_auth_headers(auth_file,…)` |
| `X-Org-Code` | 团队版 org code（从 auth.json 读，有才带） | base.pyc `_auth_headers` 仅 `should_attach_client_headers(api_base)` 为真时附加 |
| `X-RACCOON-Session-ID` | 会话 ID（ASCII，非 ASCII 会 UTF-8 编码后附加） | base.pyc `_agent_headers` |
| `X-RACCOON-Turn-ID` | 轮次 ID | 同上 |
| `X-RACCOON-Title` | 会话标题 | 同上 |
| `X-RACCOON-Call-Kind` | 调用类型 | 同上 |
| `x-client-name` / `x-client-platform` / `x-client-version` / `x-client-os-version` / `x-client-channel` / `x-client-device-id` | 见总纲；由 `current_client_headers(api_base)` 合并 | base.pyc `_request_headers` + `client_info.current_client_headers` |

注意：`_request_headers` 在 `should_attach_client_headers(api_base)` 为假时直接返回空 dict —— 即**非官方域名不附带任何 x-client-* 指纹头**。反代自建域名时这些头不会出现。

OpenAI SDK 自身还会带：`User-Agent: AsyncOpenAI/Python <ver>`、`Accept: application/json`（非流式）/`text/event-stream`（流式）、`Content-Type: application/json`。（SDK 行为，未在反汇编中逐一列出，属 OpenAI SDK 常识。）

### 1.3 chat/completions 请求体（流式，证据：openai_client.pyc `generate_stream` 反汇编）

```jsonc
{
  "messages": [ /* 见 1.4 */ ],
  "max_tokens": 80000,            // = max_output_tokens；hosted 默认 80000，自建默认 63999/64000
  "stream": true,
  "stream_options": { "include_usage": true },
  "model": "raccoon-chat-ml-5-5", // 仅在 self.model 非空时写入
  "tools": [ /* 见 1.5；仅当 tools 非空 */ ],
  // 条件字段（_apply_thinking_params，按模型名分支）：
  "reasoning_effort": "high",      // 命中 kimi-k3 / glm-5-3 / gemini / 兜底分支且 thinking_enabled 时
  "extra_body": { /* 仅 deepseek/doubao/qwen 分支，见 3.3 */ },
  "extra_headers": { /* 鉴权头注入到这里，由 SDK 提升为 HTTP 头，不进 body */ }
}
```

反汇编原文（`generate_stream` line 985-989，见 `_scratch/dis_stream.txt`）：

```
LOAD_CONST (('messages', 'max_tokens', 'stream', 'stream_options'))
BUILD_CONST_KEY_MAP 4      # stream_options = {'include_usage': True}
```

- `max_tokens` 取值链：`_consume_effective_max_tokens()` = `max(ephemeral_cap, self.max_output_tokens)`；`max_output_tokens` 来自 model profile（hosted=80000）或 config（默认 64000）。`set_ephemeral_max_output_tokens` 只对**下一次**请求生效，用完即清。
- 非流式 `generate()` → `_make_api_request`：body 只有 `{messages, max_tokens, model?, tools?}`，**无 stream/stream_options**（`dis_openai_req.txt` line 35-52）。
- 请求体大小预检：`_bound_request_body` → `prepare_image_request(params, limit)`，hosted 模式 limit = `HOSTED_MAX_REQUEST_BODY_BYTES = 10,000,000` 字节（image_payload.pyc line 18）。超限抛 `RequestBodyTooLargeError`（错误串 `REQUEST_BODY_TOO_LARGE: …`），**请求不会发出**。

### 1.4 messages 结构（`_convert_messages`）

内部 Message → OpenAI 格式的映射（`dis_convert.txt`）：

| 内部 role | 输出 |
|---|---|
| `system` | `{"role":"system","content":<str>}`（放在 messages 数组内，不单独抽 system 字段） |
| `user` | `{"role":"user","content":<str 或 content-block 数组>}`；图片 block 由 `_convert_input_content` 转成 OpenAI vision 格式：`{"type":"image_url","image_url":{"url":"data:<media_type>;base64,<data>"}}`，仅允许 `image/png`、`image/jpeg` |
| `assistant` | `{"role":"assistant","content":<str 或 ''>}` + 可选 `tool_calls:[{"id","type":"function","function":{"name","arguments":<json 字符串>}}]` + 可选 reasoning 重放字段（见 3.4） |
| `tool` | `{"role":"tool","tool_call_id":<id>,"content":<str>}` |

**reasoning 重放规则**（`_convert_messages` line 742-749 + 模块常量 `_REASONING_CONTENT_REPLAY_MODELS`）：

```python
_REASONING_CONTENT_REPLAY_MODELS = {
  'https://xiaohuanxiong.com/api/web/llm/v2':        frozenset({'sn-deepseek-v4-pro','sn-glm-5-2','sn-glm-5-3-flash','sn-sensenova-6-8-flash-lite'}),
  'https://code-stage.xiaohuanxiong.com/api/web/llm/v2': frozenset({'sn-kimi-k3'}),
}
```

- 当 api_base（去尾 `/`）命中上表 **且** 当前 model 在对应集合里：assistant 历史消息的 thinking 以 `reasoning_content` 字段原样回放。
- 否则：thinking 回放为 `reasoning_details: [{"text": <thinking>}]`（OpenRouter 风格）。
- `raccoon-chat-ml-5-5` 不在两个集合里 → 走 `reasoning_details` 分支（仅当该消息确实带 thinking 时才有此字段）。

### 1.5 tools 结构（`_convert_tools`）

输出标准 OpenAI function 工具：

```jsonc
{"type":"function","function":{"name":..., "description":..., "parameters": <input_schema JSON Schema>}}
```

- 若传入已是 `{"type":"function", ...}` dict → 原样透传；
- 若传入 `{name, description, input_schema}` → 组装成上述结构；
- 若对象有 `to_openai_schema()` → 调用之；
- 其他类型抛 `TypeError: Unsupported tool type: ...`。

### 1.6 响应结构（非流式，`_parse_response`）

读 `choices[0].message`：`content`（str，缺省 ''）、thinking 从别名 `reasoning` / `reasoning_content` 取（`_reasoning_text_from_aliases`），再兜底 `reasoning_details[].text` 拼接；`tool_calls[]` 的 `function.arguments` 用 `json.loads` 解析；`finish_reason` 缺省 `'stop'`；`usage` 从 `response.usage.{prompt_tokens,completion_tokens,total_tokens}` 读，组装成内部 `TokenUsage{prompt_tokens, completion_tokens, total_tokens, input_tokens=prompt_tokens, output_tokens=completion_tokens}`；`response.id` 记为 provider_response_id。

---

## 2. 流式协议（SSE）

### 2.1 上行

见 1.3。流式通过 OpenAI SDK 的 SSE 解析，即上游返回 `Content-Type: text/event-stream`，事件为 `data: {json}\n\n`，终止 `data: [DONE]`（SDK 标准行为，**未在反汇编中显式出现，属 SDK 内部，标未确认**）。

### 2.2 客户端解析逻辑（`generate_stream` 主循环，`dis_stream.txt`）

按 chunk 处理：

1. **usage**：任一 chunk 带 `usage` 字段即覆盖式记录 `TokenUsage`（同上五字段）。→ **usage 在流中靠 `stream_options.include_usage` 让上游在末尾 chunk 下发**，客户端取最后一次出现的值。反代必须原样透传该 chunk，不能吞掉。
2. **finish_reason**：`choices[0].finish_reason` 出现即记录（覆盖式）。
3. **thinking 增量**：`choices[0].delta.reasoning` 或 `delta.reasoning_content`（别名兼容），逐段累加并产出内部 `StreamEvent{type:'thinking', delta}`。
4. **text 增量**：`delta.content` 累加，产出 `StreamEvent{type:'text', delta}`。
   - **SenseNova 缓冲**：当模型是 sensenova 且本次带 tools 时，开头会缓冲 text，直到确认它不是 `<tool_call>` 前缀才放出（防 XML 标记泄漏到正文）。
5. **tool_calls 增量**：`delta.tool_calls[]` 按 `index` 聚合到 `tool_acc`：`id`、`function.name` 覆盖式写入，`function.arguments` **字符串追加**。arguments 长度超 `streamed_argument_limit(name)`（按工具名限长，见 tools/argument_limits）→ 本地截断：finish_reason 置 `tool_argument_limit`，记录 oversized_tool_calls 并关闭流。
6. **结束**产出 `StreamEvent{type:'finish', finish_reason, usage, tool_calls, provider_response_id, provider_request_id, truncated_tool_calls, raw_finish_reason, stream_dropped_mid_tool}`。

### 2.3 finish_reason 取值（客户端会处理/改写）

| 值 | 来源 |
|---|---|
| `stop` / 上游原值 | 透传 |
| `length` / `max_tokens` | 上游；且这两个值允许客户端做"结构性闭合"（修复未闭合的 JSON tool arguments） |
| `tool_calls` | 上游，或 SenseNova XML 伪 tool 恢复成功后客户端改写 |
| `tool_argument_limit` | 客户端本地截断产生（非上游） |

### 2.4 断流与重连

- 打开流失败（`_open_stream` 抛异常）：在 `retry_config.enabled` 时最多 `max_retries+1` 次（默认 3+1=4 次；RetryConfig: enabled=True, max_retries=3, initial_delay=1.0s, max_delay=60.0s，指数退避，见 config.pyc RetryConfig 类反汇编），条件 `is_retryable_llm_error(exc) and is_retryable_stream_error(exc)`，**从头重新发起整个请求**（非续传）。
- 流中途断（已产出过内容）：`openai stream interrupted after partial yield ...` 直接报错，不自动续传。
- 工具参数流半截断（`truncated_tool` 且 raw_finish_reason 非 None）→ `stream_dropped_mid_tool=True` 并上报。

**反代含义**：断流重连由客户端负责（整请求重发），反代自己若做重连必须保证幂等（同一 prompt 重发会重复计费/重复生成——注意）。

---

## 3. SenseNova 私有方言

### 3.1 判定（`_is_sensenova_model` / `_sensenova_model_prefixes`）

```python
_DEFAULT_SENSENOVA_MODEL_PREFIXES = ('sensenova-', 'sn-sensenova-')   # 可用 env BOX_AGENT_SENSENOVA_MODEL_PREFIXES 追加（逗号/空白分隔）
边界字符集: '-_/:.'   # 前缀后必须紧跟边界字符
```

`raccoon-chat-ml-5-5` **不命中** → 官方托管模型的客户端视角就是纯 OpenAI 协议。

### 3.2 reasoning（思考）参数（`_apply_thinking_params`）

按规范化后的 model 名依次匹配，**先中先生效**：

| 匹配（大小写不敏感） | thinking_enabled=True | thinking_enabled=False |
|---|---|---|
| `(?:^|/)(?:sn-)?kimi-k3(?:$|[-:])` | `reasoning_effort:"high"` | `reasoning_effort:"low"` |
| 含 `glm-5-3` 或 `glm-5.3` | `reasoning_effort:"high"` | `reasoning_effort:"low"` |
| 含 `deepseek` 或 `doubao` | `extra_body:{"thinking":{"type":"enabled"}}` | `extra_body:{"thinking":{"type":"disabled"}}`（双层嵌套，见 3.3） |
| 含 `qwen` | `extra_body:{"enable_thinking":true}` | `...false`（**单层**，直接 `params['extra_body'] = {'enable_thinking': bool}`） |
| 含 `gemini` | `reasoning_effort:"high"`（_DEEP_THINK_REASONING_EFFORT） | 命中 `gemini-2.5-pro`/`gemini-3.1-pro` 时不动；否则 `reasoning_effort = reasoning_effort_when_disabled or "none"` |
| 兜底：thinking_enabled=True | `reasoning_effort:"high"` | — |
| sensenova 模型 & thinking off | `reasoning_effort = reasoning_effort_when_disabled or ("low" if model in {'sensenova-flash-lite-20260727-v39-fp8-step4k-dpov2-mtp'} else "none")` | 同左 |

**对 `raccoon-chat-ml-5-5`**：thinking on → `reasoning_effort:"high"`；thinking off → **什么都不加**（不命中任何分支，且非 sensenova）。

`reasoning_effort_when_disabled` 仅允许 `null | "none" | "low"`（`__init__` 校验），来自 model profile 的 `reasoningEffortWhenDisabled` 字段。

### 3.3 extra_body 双层嵌套（`_litellm_extra_body`）

```python
def _litellm_extra_body(payload): return {'extra_body': payload}
```

docstring 原文："The OpenAI SDK merges its own `extra_body` argument into the HTTP body. LiteLLM expects another provider-owned `extra_body` object inside that body, so the SDK argument intentionally has two levels."

即：`params['extra_body'] = {'extra_body': {'thinking': {...}}}` → SDK 把外层并入 HTTP body → **线上 body 实际是单层** `"extra_body": {"thinking": {...}}`。"双层"指 Python 侧 SDK 参数的嵌套，不是线上两层。**这强烈暗示上游是 LiteLLM 网关**。反代透传时照原样转发 body 即可，无需理解嵌套。

### 3.4 XML 伪 tool_calls 恢复（`_recover_sensenova_pseudo_tool_calls`）

仅 sensenova 模型、且上游没给原生 `tool_calls` 时触发。来源：thinking 为空时的 text_content，或 `_is_sensenova_tool_only_content` 判定为"全文只有 tool 标记"的 text。

正则（模块常量）：

```
_SENSENOVA_PSEUDO_TOOL_CALL_RE = re.compile(r'<tool_call>\s*<function=([A-Za-z_][\w.-]*)>\s*(.*?)\s*</function>\s*</tool_call>', re.DOTALL)
_SENSENOVA_PSEUDO_PARAMETER_RE = re.compile(r'<parameter=([A-Za-z_][\w.-]*)>\s*(.*?)\s*</parameter>', re.DOTALL)
_MAX_RECOVERED_SENSENOVA_TOOL_CALLS = 4
```

恢复出的 ToolCall：`id = "sensenova_recovered_" + uuid4().hex`，`type="function"`，参数按声明的 JSON Schema 类型强转（`_coerce_pseudo_parameter`），arguments 超长（按工具名限长）则丢弃该条。恢复成功 → finish_reason 改为 `tool_calls`，若来源是正文则清空 text_content。

另有 `_repair_tool_call_arguments`：修未转义控制字符、去尾逗号（`,\s*([}\]])` → `\1`）、finish_reason 为 length/max_tokens 时做结构性括号闭合。

**反代结论**：以上全部是**客户端后处理**。上游（反代）只需返回标准 OpenAI 格式；若上游模型本身吐 XML 伪调用，客户端会自己恢复。反代不需要实现这套方言，但若反代后端接的是同款 SenseNova 模型，让 XML 原样流过即可被客户端正确恢复。

---

## 4. 模型清单与路由

### 4.1 模型目录端点

```
GET {api_base}/model_catalog        # 渲染层 fetchWithAuth，timeout 10s
```

响应解析（47108 chunk，已反混淆）：

```jsonc
{
  "default_model": "raccoon-chat-ml-5-5",   // 必须在 models 里存在，否则取 models[0]
  "models": [
    {
      "name": "...",                         // 必填，去重键
      "description": "...",
      "display_description": "...",
      "visible": true,
      "tags": ["vision", ...],               // "image"/"image-understanding" 会被归一为 "vision"；最多 32 个
      "ability_level": 1,                    // int 1..10，缺省 1
      "params": {"context_window": 180000, "max_tokens": 80000},
      "context_window": ...,                 // params 优先
      "points_multiplier": 1.0,
      "billing_multiplier": 1.0,
      "billing_effective_multiplier": 1.0,
      "billing_status": "normal"|"discount"|"limited_free",
      "billing_status_note": "...",
      "billing_discounts": [{"name","multiplier","daily_start","daily_end","start_at","end_at","active"}]
    }
  ]
}
```

**当前线上有哪些模型名：未确认/需抓包验证**。静态证据只坐实 `raccoon-chat-ml-5-5`（默认），以及渲染层别名：`raccoon-chat` / `raccoon-chat-ml` → 都映射到 `raccoon-chat-ml-5-5`（97245 模块：显示用 `raccoon-chat`，提交用 `raccoon-chat-ml-5-5`）。SenseNova 常量中出现的名字（`sn-deepseek-v4-pro`、`sn-glm-5-2`、`sn-glm-5-3-flash`、`sn-sensenova-6-8-flash-lite`、`sn-kimi-k3`、`sensenova-flash-lite-20260727-v39-fp8-step4k-dpov2-mtp`）是**历史/兼容代码里的重放与方言名单**，不代表当前目录里一定有。

### 4.2 模型与 provider 的映射

Electron `modelProfileRegistry.js`（hosted 判定走 `hostedGateway.isOfficialHostedGatewayUrl`）：

```
profileId    = "hosted:" + sha256(apiBase)[:16]        # 官方网关
             | activeSavedModelId 或 "custom:" + sha256(provider:apiBase:model)[:16]
provider     = "anthropic" | "openai"（其余一律归一为 openai）
apiKey       = hosted ? "box-agent-auth-json" : 用户 key
authFile     = hosted ? ~/.box-agent/config/auth.json : ""
contextWindow 默认 180000（profile 层；UI 层默认 256000）
maxTokens    默认 hosted 80000 / 自建 63999
timeout      1200 (s)
profileRevision = sha256(JSON(profile 无 revision 字段))
```

实际落盘样例（`C:\Users\HUIDADA\.box-agent\config\model-profiles.json`）：provider=openai，apiBase=`https://xiaohuanxiong.com/api/web/llm/v2`，defaultModel=`raccoon-chat-ml-5-5`，contextWindow=180000，maxTokens=80000，timeout=1200。

box-agent 侧 `model_profiles.client_for_model_profile` 用 binding 里的 `model`/`maxTokens` 覆盖 profile 的 `defaultModel`/`maxTokens` 构造 `LLMClient`。

### 4.3 自动路由（auto routing）

- 宿主（Electron）通过 ACP 元数据把 `auto_model_candidates` 下发给 box-agent（`boxAgentManager.js normalizeLocalAgentAutoRouting`）：每个候选 `{model, tags[], abilityLevel(1..10), contextWindow?, maxTokens?}`，最多 64 个。
- box-agent `model_routing.select_auto_model` 按任务文本正则打分选模（办公/邮件/文档/PDF/生图 等中文关键词加权，vision 需求硬性过滤）。这是**客户端本地路由**，决定往上游发哪个 model 名；上游只负责认得这些名字。
- 路由模式 `manual`（固定模型）或 `auto`（候选池）。

---

## 5. 图片生成接口（`generate_image` 工具）

`box_agent/tools/image_generation_tool.pyc`：

### 5.1 文生图 `_request_image`

```
POST {endpoint}                      # 默认 https://xiaohuanxiong.com/api/web/llm/v2/images/gen（config.yaml image_generation.endpoint）
Headers: Accept: application/json, image/*
         Authorization: Bearer <api_key>          # 有 api_key 时；否则 request_auth_headers(auth_file, existing, url)（hosted 用 JWT）
JSON body: {"model": <model>, "prompt": <prompt>, "size": "<W>x<H>"}   # prompt 由 _compose_openai_prompt 拼入 style/negative_prompt
```

- size 归一化：OpenAI 服务限定 `1024x1024/1536x1024/1024x1536`；seedream/doubao 有预设表（`_SEEDREAM_PRESETS`）；host 对齐服务按 `_CANONICAL_IMAGE_RATIOS` 取整。最大边 `BOX_AGENT_IMAGE_MAX_DIM` env > 配置 > 内置默认。
- 超时：`image_generation.timeout`（配置样例 1000s）或 env `BOX_AGENT_IMAGE_GENERATION_TIMEOUT`。

### 5.2 图生图 `_request_image_edit`

```
POST {edit_endpoint}                 # _derive_edit_endpoint：gen endpoint 派生 "/images/edits"
multipart/form-data:
  data:  {"prompt": ..., "size": ...}
  files: image[] = (文件名, bytes, mime)   # 每张参考图一个 image 字段，仅允许 image/* mime
```

### 5.3 响应解析 `_image_from_response`

- `Content-Type: image/*` → 直接取 body 字节；
- 否则按 JSON 解析，`_find_first_image_payload` 在常见字段里找第一个图：`b64_json` / `base64` / `url` / `image_url`（或嵌套），`base64` 直接解码，`url` 二次 GET 下载（校验 content-type）；
- 都没有 → `ValueError: service response did not contain image bytes, b64_json, base64, url, or image_url`。

**反代含义**：images/gen 是非流式普通 POST，透传无坑；响应两种形态都要支持。

---

## 6. 错误与限额

### 6.1 错误分类表（`error_messages.pyc _RULES`，客户端按字符串/状态码匹配）

| 类别 | 触发关键字/码 | 用户文案（中文） | 可重试 |
|---|---|---|---|
| request_body_too_large | request_body_too_large / request body exceeds / payload too large / request entity too large | 本次请求超过接口大小限制… | 否 |
| content_filter（软错误） | content_filter / content management policy / data_inspection_failed / risk_control / inappropriate / flagged | 抱歉，这个问题我不了解相关信息… | 否 |
| auth | invalid api key / invalid_api_key / authentication / unauthorized / 401；**业务码 200003 = authorization_verify_error（provider 授权失败）** | API 密钥无效或未通过鉴权 | 否（但 hosted 模式会先刷新 token 重试一次，见 `_call_with_hosted_auth_retry`） |
| permission | permission_denied / 403 / access denied | 当前账号无权访问该模型或接口（403） | 否 |
| rate_limit | rate limit / too many requests / **429** / tpm / rpm | 请求过于频繁，已触发服务限流（429） | **是** |
| quota | insufficient_quota / exceeded your current quota / insufficient_points / **1000007** / billing / arrearage / balance / 积分不足 / 余额 / 欠费 | 账户额度不足或欠费 | 否 |
| context_length | context_length_exceeded / maximum context / too long / max_tokens / input prompt token len | 对话内容过长，超出模型上限 | 否 |
| model_not_found | model_not_found / does not exist / no such model / unknown model | 指定的模型不存在或当前账号不可用 | 否 |
| model_configuration | "supported api model names are" / "supported model names are" / "unsupported model" / "model ... is not supported" / "but you passed" | 当前配置的模型不受支持… | 否 |
| endpoint_not_found | 404 page not found / not found: / | 模型接口返回 404… | 否 |
| server_error | internal server error / 500 / 502 / 503 / 504 / bad gateway / service unavailable / overloaded | 当前服务暂时不可用 | **是** |
| timeout | timeout / timed out / deadline | 请求模型服务超时 | **是** |
| connection | connection error / refused / reset / failed to establish / name resolution / 网络 | 无法连接到模型服务 | **是** |

`_RETRYABLE_CATEGORIES = {rate_limit, timeout, server_error, connection}`；`_NON_RETRYABLE = {context_length, model_configuration, endpoint_not_found, quota, auth, content_filter, model_not_found, permission, request_body_too_large}`；软错误 `{content_filter}`。

hosted 鉴权拒绝（401 / 200003）会触发"刷新 token 后整体重放一次"（`_call_with_hosted_auth_retry` + `bindWithOneRefresh` 模式一致）。

### 6.2 token 计量

`token_meter.pyc`：ContextVar 作用域累计器，每次 `record_usage(TokenUsage{prompt_tokens, completion_tokens, total_tokens})` 折叠进本轮累计。**数据源就是流式末尾 usage chunk / 非流式响应 usage**，客户端不做本地估算（路由里的 `estimated_input_tokens` 是另一处本地估算，用于选模不是计费）。

### 6.3 请求体限额

- hosted：单请求 body ≤ **10,000,000 字节**（`HOSTED_MAX_REQUEST_BODY_BYTES`），超限本地预检直接拒绝（不发请求）。图片会先被 `prepare_image_request` 压缩/转 JPEG 以塞进限额（MIN_VIEW_LONG_EDGE=1024，_MAX_DECODE_BYTES=20MiB，_MAX_DECODE_PIXELS=40M）。
- 图片查看有 `source_bytes` 转换链；超限时建议文案："retry with fewer images in separate model requests"。

---

## 7. 反代透传设计建议

### 7.1 字段映射表（客户端 → 上游）

| 客户端上行字段 | 处理建议 | 理由/证据 |
|---|---|---|
| `messages[]` | **原样透传**；注意其中可能含 `reasoning_content`（仅 sn-* 回放名单模型）或 `reasoning_details`（其他模型）两种 thinking 回放形态，上游都要能消化或忽略 | `_convert_messages` |
| `model` | **按上游映射改写**（如反代后端是号池里的真实模型）。若想做"官方兼容网关"，接受 `raccoon-chat-ml-5-5`/`raccoon-chat`/`raccoon-chat-ml` 三个别名并映射到同一上游 | 渲染层 97245 别名表 |
| `max_tokens` | 透传或按上游能力夹取（客户端 hosted 默认 80000） | `generate_stream` |
| `stream` / `stream_options.include_usage` | **原样透传**；务必让上游在末尾 chunk 返回 `usage`，否则客户端拿不到计费数据（客户端不本地估算） | `stream_options={'include_usage':True}` |
| `tools[]` | 原样透传（标准 OpenAI function schema） | `_convert_tools` |
| `reasoning_effort` | 透传；值域 high/low/none | `_apply_thinking_params` |
| `extra_body` | **原样透传整个对象**（可能含 `thinking`/`enable_thinking` 或 LiteLLM 风格嵌套），不要展开也不要丢 | `_litellm_extra_body` docstring |
| `extra_headers` | 不出现在线上 body 里（SDK 参数），无需处理 | `_make_api_request` |
| HTTP 头 `Authorization: Bearer <JWT>` | 反代若要冒充官方客户端调上游，需要有效 JWT + 设备绑定（见总纲）；号池模式下换成池内凭据 | base.pyc |
| HTTP 头 `X-RACCOON-*`、`x-client-*` | 仅官方域名出现；反代自建域名时客户端不带。若反代要回传官方上游，需自行补齐这些头 | `should_attach_client_headers` |

### 7.2 流式不断流要点

1. **usage chunk 必须透传**：客户端只在流里读 `chunk.usage`；若上游不支持 `include_usage`，反代应自己合成一个末尾 usage chunk（prompt/completion/total tokens），否则客户端计量为 0。
2. **SSE 原样转发**：`data:` 行与 `[DONE]` 直传；不要缓冲整段再吐（客户端有 provider_stream 活动心跳与超时判定）。
3. **断流语义**：客户端对"打开流失败"会整请求重试（最多 4 次、指数退避 1s→60s）；对"中途断流"不重试直接报错。反代若自己对上游重连，注意同一 prompt 重发 = 上游重复生成/扣费。
4. **finish_reason 透传**：`length`/`max_tokens` 会触发客户端对 tool arguments 做括号闭合修复；`tool_calls` 正常结束。反代不要改写这两个值。
5. **SenseNova XML**：若反代后端模型吐 `<tool_call><function=...>` 文本，原样流过即可，客户端自动恢复为原生 tool_calls（最多 4 个）。不要在反代层剥离。
6. **请求体 10MB 预检**只在官方 hosted 模式启用；反代自建域名无此限制（`max_request_body_bytes=None`），上游若有自己的 body 上限需自行兜底。

### 7.3 反代需要实现的端点最小集

```
POST /api/web/llm/v2/chat/completions     # OpenAI 兼容，SSE + 末尾 usage chunk
GET  /api/web/llm/v2/model_catalog        # 模型目录（含 default_model + models[]，字段见 4.1）
POST /api/web/llm/v2/images/gen           # 文生图（JSON 或 image/* 响应）
POST /api/web/llm/v2/images/edits         # 图生图（multipart）——可选，不配 image_generation 时客户端不会调
```

---

## 8. 证据索引

| 结论 | 证据位置 |
|---|---|
| 流式请求体 6 字段 | `box_agent/llm/openai_client.pyc` `generate_stream` line 985-989（`_scratch/dis_stream.txt` line 23-39） |
| usage 在 chunk.usage | 同上 line 1121-1127（dis_stream.txt 343-388） |
| finish 事件字段 | 同上 line 1390-1399（dis_stream.txt 1062-1096） |
| 非流式请求体 | `_make_api_request` line 604-609（`_scratch/dis_openai_req.txt` line 31-53） |
| extra_body 双层嵌套 | `_litellm_extra_body` + docstring（dis_openai_req.txt 同模块 strings） |
| thinking 分支表 | `_apply_thinking_params`（`_scratch/dis_sensenova.txt` line 1-182） |
| reasoning 回放名单 | openai_client 模块常量 `_REASONING_CONTENT_REPLAY_MODELS`（line 55-63 模块级反汇编） |
| XML 伪 tool 正则 | openai_client 模块常量 line 66-72 |
| tools 转换 | `_convert_tools`（`_scratch/dis_convert.txt` line 221-313） |
| messages 转换 | `_convert_messages`（dis_convert.txt line 1-220） |
| 图片输入转 image_url | `_convert_input_content`（dis_convert.txt line 314-413） |
| 请求头 | `box_agent/llm/base.pyc` `_auth_headers`/`_request_headers`/`_agent_headers`（`_scratch/dis_base.txt`） |
| 10MB body 上限 | `image_payload.pyc` line 18 `HOSTED_MAX_REQUEST_BODY_BYTES=10000000` |
| 错误分类表 | `error_messages.pyc` `_RULES`/`_RETRYABLE_CATEGORIES`/`_NON_RETRYABLE_CATEGORIES` 模块级反汇编 |
| 重试默认 | `config.pyc` `RetryConfig`：enabled=True, max_retries=3, initial_delay=1.0, max_delay=60.0 |
| model_catalog | 渲染层 `47108-a9f1828633097aa2.js` 中 `…/api/web/llm/v2/model_catalog` fetch 与解析器 |
| 模型别名 | 同 chunk 97245 模块：`raccoon-chat`/`raccoon-chat-ml` → `raccoon-chat-ml-5-5` |
| profile 映射 | `build/electron/main/modelProfileRegistry.js` line 83-131；`box_agent/llm/model_profiles.pyc client_for_model_profile` |
| 图片生成 | `box_agent/tools/image_generation_tool.pyc` `_request_image`/`_request_image_edit`/`_image_from_response`（`_scratch/dis_img.txt`） |
| auto routing 候选 | `boxAgentManager.js` line 303-361；`box_agent/llm/model_routing.pyc` |

## 9. 未确认/需抓包验证清单

1. `model_catalog` 当前线上真实返回的模型数组（名字、倍率、ability_level）。
2. SSE 的精确帧格式（`data: [DONE]` 终止、心跳注释行等）——SDK 内部行为，未在反汇编中出现。
3. 上游错误响应的精确 JSON 形态（客户端按字符串匹配容错解析，200003/1000007 等业务码已坐实会出现在 body/headers 里，但完整 envelope 未确认）。
4. `raccoon-chat-ml-5-5` 上游实际是什么模型（疑似 SenseNova/LiteLLM 网关后的内部模型，仅间接证据：extra_body 双层 docstring + sensenova 常量）。
5. 图片生成的 size 预设表 `_SEEDREAM_PRESETS`/`_CANONICAL_IMAGE_RATIOS` 具体数值（常量存在但本次未逐一展开）。
6. 非流式 `generate()` 在 hosted 场景是否真的被使用（主流程看起来全部走 generate_stream）。
