import assert from 'node:assert/strict';
import { test } from 'node:test';
import QRCode from 'qrcode';
import { decodeQrPixels } from './decodeQrImage.ts';
import { checkQrImageFile } from './qrImageSize.ts';

// Draw independent symbols on one screenshot, with a quiet zone around each.
function screenshot(codes: { text: string; inverted?: boolean }[]) {
  const side = 250;
  const width = side * Math.max(1, codes.length);
  const data = new Uint8ClampedArray(width * side * 4).fill(255);
  for (const [index, { text, inverted }] of codes.entries()) {
    const { modules } = QRCode.create(text);
    const scale = Math.floor(side / (modules.size + 8));
    const pad = Math.floor((side - modules.size * scale) / 2);
    for (let y = 0; y < side; y++) for (let x = 0; x < side; x++) {
      const row = Math.floor((y - pad) / scale), column = Math.floor((x - pad) / scale);
      const ink = row >= 0 && column >= 0 && row < modules.size && column < modules.size && !!modules.get(row, column);
      const offset = (y * width + index * side + x) * 4;
      data.fill(ink !== !!inverted ? 0 : 255, offset, offset + 3);
    }
  }
  return { data, width, height: side } as ImageData;
}

test('a local screenshot returns every distinct QR, including adjacent codes of opposite polarity', () => {
  const first = 'bitcoin:bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh';
  const second = 'bitcoin:1BoatSLRHtKNngkdXEeobR76b53LETtpyT';
  assert.deepEqual(decodeQrPixels(screenshot([])), []);
  assert.deepEqual(decodeQrPixels(screenshot([{ text: first }])), [first]);
  assert.deepEqual(decodeQrPixels(screenshot([{ text: first }, { text: first }])), [first]);
  assert.deepEqual(new Set(decodeQrPixels(screenshot([{ text: first }, { text: second, inverted: true }]))), new Set([first, second]));
});

test('oversized screenshot dimensions and disguised files are refused at the header', async () => {
  const png = await QRCode.toBuffer('sample');
  await checkQrImageFile(new Blob([png]));
  png.writeUInt32BE(100_000, 16);
  await assert.rejects(checkQrImageFile(new Blob([png])), /dimensions/);
  await assert.rejects(checkQrImageFile(new Blob(['<svg/>'], { type: 'image/png' })), /format/);
});
