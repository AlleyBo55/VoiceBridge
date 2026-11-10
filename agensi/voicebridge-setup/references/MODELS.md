# Engines and models

What VoiceBridge can use for each stage, and how to choose. These are the options in current VoiceBridge source builds (November 2026). The 1.0.0 installers from April 2026 predate most of them; the project README of that time lists ElevenLabs Scribe v2 Realtime, Eleven Flash v2.5, and OpenAI, Anthropic or OpenRouter for translation. Labels in the app can differ between versions; follow what the app shows.

No prices are listed here because they change. Use the pricing pages at the end.

## Engines

An engine is the whole path from the user's voice to the translated voice.

| Engine | How it works | Voice the meeting hears | Languages | Delay | Needs |
|---|---|---|---|---|---|
| Cascade (default) | ElevenLabs Scribe v3 Live transcribes, an LLM translates, an ElevenLabs voice model speaks | the user's ElevenLabs voice clone | input: what Scribe supports; output: depends on the voice model (below) | roughly a second after the user stops talking | ElevenLabs key plus an LLM key, or a local LLM server |
| Qwen3.8 LiveTranslate | one speech-to-speech model, `qwen3.8-livetranslate-flash-realtime` | a clone the model makes of the speaker's voice by itself | understands 60, speaks 29 | trails the speaker by about 2 s | Alibaba Cloud Model Studio API key, Workspace ID and region (`ap-southeast-1` or `cn-beijing`) |
| OpenAI GPT-Realtime-Translate | one speech-to-speech model | a preset OpenAI voice, not the user's clone | 70+ input, 13 output | trails the speaker by about 2 s | OpenAI API key |
| Google Gemini 3.5 Live Translate (preview) | one speech-to-speech model | keeps the speaker's intonation and pitch, but is not a voice clone | 70+ | trails the speaker by about 2 s | Google Gemini API key |

Where the audio goes:

- Cascade: audio to ElevenLabs; transcript text to the chosen LLM provider (or stays on the machine with a local server).
- Qwen3.8 LiveTranslate: audio is processed by Alibaba Cloud in the selected region.
- GPT-Realtime-Translate: audio to OpenAI.
- Gemini 3.5 Live Translate: audio to Google.

## Cascade stage 1: speech to text

ElevenLabs Scribe v3 Live (`scribe_v3_live`). It predicts when the user has finished a turn, so translation starts without waiting for a long silence, and it filters background audio. It uses the ElevenLabs API key.

## Cascade stage 2: translation (LLM)

| Provider | Default model | Base URL and notes | Get a key |
|---|---|---|---|
| OpenAI (default) | `gpt-6-luna` | built in | https://platform.openai.com |
| Anthropic | `claude-haiku-5-5` | built in | https://console.anthropic.com |
| OpenRouter | `openai/gpt-6-luna` | any of about 460 models; the app loads the live model list | https://openrouter.ai |
| Hugging Face Inference Providers | an open-weights model such as `Qwen/Qwen3.8-27B` | OpenAI-compatible router `https://router.huggingface.co/v1`. Add `:fastest`, `:cheapest` or `:<provider>` to the model id to choose how the request is routed | an access token from https://huggingface.co/settings/tokens with permission to call Inference Providers |
| Any OpenAI-compatible server | whatever the server lists at `/v1/models` | custom base URL, see below | depends on the server; local servers usually need none |

Custom base URLs:

| Server | Base URL |
|---|---|
| Ollama (local) | `http://localhost:11434/v1` |
| LM Studio (local) | `http://localhost:1234/v1` |
| vLLM (local, default port) | `http://localhost:8000/v1` |
| Groq | `https://api.groq.com/openai/v1` |
| Together AI | `https://api.together.xyz/v1` |
| DeepSeek | `https://api.deepseek.com/v1` |

Use the exact model id the server reports. A local server keeps the transcript text on the machine, but the speech still goes to ElevenLabs for transcription and the voice. Small local models on a CPU can add noticeable delay.

## Cascade stage 3: voice (text to speech)

All three speak in the user's ElevenLabs voice clone, or a default voice if the user skipped cloning.

| Model id | Speed | Languages | Notes |
|---|---|---|---|
| `eleven_v4_turbo` (default) | about 100 ms model latency | 90+ | starts speaking while the translation is still being written |
| `eleven_flash_v2_5` | low latency | 32 | cheapest |
| `eleven_multilingual_v2` | slower than the other two | 29 | try it if the clone sounds better on it |

## Which to pick

- **Most users:** cascade, `eleven_v4_turbo`, the provider's default translation model. Best match to the user's own voice and the widest language coverage.
- **Lowest cost:** `eleven_flash_v2_5` when both languages are among its 32, with a low-cost model through OpenRouter, Hugging Face (`:cheapest`) or a local server.
- **Transcript text must not reach a cloud LLM:** cascade with Ollama, LM Studio or vLLM. Tell the user that audio still goes to ElevenLabs.
- **Long presentations without pauses:** a simultaneous speech-to-speech engine, accepting about 2 s of trailing delay.
  - Wants their own voice: Qwen3.8 LiveTranslate. Check that the target language is among the 29 it speaks, and that the user accepts Alibaba Cloud processing the audio.
  - Fine with a preset voice: OpenAI GPT-Realtime-Translate, if the target is among its 13 output languages.
  - Wants their intonation kept without a clone: Gemini 3.5 Live Translate. It is a preview, so expect changes.
- **Names and jargon come out wrong:** this happens with every engine. A stronger translation model helps in the cascade, and so does speaking names clearly. If the user's build has a glossary setting, add the names there.
- **Data residency for Qwen:** choose the region the user's Model Studio account and workspace live in. Keys and workspaces from one region do not work in the other.

## Pricing pages

Check these before recommending a paid option; the skill does not quote prices.

- ElevenLabs plans: https://elevenlabs.io/pricing; API usage: https://elevenlabs.io/pricing/api
- OpenAI: https://openai.com/api/pricing
- Anthropic: https://www.anthropic.com/pricing
- OpenRouter: https://openrouter.ai/models (each model page shows its price)
- Hugging Face Inference Providers: https://huggingface.co/docs/inference-providers/pricing
- Alibaba Cloud Model Studio: https://www.alibabacloud.com/help/en/model-studio/model-pricing
- Google Gemini API: https://ai.google.dev/gemini-api/docs/pricing
- Groq: https://groq.com/pricing
- Together AI: https://www.together.ai/pricing
- DeepSeek: https://api-docs.deepseek.com/quick_start/pricing
- Local servers (Ollama, LM Studio, vLLM) have no per-request fee; the cost is the user's hardware and power.
