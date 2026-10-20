/**
 * Sound track helpers.
 *
 * The sound itself lives in the project file as base64, so a project stays
 * self-contained. This module only turns those bytes into a waveform and
 * into the peaks the timeline draws. Decoding needs the Web Audio API, so it
 * only runs in the browser.
 */

/** How many peak values the waveform is reduced to. */
export const AUDIO_PEAK_BUCKETS = 400;

/** Turn base64 into bytes. */
export function base64ToBytes(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Turn bytes into base64. */
export function bytesToBase64(bytes) {
  let binary = "";
  const chunk = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk));
  }
  return btoa(binary);
}

/**
 * Decode a base64 sound into an AudioBuffer.
 *
 * Returns null when the browser cannot decode the data (an unsupported
 * codec, for example) instead of throwing, so the caller can report it.
 */
export async function decodeSound(base64) {
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) return null;
  try {
    const context = new AudioContextClass();
    const bytes = base64ToBytes(base64);
    const buffer = await context.decodeAudioData(bytes.buffer.slice(0));
    // The context is only needed for decoding; close it again.
    if (context.close) await context.close();
    return buffer;
  } catch {
    return null;
  }
}

/**
 * The peak envelope of a decoded sound: one value between 0 and 1 per
 * bucket, ready to be drawn as a waveform.
 */
export function soundPeaks(buffer, buckets = AUDIO_PEAK_BUCKETS) {
  if (!buffer || buffer.length === 0) return [];
  const count = Math.max(1, Math.min(buckets, buffer.length));
  const peaks = new Array(count).fill(0);
  const samples = buffer.getChannelData(0);
  const perBucket = samples.length / count;

  for (let index = 0; index < count; index += 1) {
    const from = Math.floor(index * perBucket);
    const to = Math.min(samples.length, Math.floor((index + 1) * perBucket));
    let peak = 0;
    for (let i = from; i < to; i += 1) {
      const value = Math.abs(samples[i]);
      if (value > peak) peak = value;
    }
    peaks[index] = peak;
  }
  return peaks;
}

/** A short WAV file of a beep, used to try the sound track out. */
export function beepWav(seconds = 0.5, frequency = 440) {
  const rate = 8000;
  const count = Math.floor(rate * seconds);
  const buffer = new ArrayBuffer(44 + count * 2);
  const view = new DataView(buffer);

  const write = (offset, text) => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
  };
  write(0, "RIFF");
  view.setUint32(4, 36 + count * 2, true);
  write(8, "WAVE");
  write(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  write(36, "data");
  view.setUint32(40, count * 2, true);

  for (let i = 0; i < count; i += 1) {
    const t = i / rate;
    // A short fade in and out so it does not click.
    const envelope = Math.min(1, t * 20, (seconds - t) * 20);
    const value = Math.sin(2 * Math.PI * frequency * t) * envelope * 0.3;
    view.setInt16(44 + i * 2, Math.round(value * 32767), true);
  }
  return bytesToBase64(new Uint8Array(buffer));
}
