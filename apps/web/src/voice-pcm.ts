export function wavFromFrames(frames: Float32Array[]): string {
  const count = Math.min(
    600000,
    frames.reduce((n, frame) => n + frame.length, 0),
  );
  const buffer = new ArrayBuffer(44 + count * 2),
    view = new DataView(buffer);
  const text = (offset: number, value: string) =>
    [...value].forEach((ch, i) => view.setUint8(offset + i, ch.charCodeAt(0)));
  text(0, "RIFF");
  view.setUint32(4, buffer.byteLength - 8, true);
  text(8, "WAVE");
  text(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 24000, true);
  view.setUint32(28, 48000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, "data");
  view.setUint32(40, count * 2, true);
  let index = 0;
  for (const frame of frames)
    for (const raw of frame) {
      if (index >= count) break;
      const v = Math.max(-1, Math.min(1, raw));
      view.setInt16(44 + index++ * 2, v < 0 ? v * 32768 : v * 32767, true);
    }
  return bytesBase64(new Uint8Array(buffer));
}
export function bytesBase64(bytes: Uint8Array) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 8192)
    binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(binary);
}
export function pcmBytes(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (ch) => ch.charCodeAt(0));
}
export function pcmBuffer(context: AudioContext, bytes: Uint8Array) {
  const buffer = context.createBuffer(1, bytes.length / 2, 24000),
    channel = buffer.getChannelData(0);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i < channel.length; i++)
    channel[i] = view.getInt16(i * 2, true) / 32768;
  return buffer;
}
