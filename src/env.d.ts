/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_DEMO_KEY_ENABLED: string;
  readonly VITE_DEMO_ELEVENLABS_KEY: string;
  readonly VITE_DEMO_LLM_PROVIDER: string;
  readonly VITE_DEMO_LLM_KEY: string;
  readonly VITE_DEMO_OPENROUTER_MODEL: string;
  readonly VITE_DEMO_UNLIMITED: string;
  readonly VITE_DEMO_VOICE_LIMIT_SECONDS: string;
  readonly VITE_VERSION: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
