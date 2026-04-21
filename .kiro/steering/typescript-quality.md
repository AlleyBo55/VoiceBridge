# TypeScript & Code Quality Standards

This project uses TypeScript with strict mode. Follow these standards for all code.

## TypeScript Configuration

```json
{
  "compilerOptions": {
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "exactOptionalPropertyTypes": true,
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "outDir": "dist",
    "rootDir": "src",
    "declaration": true,
    "sourceMap": true
  }
}
```

## Code Style Rules

### Naming Conventions

| Thing | Convention | Example |
|-------|-----------|---------|
| Files | kebab-case | `stt-client.ts`, `audio-capture.ts` |
| Classes | PascalCase | `STTClient`, `AudioCaptureModule` |
| Interfaces | PascalCase, no `I` prefix | `VoiceProfile`, `SessionState` |
| Types | PascalCase | `PipelineStage`, `LanguageCode` |
| Functions | camelCase | `sendAudioChunk`, `getSTTToken` |
| Constants | UPPER_SNAKE_CASE | `CHUNK_SIZE`, `MAX_RETRY_ATTEMPTS` |
| Enums | PascalCase members | `PipelineState.Listening` |
| Private fields | `#` prefix (ES private) | `#wsConnection`, `#buffer` |

### Type Safety

- Never use `any`. Use `unknown` and narrow with type guards.
- Prefer discriminated unions over optional fields for state:

```typescript
// ✅ Good — exhaustive, clear states
type ConnectionState =
  | { status: 'disconnected' }
  | { status: 'connecting'; attempt: number }
  | { status: 'connected'; ws: WebSocket }
  | { status: 'error'; error: Error; lastAttempt: number };

// ❌ Bad — ambiguous, nullable soup
interface ConnectionState {
  status: string;
  ws?: WebSocket;
  error?: Error;
  attempt?: number;
}
```

- Use `as const` for literal types and exhaustive switch checks
- Use `satisfies` for type-safe object literals with inference

### Error Handling

- Never swallow errors silently. Always log or propagate.
- Use typed error classes for domain errors:

```typescript
class ElevenLabsAPIError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly retryable: boolean
  ) {
    super(message);
    this.name = 'ElevenLabsAPIError';
  }
}
```

- Use Result pattern for operations that can fail predictably:

```typescript
type Result<T, E = Error> =
  | { ok: true; value: T }
  | { ok: false; error: E };
```

### Async Patterns

- Always handle promise rejections. No floating promises.
- Use `AbortController` for cancellable operations:

```typescript
async function translateWithTimeout(text: string, signal: AbortSignal): Promise<string> {
  const response = await fetch(url, { signal });
  // ...
}
```

- Prefer `async/await` over `.then()` chains
- Use `Promise.allSettled` when multiple operations can fail independently

### Module Organization

- One class/module per file. Keep files under 300 lines.
- Export types separately from implementations
- Use barrel exports (`index.ts`) sparingly — only for public API surfaces
- Colocate tests with source: `stt-client.ts` → `stt-client.test.ts`

## State Management

- Use explicit state machines for complex state (echo cancellation, pipeline, connection)
- State transitions must be logged for diagnostics
- Never mutate state directly — use transition functions:

```typescript
function transitionEchoState(
  current: EchoState,
  event: EchoEvent
): EchoState {
  switch (current.status) {
    case 'listening':
      if (event.type === 'tts_start') return { status: 'speaking' };
      return current;
    case 'speaking':
      if (event.type === 'barge_in') return { status: 'listening' };
      if (event.type === 'tts_end') return { status: 'transitioning', startedAt: Date.now() };
      return current;
    case 'transitioning':
      if (event.type === 'transition_complete') return { status: 'listening' };
      return current;
  }
}
```

## Testing Strategy

- Unit test all pure logic (VAD, state machines, format conversion, chunking)
- Integration test WebSocket clients with mock servers
- Use `vitest` as test runner
- Mock `chrome.*` APIs with `@anthropic-ai/chrome-extension-testing` or manual mocks
- Test audio processing with known PCM samples (sine waves, silence, noise)

## Build & Bundle

- Use `vite` with `@crxjs/vite-plugin` for Chrome extension bundling
- Or use `webpack` with `copy-webpack-plugin` for manifest and static assets
- Separate entry points: service-worker, offscreen, content-script, popup, sidepanel, options, onboarding
- Tree-shake aggressively — extension size matters for Chrome Web Store

## Dependencies (Minimal)

Keep dependencies minimal. This is a Chrome extension — bundle size matters.

| Package | Purpose |
|---------|---------|
| `@elevenlabs/elevenlabs-js` | REST API client (voice cloning, subscription) |
| `lucide` or `lucide-static` | Icons (monoline, Nothing design) |
| `vite` | Build tool |

Do NOT add:
- React/Vue/Svelte (vanilla TS + DOM manipulation for extension UI)
- Tailwind (use CSS custom properties from Nothing design tokens)
- State management libraries (use plain state machines)
- Lodash/Underscore (use native ES2022+)

## Comments & Documentation

- JSDoc on all exported functions and classes
- Explain WHY, not WHAT (the code shows what)
- Document latency-critical paths with `// PERF:` prefix
- Document security-sensitive code with `// SECURITY:` prefix
- No commented-out code in commits

## Git Conventions

- Commit messages: `type(scope): description` (conventional commits)
- Types: `feat`, `fix`, `refactor`, `perf`, `docs`, `test`, `chore`
- Scope: module name (`stt`, `tts`, `audio`, `ui`, `translation`)
- Example: `feat(stt): implement WebSocket reconnection with exponential backoff`
