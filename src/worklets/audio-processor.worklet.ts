/**
 * AudioWorklet processor for real-time PCM conversion.
 * Converts Float32 [-1.0, 1.0] to Int16 [-32768, 32767].
 * Runs on a dedicated audio thread — no main thread blocking.
 */

// AudioWorklet types are not in standard lib — declare them here
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  process(inputs: Float32Array[][], outputs: Float32Array[][], parameters: Record<string, Float32Array>): boolean;
}

declare function registerProcessor(name: string, processorCtor: new () => AudioWorkletProcessor): void;

class AudioProcessor extends AudioWorkletProcessor {
  process(
    inputs: Float32Array[][],
    _outputs: Float32Array[][],
    _parameters: Record<string, Float32Array>
  ): boolean {
    const input = inputs[0]?.[0];
    if (!input || input.length === 0) return true;

    // PERF: Convert Float32 → Int16 in the audio thread
    const pcm16 = new Int16Array(input.length);
    for (let i = 0; i < input.length; i++) {
      const s = Math.max(-1, Math.min(1, input[i] ?? 0));
      pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
    }

    // Transfer ownership of the buffer (zero-copy)
    this.port.postMessage(
      { type: 'audio', buffer: pcm16.buffer },
      [pcm16.buffer]
    );

    return true;
  }
}

registerProcessor('audio-processor', AudioProcessor);
