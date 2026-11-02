import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  AppError,
  ErrorCode,
  type Logger,
  type SynthesisRequest,
  type SynthesisResult,
  type TextToSpeechProvider,
  noopLogger,
} from '@resus/core';
import { decodeAudio, durationMs, toMonoSlin } from './audioFormat.js';
import { runProcess } from './subprocess.js';

/**
 * Real text-to-speech backed by espeak-ng.
 *
 * This produces an actual waveform: text goes in, a WAV comes out, and the
 * caller hears speech. `isLive` is `true` because no part of the path is
 * simulated, and `durationMs` is measured from the samples rather than estimated
 * from the text, so an event record that says three seconds of audio was played
 * matches what was actually sent.
 *
 * Audio contract
 * --------------
 * espeak-ng writes a 22.05 kHz WAV. AudioSocket carries signed-linear mono PCM
 * at 8 kHz, so the samples are downsampled here — box-averaged so content above
 * the new Nyquist frequency is attenuated rather than aliased into a metallic
 * voice. The result is declared as `audio/L16;rate=8000;channels=1`, so no caller
 * has to assume a format.
 *
 * Tone is honoured rather than ignored
 * ------------------------------------
 * The port asks callers to state `CALM`, `URGENT` or `REASSURING` and records
 * whether the protocol's own wording was used. Pretending every prompt sounds the
 * same would make that record meaningless, so pace, pitch and volume are actually
 * varied — a reassurance prompt is slightly slower and lower. Urgent wording
 * stays at the configured pace so important numbers and instructions are not
 * rushed.
 */

const OUTPUT_SAMPLE_RATE = 8000;

export interface EspeakProviderOptions {
  binary: string;
  /** Default voice for the configured language, e.g. `en-gb`. */
  voice: string;
  /** Base words per minute; reassurance may slow it slightly. */
  speedWpm: number;
  timeoutMs: number;
  logger?: Logger;
}

export class EspeakSynthesisProvider implements TextToSpeechProvider {
  readonly providerName = 'espeak';
  readonly isLive = true;
  readonly supportedLanguages = ['en', 'ml'] as const;

  private readonly logger: Logger;

  constructor(private readonly options: EspeakProviderOptions) {
    this.logger = options.logger ?? noopLogger;
  }

  async synthesize(request: SynthesisRequest): Promise<SynthesisResult> {
    if (!this.supportedLanguages.includes(request.language as 'en' | 'ml')) {
      throw new AppError(
        ErrorCode.SPEECH_LANGUAGE_UNSUPPORTED,
        `The '${this.providerName}' provider cannot speak '${request.language}'. Supported: ${this.supportedLanguages.join(', ')}.`,
        422,
        { provider: this.providerName, language: request.language },
      );
    }

    const text = request.text.trim();
    if (text === '') {
      throw new AppError(ErrorCode.SPEECH_SYNTHESIS_FAILED, 'Cannot synthesize empty text.', 422, {
        provider: this.providerName,
      });
    }

    const voice = this.voiceFor(request.language);
    const delivery = this.deliveryFor(request.tone);
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'resus-espeak-'));

    try {
      const textPath = path.join(workDir, 'text.txt');
      const wavPath = path.join(workDir, 'audio.wav');
      await fs.writeFile(textPath, text, 'utf8');

      await runProcess(
        this.options.binary,
        [
          '-v',
          voice,
          '-s',
          String(delivery.speedWpm),
          '-p',
          String(delivery.pitch),
          '-a',
          String(delivery.amplitude),
          '-f',
          textPath,
          '-w',
          wavPath,
        ],
        { timeoutMs: this.options.timeoutMs },
      );

      const wav = await fs.readFile(wavPath);
      const decoded = decodeAudio(new Uint8Array(wav));
      const pcm = toMonoSlin(decoded, OUTPUT_SAMPLE_RATE);

      if (pcm.length === 0) {
        // A synthesiser that produced no samples is a failure, not a silent
        // success: reporting empty audio would look like "nothing was said" when
        // in fact the engine failed.
        throw new AppError(
          ErrorCode.SPEECH_SYNTHESIS_FAILED,
          `The '${this.options.binary}' engine produced no audio samples.`,
          502,
          { provider: this.providerName },
        );
      }

      const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
      this.logger.debug(
        { voice, tone: request.tone, samples: pcm.length, durationMs: durationMs(pcm, OUTPUT_SAMPLE_RATE) },
        'synthesized call audio',
      );

      return {
        audio: bytes.slice(),
        mimeType: `audio/L16;rate=${OUTPUT_SAMPLE_RATE};channels=1`,
        providerName: this.providerName,
        isLive: this.isLive,
        voice,
        durationMs: durationMs(pcm, OUTPUT_SAMPLE_RATE),
      };
    } finally {
      await fs.rm(workDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /**
   * Maps the system's language codes onto espeak-ng voice names.
   *
   * Malayalam has a dedicated voice; English uses the configured regional voice,
   * because a Kerala deployment that reads an English prompt in an American
   * accent is a correctness choice someone should make in configuration, not have
   * silently decided here.
   */
  private voiceFor(language: string): string {
    return language === 'ml' ? 'ml' : this.options.voice;
  }

  /** Translates the port's tone into real delivery parameters. */
  private deliveryFor(tone: SynthesisRequest['tone']): EspeakDelivery {
    return espeakDeliveryFor(this.options.speedWpm, tone);
  }
}

export interface EspeakDelivery {
  speedWpm: number;
  pitch: number;
  amplitude: number;
}

/** eSpeak NG's documented `-s` unit is approximate words per minute (default 175). */
export function espeakDeliveryFor(speedWpm: number, tone: SynthesisRequest['tone']): EspeakDelivery {
  switch (tone) {
    case 'URGENT':
      return { speedWpm, pitch: 65, amplitude: 130 };
    case 'REASSURING':
      return { speedWpm: Math.max(80, speedWpm - 10), pitch: 38, amplitude: 95 };
    case 'CALM':
    default:
      return { speedWpm, pitch: 50, amplitude: 110 };
  }
}
