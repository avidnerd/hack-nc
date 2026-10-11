/**
 * Web Speech API recogniser with the wake-word gate (§6.6).
 *
 * Continuous; commands come from final results only. Chrome ends a session
 * after a stretch of silence or an error, so the recogniser restarts itself
 * until stopped. A bare "scrub" arms the gate for a few seconds, so "Scrub ...
 * place the stent" works even when the recogniser splits it into two results.
 *
 * Long questions get split too ("scrub, is it possible to" | "optimize the
 * plane within a 30 millimetre margin"), and the second half has no wake
 * word. So a waked phrase the app cannot parse is held while the speaker is
 * still talking (interim results only show that speech is ongoing; their
 * words are never acted on) and joined with the next final result.
 */

import { stripWake } from './intents.ts';

interface SpeechRecognitionLike {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  maxAlternatives: number;
  start(): void;
  stop(): void;
  onresult: ((e: { resultIndex: number; results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null;
  onend: (() => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onspeechend: (() => void) | null;
  onstart: (() => void) | null;
}

declare global {
  interface Window {
    webkitSpeechRecognition?: new () => SpeechRecognitionLike;
    SpeechRecognition?: new () => SpeechRecognitionLike;
  }
}

const ARM_MS = 4000;
/** How long a half-understood command waits for its continuation after speech goes quiet. */
const CONTINUE_MS = 1500;

export interface SttHooks {
  /**
   * A de-waked command, lowercased; `heard` is the raw transcript. With
   * `last` false the app may return false ("not understood") and the
   * command is held for a continuation, then delivered again with `last`
   * true, joined to whatever followed or alone.
   */
  onCommand: (command: string, heard: string, last: boolean) => boolean;
  onListening: (listening: boolean) => void;
  /** Recognition is impossible (no API, mic denied). */
  onUnavailable: (reason: string) => void;
}

export class SpeechInput {
  private rec: SpeechRecognitionLike | null = null;
  private running = false;
  private armedUntil = 0;
  private speechEndAt = 0;
  private pending: { cmd: string; heard: string; timer: number } | null = null;
  /** Measured speech-end to result latency, ms. */
  latencyMs = 0;

  constructor(private readonly hooks: SttHooks) {}

  static supported(): boolean {
    return !!(window.SpeechRecognition ?? window.webkitSpeechRecognition);
  }

  start(): void {
    const Ctor = window.SpeechRecognition ?? window.webkitSpeechRecognition;
    if (!Ctor) {
      this.hooks.onUnavailable('This browser has no speech recognition (use Chrome).');
      return;
    }
    const rec = new Ctor();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = 'en-US';
    rec.maxAlternatives = 3;

    rec.onstart = () => this.hooks.onListening(true);
    rec.onspeechend = () => {
      this.speechEndAt = performance.now();
    };
    rec.onresult = (e) => {
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i];
        if (!res.isFinal) {
          // Still talking: give a held command more time.
          if (this.pending) this.holdPending();
          continue;
        }
        if (this.speechEndAt) {
          this.latencyMs = performance.now() - this.speechEndAt;
          console.info(`[stt] result ${this.latencyMs.toFixed(0)} ms after speech end`);
          this.speechEndAt = 0;
        }
        this.handle(res);
      }
    };
    rec.onerror = (e) => {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
        this.running = false;
        this.hooks.onUnavailable('Microphone blocked.');
      } else if (e.error !== 'no-speech' && e.error !== 'aborted') {
        console.warn('[stt] error', e.error);
      }
    };
    rec.onend = () => {
      this.hooks.onListening(false);
      // Chrome stops after silence; keep listening for the whole demo.
      if (this.running) setTimeout(() => this.safeStart(), 250);
    };

    this.rec = rec;
    this.running = true;
    this.safeStart();
  }

  stop(): void {
    this.running = false;
    this.rec?.stop();
  }

  private safeStart(): void {
    try {
      this.rec?.start();
    } catch {
      // start() throws if a session is already live; that is fine.
    }
  }

  /** Try each alternative for the wake word, best first. */
  private handle(alts: ArrayLike<{ transcript: string }>): void {
    const heard = alts[0]?.transcript.trim() ?? '';
    for (let a = 0; a < alts.length; a++) {
      const t = alts[a].transcript.trim();
      const cmd = stripWake(t);
      if (cmd === null) continue;
      // A new wake word starts a new command; a held one is given up.
      this.dropPending();
      if (cmd === '') {
        this.armedUntil = performance.now() + ARM_MS;
        this.hooks.onCommand('', t, true);
        return;
      }
      this.armedUntil = 0;
      if (!this.hooks.onCommand(cmd, t, false)) {
        this.pending = { cmd, heard: t, timer: 0 };
        this.holdPending();
      }
      return;
    }
    if (this.pending && heard) {
      const p = this.pending;
      this.dropPending();
      this.hooks.onCommand(`${p.cmd} ${heard.toLowerCase()}`, `${p.heard} ${heard}`, true);
      return;
    }
    if (performance.now() < this.armedUntil && heard) {
      this.armedUntil = 0;
      this.hooks.onCommand(heard.toLowerCase(), heard, true);
      return;
    }
    console.debug('[stt] ignored (no wake word):', heard);
  }

  /** (Re)start the wait for a held command's continuation. */
  private holdPending(): void {
    const p = this.pending;
    if (!p) return;
    clearTimeout(p.timer);
    p.timer = window.setTimeout(() => {
      if (this.pending !== p) return;
      this.pending = null;
      this.hooks.onCommand(p.cmd, p.heard, true);
    }, CONTINUE_MS);
  }

  private dropPending(): void {
    if (this.pending) clearTimeout(this.pending.timer);
    this.pending = null;
  }
}
