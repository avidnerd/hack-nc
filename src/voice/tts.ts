/**
 * Voice out, plus the three interface sounds.
 *
 * Order of preference for each line:
 *   1. a pre-rendered clip listed in public/audio/manifest.json (offline,
 *      instant; produced by scripts/render-phrases.mjs when an ElevenLabs key
 *      is available)
 *   2. ElevenLabs streaming TTS when VITE_ELEVENLABS_KEY is set
 *   3. the browser's speechSynthesis
 * A new line always interrupts the previous one: a stale sentence finishing
 * over a fresh one is worse than a cut-off.
 */

const VOICE_ID = (import.meta.env.VITE_ELEVENLABS_VOICE as string | undefined) ?? '21m00Tcm4TlvDq8ikWAM';

export class Speech {
  private manifest: Record<string, string> = {};
  private audio: HTMLAudioElement | null = null;
  private ctx: AudioContext | null = null;
  private voice: SpeechSynthesisVoice | null = null;
  muted = false;

  async init(): Promise<void> {
    try {
      const res = await fetch(`${import.meta.env.BASE_URL}audio/manifest.json`);
      if (res.ok) this.manifest = (await res.json()) as Record<string, string>;
    } catch {
      // No pre-rendered clips; fine.
    }
    const pick = () => {
      const voices = speechSynthesis.getVoices();
      this.voice =
        voices.find((v) => /Google US English/.test(v.name)) ??
        voices.find((v) => /Samantha|Aria|Jenny|Zira/.test(v.name)) ??
        voices.find((v) => v.lang.startsWith('en')) ??
        null;
    };
    pick();
    speechSynthesis.onvoiceschanged = pick;
  }

  speak(text: string): void {
    if (this.muted || !text) return;
    this.stop();
    const clip = this.manifest[text];
    if (clip) {
      this.play(`${import.meta.env.BASE_URL}audio/${clip}`);
      return;
    }
    const key = import.meta.env.VITE_ELEVENLABS_KEY as string | undefined;
    if (key) {
      void this.eleven(text, key).catch((err) => {
        console.warn('[tts] ElevenLabs failed, using browser voice', err);
        this.browser(text);
      });
      return;
    }
    this.browser(text);
  }

  stop(): void {
    speechSynthesis.cancel();
    if (this.audio) {
      this.audio.pause();
      this.audio = null;
    }
  }

  private browser(text: string): void {
    const u = new SpeechSynthesisUtterance(text);
    if (this.voice) u.voice = this.voice;
    u.rate = 1.05;
    u.pitch = 1;
    speechSynthesis.speak(u);
  }

  private play(url: string): void {
    const a = new Audio(url);
    this.audio = a;
    void a.play().catch(() => {});
  }

  private async eleven(text: string, key: string): Promise<void> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 2500);
    try {
      const res = await fetch(
        `https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}/stream?optimize_streaming_latency=3`,
        {
          method: 'POST',
          signal: ctrl.signal,
          headers: { 'xi-api-key': key, 'content-type': 'application/json', accept: 'audio/mpeg' },
          body: JSON.stringify({ text, model_id: 'eleven_turbo_v2_5' }),
        },
      );
      if (!res.ok) throw new Error(`elevenlabs ${res.status}`);
      const blob = await res.blob();
      this.play(URL.createObjectURL(blob));
    } finally {
      clearTimeout(timer);
    }
  }

  /* ------------------------------------------------------------- sounds */

  // DECISION: the three interface sounds are synthesised with WebAudio rather
  // than shipped as files: smaller, self-hosted, and tweakable in code.

  /** Soft tick: lock / unlock. */
  tick(): void {
    this.tone([1800], 0.05, 0.06, 'square');
  }

  /** Bright major chord: seals / optimized. */
  chord(): void {
    this.tone([523.25, 659.25, 783.99], 0.5, 0.07, 'sine');
  }

  /** Low tone: won't seal. */
  low(): void {
    this.tone([146.83, 155.56], 0.45, 0.09, 'triangle');
  }

  private tone(freqs: number[], seconds: number, gain: number, type: OscillatorType): void {
    if (this.muted) return;
    try {
      this.ctx ??= new AudioContext();
      const ctx = this.ctx;
      const t = ctx.currentTime;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(gain, t + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t + seconds);
      g.connect(ctx.destination);
      for (const f of freqs) {
        const o = ctx.createOscillator();
        o.type = type;
        o.frequency.value = f;
        o.connect(g);
        o.start(t);
        o.stop(t + seconds);
      }
    } catch {
      // Audio is a nicety; never let it throw into the app.
    }
  }
}
