import React from 'react';
import {
  AbsoluteFill,
  useCurrentFrame,
  useVideoConfig,
  interpolate,
  spring,
  Sequence,
} from 'remotion';

// ── Design Tokens ───────────────────────────────────────────

const COLORS = {
  black: '#000000',
  white: '#FFFFFF',
  dim: '#666666',
  accent: '#F7931A',
  surface: '#111111',
  border: '#222222',
};

const FONTS = {
  display: '"Doto", "Space Mono", monospace',
  body: '"Space Grotesk", "DM Sans", system-ui, sans-serif',
  mono: '"Space Mono", "JetBrains Mono", monospace',
};

// ── Cinematic Text Components ───────────────────────────────

/** Single word that slams in big then settles */
const SlamWord: React.FC<{
  children: React.ReactNode;
  delay?: number;
  fontSize?: number;
  color?: string;
  font?: string;
  weight?: number;
}> = ({ children, delay = 0, fontSize = 120, color = COLORS.white, font = FONTS.body, weight = 700 }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const progress = spring({
    frame: frame - delay,
    fps,
    config: { damping: 14, stiffness: 180, mass: 0.8 },
  });

  const scale = interpolate(progress, [0, 1], [2.5, 1]);
  const opacity = interpolate(frame - delay, [0, 6], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  return (
    <div style={{
      fontSize, fontFamily: font, fontWeight: weight, color,
      transform: `scale(${scale})`,
      opacity,
      textAlign: 'center',
      lineHeight: 1.0,
    }}>
      {children}
    </div>
  );
};

/** Text that fades up smoothly */
const RiseText: React.FC<{
  children: React.ReactNode;
  delay?: number;
  style?: React.CSSProperties;
}> = ({ children, delay = 0, style }) => {
  const frame = useCurrentFrame();
  const opacity = interpolate(frame - delay, [0, 18], [0, 1], {
    extrapolateLeft: 'clamp', extrapolateRight: 'clamp',
  });
  const y = interpolate(frame - delay, [0, 18], [40, 0], {
    extrapolateLeft: 'clamp', extrapolateRight: 'clamp',
  });
  return (
    <div style={{ opacity, transform: `translateY(${y}px)`, ...style }}>
      {children}
    </div>
  );
};

/** Zoom-through text — starts huge and zooms past camera */
const ZoomThrough: React.FC<{
  children: React.ReactNode;
  delay?: number;
  style?: React.CSSProperties;
}> = ({ children, delay = 0, style }) => {
  const frame = useCurrentFrame();
  const local = frame - delay;
  const scale = interpolate(local, [0, 35], [0.3, 1.2], {
    extrapolateLeft: 'clamp', extrapolateRight: 'clamp',
  });
  const opacity = interpolate(local, [0, 10, 30, 42], [0, 1, 1, 0], {
    extrapolateLeft: 'clamp', extrapolateRight: 'clamp',
  });
  return (
    <div style={{
      transform: `scale(${scale})`, opacity, transformOrigin: 'center', ...style,
    }}>
      {children}
    </div>
  );
};

const TypewriterText: React.FC<{
  text: string; delay?: number; speed?: number; style?: React.CSSProperties;
}> = ({ text, delay = 0, speed = 1.5, style }) => {
  const frame = useCurrentFrame();
  const chars = Math.min(text.length, Math.max(0, Math.floor((frame - delay) * speed)));
  return (
    <span style={style}>
      {text.slice(0, chars)}
      {chars < text.length && <span style={{ opacity: frame % 15 < 8 ? 1 : 0 }}>▌</span>}
    </span>
  );
};

const PulseAccent: React.FC<{ children: React.ReactNode; delay?: number }> = ({ children, delay = 0 }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const scale = spring({ frame: frame - delay, fps, config: { damping: 12, stiffness: 200, mass: 0.5 } });
  return <div style={{ transform: `scale(${scale})`, transformOrigin: 'center' }}>{children}</div>;
};

const Waveform: React.FC<{ color: string; active: boolean; height?: number }> = ({ color, active, height = 90 }) => {
  const frame = useCurrentFrame();
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5, height }}>
      {Array.from({ length: 24 }, (_, i) => (
        <div key={i} style={{
          width: 5,
          height: active ? 12 + Math.abs(Math.sin((frame * 0.15 + i * 0.5) * 0.8)) * (height - 20) : 6,
          background: color, borderRadius: 3, opacity: active ? 0.9 : 0.2,
        }} />
      ))}
    </div>
  );
};

// ── Language Data ────────────────────────────────────────────

const DEMO_LANGUAGES = [
  { label: 'ENGLISH', text: '"Hello darling, daddy loves you."', color: '#5B9BF6', frames: 96 },
  { label: 'KOREAN', text: '"안녕 사랑아, 아빠가 사랑해."', color: COLORS.accent, frames: 156 },
  { label: 'JAPANESE', text: '"パパはいつも大好きだよ。"', color: '#C084FC', frames: 96 },
  { label: 'CHINESE', text: '"爸爸永远爱你。"', color: '#4ADE80', frames: 96 },
] as const;

const LANG_DURATION = 96; // fallback, not used for cycling anymore

// ── Main Composition ────────────────────────────────────────

export const VoiceBridgeReel: React.FC = () => {
  const frame = useCurrentFrame();

  // Scene timing
  const TOTAL_LANG_FRAMES = DEMO_LANGUAGES.reduce((sum, l) => sum + l.frames, 0); // 444
  const S3 = 255;
  const S3_DUR = TOTAL_LANG_FRAMES + 60;
  const S4 = S3 + S3_DUR;
  const S5 = S4 + 180;

  return (
    <AbsoluteFill style={{ backgroundColor: COLORS.black }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Doto:wght@400;700&family=Space+Grotesk:wght@300;400;500;700&family=Space+Mono:wght@400;700&display=swap');
      `}</style>

      {/* ── SCENE 1: Cinematic word flow (0-5s) ──────────── */}
      <Sequence from={0} durationInFrames={150}>
        <AbsoluteFill style={{ justifyContent: 'center', alignItems: 'center' }}>
          {[
            { text: 'What if', start: 0, dur: 50, size: 120, w: 300, color: COLORS.white },
            { text: 'your voice', start: 35, dur: 50, size: 140, w: 700, color: COLORS.white },
            { text: 'could speak', start: 70, dur: 50, size: 110, w: 300, color: COLORS.white },
            { text: 'any language?', start: 105, dur: 50, size: 130, w: 700, color: COLORS.accent },
          ].map((w) => {
            const local = frame - w.start;
            const fadeIn = interpolate(local, [0, 12], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
            const fadeOut = interpolate(local, [w.dur - 12, w.dur], [1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
            const scale = interpolate(local, [0, 15, w.dur - 8, w.dur], [1.15, 1, 1, 1.08], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
            const visible = local >= 0 && local < w.dur;
            if (!visible) return null;
            return (
              <div key={w.text} style={{
                position: 'absolute',
                fontFamily: FONTS.body, fontSize: w.size, fontWeight: w.w,
                color: w.color, textAlign: 'center', lineHeight: 1.0,
                opacity: Math.min(fadeIn, fadeOut),
                transform: `scale(${scale})`,
              }}>
                {w.text}
              </div>
            );
          })}
        </AbsoluteFill>
      </Sequence>

      {/* ── SCENE 2: Zoom-through "Your actual voice" (5-8.5s) */}
      <Sequence from={150} durationInFrames={105}>
        <AbsoluteFill style={{ justifyContent: 'center', alignItems: 'center', gap: 24 }}>
          <ZoomThrough style={{
            fontFamily: FONTS.mono, fontSize: 48, color: COLORS.dim,
            letterSpacing: '0.08em', textTransform: 'uppercase' as const,
            textAlign: 'center',
          }}>
            NOT SUBTITLES. NOT TEXT.
          </ZoomThrough>
          <RiseText delay={30} style={{
            fontFamily: FONTS.body, fontSize: 96, color: COLORS.accent,
            fontWeight: 700, textAlign: 'center', lineHeight: 1.05,
          }}>
            Your actual<br />voice.
          </RiseText>
        </AbsoluteFill>
      </Sequence>

      {/* ── SCENE 3: Multilingual Demo (7-20s) ───────────── */}
      <Sequence from={S3} durationInFrames={S3_DUR}>
        <AbsoluteFill style={{ justifyContent: 'center', alignItems: 'center', padding: 48, gap: 32 }}>
          {/* Input */}
          <div style={{ textAlign: 'center' }}>
            <RiseText style={{
              fontFamily: FONTS.mono, fontSize: 26, color: COLORS.dim,
              letterSpacing: '0.1em', marginBottom: 16,
            }}>
              INPUT — BAHASA INDONESIA
            </RiseText>
            <Waveform color="#5B9BF6" active={frame >= S3 + 15 && frame < S3 + S3_DUR - 15} />
            <RiseText delay={15} style={{
              fontFamily: FONTS.body, fontSize: 46, color: COLORS.white,
              marginTop: 20, fontWeight: 400,
            }}>
              <TypewriterText text='"Halo sayang, papa sayang kamu selalu."' delay={15} />
            </RiseText>
          </div>

          {/* Arrow */}
          <RiseText delay={40} style={{ fontSize: 64, color: COLORS.dim }}>↓</RiseText>

          {/* Cycling output */}
          <div style={{ minHeight: 220, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            {(() => {
              const outputStart = 60;
              const localScene = frame - S3 - outputStart;
              if (localScene < 0) return null;

              // Find which language we're on based on cumulative frames
              let accumulated = 0;
              let idx = 0;
              for (let i = 0; i < DEMO_LANGUAGES.length; i++) {
                if (localScene < accumulated + DEMO_LANGUAGES[i].frames) { idx = i; break; }
                accumulated += DEMO_LANGUAGES[i].frames;
                if (i === DEMO_LANGUAGES.length - 1) idx = i;
              }
              const lf = localScene - accumulated;
              const lang = DEMO_LANGUAGES[idx];
              if (!lang) return null;
              const dur = lang.frames;

              const fadeIn = interpolate(lf, [0, 12], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
              const fadeOut = interpolate(lf, [dur - 12, dur], [1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
              const y = interpolate(lf, [0, 12], [24, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
              const textScale = interpolate(lf, [0, 15], [0.9, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });

              return (
                <div style={{
                  textAlign: 'center', opacity: Math.min(fadeIn, fadeOut),
                  transform: `translateY(${y}px) scale(${textScale})`,
                }}>
                  <div style={{
                    fontFamily: FONTS.mono, fontSize: 26, color: COLORS.dim,
                    letterSpacing: '0.1em', marginBottom: 16,
                  }}>
                    OUTPUT — {lang.label}
                  </div>
                  <Waveform color={lang.color} active={lf > 15 && lf < dur - 10} />
                  <div style={{
                    fontFamily: FONTS.body, fontSize: 46, color: lang.color,
                    marginTop: 20, fontWeight: 500, minHeight: 60,
                  }}>
                    <TypewriterText text={lang.text} delay={0} speed={1.8} />
                  </div>
                </div>
              );
            })()}
          </div>

          {/* Latency badge */}
          <RiseText delay={70} style={{
            fontFamily: FONTS.mono, fontSize: 28, color: COLORS.white,
            background: COLORS.surface, border: `1px solid ${COLORS.border}`,
            borderRadius: 999, padding: '14px 36px', letterSpacing: '0.06em',
          }}>
            ⚡ 1.8s END-TO-END
          </RiseText>

          {/* Language dots */}
          <div style={{ display: 'flex', gap: 12, marginTop: 4 }}>
            {DEMO_LANGUAGES.map((lang, i) => {
              const localScene = frame - S3 - 60;
              let accumulated2 = 0;
              let activeIdx = -1;
              if (localScene >= 0) {
                for (let j = 0; j < DEMO_LANGUAGES.length; j++) {
                  if (localScene < accumulated2 + DEMO_LANGUAGES[j].frames) { activeIdx = j; break; }
                  accumulated2 += DEMO_LANGUAGES[j].frames;
                  if (j === DEMO_LANGUAGES.length - 1) activeIdx = j;
                }
              }
              return (
                <div key={lang.label} style={{
                  width: i === activeIdx ? 32 : 12, height: 12, borderRadius: 6,
                  background: i === activeIdx ? lang.color : COLORS.border,
                }} />
              );
            })}
          </div>
        </AbsoluteFill>
      </Sequence>

      {/* ── SCENE 4: Features — word-by-word slam (20-26s) ── */}
      <Sequence from={S4} durationInFrames={180}>
        <AbsoluteFill style={{ justifyContent: 'center', alignItems: 'center', padding: 60 }}>
          {[
            { text: 'No cloud.', delay: 0, size: 88, w: 700 },
            { text: 'No account.', delay: 25, size: 88, w: 700 },
            { text: 'Your keys.', delay: 55, size: 68, w: 300 },
            { text: 'Your machine.', delay: 80, size: 68, w: 300 },
            { text: 'BYO: ElevenLabs + Any LLM', delay: 110, size: 42, w: 500 },
          ].map((item) => (
            <RiseText key={item.text} delay={item.delay} style={{
              fontFamily: FONTS.body, fontSize: item.size, color: COLORS.white,
              textAlign: 'center', fontWeight: item.w, marginBottom: 8,
            }}>
              {item.text}
            </RiseText>
          ))}
        </AbsoluteFill>
      </Sequence>

      {/* ── SCENE 5: Logo — cinematic reveal (26-30s) ─────── */}
      <Sequence from={S5} durationInFrames={150}>
        <AbsoluteFill style={{ justifyContent: 'center', alignItems: 'center', gap: 40 }}>
          {/* Dot grid bg */}
          <div style={{
            position: 'absolute', inset: 0,
            backgroundImage: `radial-gradient(circle, ${COLORS.border} 1px, transparent 1px)`,
            backgroundSize: '24px 24px',
            opacity: interpolate(frame - S5, [0, 30], [0, 0.3], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }),
            zIndex: -1,
          }} />

          <PulseAccent delay={10}>
            <div style={{
              fontFamily: FONTS.display, fontSize: 120, fontWeight: 700,
              color: COLORS.white, letterSpacing: '-0.02em',
            }}>
              VOICEBRIDGE
            </div>
          </PulseAccent>

          <RiseText delay={25} style={{
            fontFamily: FONTS.mono, fontSize: 34, color: COLORS.dim,
            letterSpacing: '0.12em', textTransform: 'uppercase' as const,
          }}>
            YOUR VOICE. ANY LANGUAGE.
          </RiseText>

          <RiseText delay={45} style={{
            fontFamily: FONTS.mono, fontSize: 32, color: COLORS.accent,
            letterSpacing: '0.08em', position: 'absolute', bottom: 160,
          }}>
            GITHUB.COM/ALLEYBO55/VOICEBRIDGE
          </RiseText>

          <RiseText delay={55} style={{
            fontFamily: FONTS.mono, fontSize: 28, color: COLORS.dim,
            letterSpacing: '0.06em', position: 'absolute', bottom: 110,
          }}>
            BUILT WITH ELEVENLABS × OPEN SOURCE
          </RiseText>
        </AbsoluteFill>
      </Sequence>
    </AbsoluteFill>
  );
};
