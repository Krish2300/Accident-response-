/**
 * PCM / WAV helpers for the real speech engines.
 *
 * Why these live here
 * -------------------
 * Audio has to change shape twice on this system:
 *   - the telephony bridge carries signed-linear mono PCM (Asterisk's AudioSocket
 *     format), which whisper.cpp cannot read because it requires a 16 kHz WAV;
 *   - espeak-ng writes a WAV at 22.05 kHz, which is not what AudioSocket sends.
 *
 * Both are real conversions of real samples — never padding, never silence, never
 * a buffer that merely *looks* like the right size. Every function here either
 * returns correctly reshaped audio or throws, because a silent failure here would
 * turn into "the caller heard nothing" or "whisper was fed the wrong rate",
 * neither of which is visible from the outside.
 */

/** 16-bit signed range. Kept in one place so clamping is consistent. */
const MIN_I16 = -32768;
const MAX_I16 = 32767;

export interface DecodedAudio {
  /** Mono signed 16-bit little-endian samples. */
  pcm: Int16Array;
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
}

/** True when the buffer begins with a RIFF/WAVE header rather than raw PCM. */
export function looksLikeWav(buffer: Uint8Array): boolean {
  return (
    buffer.length >= 12 &&
    buffer[0] === 0x52 &&
    buffer[1] === 0x49 &&
    buffer[2] === 0x46 &&
    buffer[3] === 0x46 &&
    buffer[8] === 0x57 &&
    buffer[9] === 0x41 &&
    buffer[10] === 0x56 &&
    buffer[11] === 0x45
  );
}

/**
 * Interprets an audio payload.
 *
 * WAV is parsed for its real parameters; anything else is treated as raw signed
 * 16-bit little-endian mono at `assumedSampleRate`, which is exactly what
 * AudioSocket delivers. A non-16-bit WAV is rejected rather than reinterpreted:
 * an 8-bit or 32-bit stream silently read as 16-bit produces plausible-sounding
 * noise that no downstream check can distinguish from speech.
 */
export function decodeAudio(buffer: Uint8Array, assumedSampleRate = 8000): DecodedAudio {
  if (!looksLikeWav(buffer)) {
    return { pcm: int16FromBytes(buffer, 0, buffer.length), sampleRate: assumedSampleRate, channels: 1, bitsPerSample: 16 };
  }
  return decodeWav(buffer);
}

function decodeWav(buffer: Uint8Array): DecodedAudio {
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  if (view.byteLength < 44) throw new Error('WAV buffer is shorter than a 44-byte header.');

  let offset = 12;
  let sampleRate = 0;
  let channels = 0;
  let bitsPerSample = 0;
  let dataStart = -1;
  let dataLength = 0;

  while (offset + 8 <= view.byteLength) {
    const chunkId = String.fromCharCode(view.getUint8(offset), view.getUint8(offset + 1), view.getUint8(offset + 2), view.getUint8(offset + 3));
    const chunkSize = view.getUint32(offset + 4, true);
    const body = offset + 8;

    if (chunkId === 'fmt ') {
      channels = view.getUint16(body + 2, true);
      sampleRate = view.getUint32(body + 4, true);
      bitsPerSample = view.getUint16(body + 14, true);
    } else if (chunkId === 'data') {
      dataStart = body;
      dataLength = Math.min(chunkSize, view.byteLength - body);
    }

    // Chunks are word-aligned: an odd size is followed by a pad byte.
    offset = body + chunkSize + (chunkSize % 2);
    if (dataStart !== -1 && sampleRate !== 0) break;
  }

  if (dataStart === -1) throw new Error('WAV buffer contains no data chunk.');
  if (sampleRate === 0 || channels === 0) throw new Error('WAV buffer has an unusable format chunk.');
  if (bitsPerSample !== 16) {
    throw new Error(`WAV must be 16-bit; received ${bitsPerSample}-bit audio.`);
  }

  const interleaved = int16FromBytes(new Uint8Array(view.buffer, view.byteOffset + dataStart, dataLength), 0, dataLength);
  const pcm = channels === 1 ? interleaved : downmixToMono(interleaved, channels);
  return { pcm, sampleRate, channels, bitsPerSample };
}

function int16FromBytes(bytes: Uint8Array, start: number, length: number): Int16Array {
  const usable = Math.max(0, length - (length % 2));
  const out = new Int16Array(usable / 2);
  for (let i = 0; i < out.length; i += 1) {
    const at = start + i * 2;
    out[i] = (bytes[at] as number) | ((bytes[at + 1] as number) << 8);
  }
  return out;
}

/** Averages each frame of interleaved channels into one mono sample. */
export function downmixToMono(interleaved: Int16Array, channels: number): Int16Array {
  if (channels <= 1) return interleaved;
  const frames = Math.floor(interleaved.length / channels);
  const out = new Int16Array(frames);
  for (let i = 0; i < frames; i += 1) {
    let sum = 0;
    for (let c = 0; c < channels; c += 1) sum += interleaved[i * channels + c] ?? 0;
    out[i] = clampI16(Math.round(sum / channels));
  }
  return out;
}

/**
 * Resamples mono 16-bit PCM between sample rates.
 *
 * Downsampling averages every input sample that falls into an output frame, which
 * is a box filter — crude but genuinely attenuates content above the new Nyquist
 * frequency, so a 22 kHz voice does not alias into a metallic 8 kHz one.
 * Upsampling interpolates between neighbours rather than duplicating samples,
 * which would leave an audible staircase in a whisper.
 */
export function resampleMono16(input: Int16Array, fromRate: number, toRate: number): Int16Array {
  if (fromRate <= 0 || toRate <= 0) {
    throw new Error(`Sample rates must be positive; received ${fromRate} -> ${toRate}.`);
  }
  if (fromRate === toRate || input.length === 0) return input;

  const ratio = fromRate / toRate;
  const outLength = Math.max(1, Math.round((input.length * toRate) / fromRate));
  const out = new Int16Array(outLength);

  if (toRate < fromRate) {
    for (let i = 0; i < outLength; i += 1) {
      const start = Math.floor(i * ratio);
      const end = Math.max(start, Math.ceil((i + 1) * ratio) - 1);
      let sum = 0;
      let count = 0;
      for (let j = start; j <= end && j < input.length; j += 1) {
        sum += input[j] as number;
        count += 1;
      }
      out[i] = count > 0 ? clampI16(Math.round(sum / count)) : 0;
    }
    return out;
  }

  for (let i = 0; i < outLength; i += 1) {
    const position = i * ratio;
    const index = Math.floor(position);
    const fraction = position - index;
    const a = input[index] ?? 0;
    const b = input[index + 1] ?? a;
    out[i] = clampI16(Math.round(a + (b - a) * fraction));
  }
  return out;
}

/** Wraps mono 16-bit PCM in a canonical 44-byte WAV header. */
export function encodeWav(pcm: Int16Array, sampleRate: number): Uint8Array {
  const dataSize = pcm.length * 2;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(view, 8, 'WAVE');
  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeAscii(view, 36, 'data');
  view.setUint32(40, dataSize, true);

  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < pcm.length; i += 1) {
    const sample = pcm[i] as number;
    bytes[44 + i * 2] = sample & 0xff;
    bytes[44 + i * 2 + 1] = (sample >> 8) & 0xff;
  }
  return bytes;
}

/** Converts decoded audio to raw mono 16-bit little-endian bytes at `toRate`. */
export function toMonoSlin(audio: DecodedAudio, toRate: number): Int16Array {
  return resampleMono16(audio.pcm, audio.sampleRate, toRate);
}

function writeAscii(view: DataView, offset: number, text: string): void {
  for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
}

function clampI16(value: number): number {
  if (value < MIN_I16) return MIN_I16;
  if (value > MAX_I16) return MAX_I16;
  return value;
}

/** Duration of a PCM buffer in milliseconds. */
export function durationMs(pcm: Int16Array, sampleRate: number): number {
  if (sampleRate <= 0 || pcm.length === 0) return 0;
  return Math.round((pcm.length / sampleRate) * 1000);
}
