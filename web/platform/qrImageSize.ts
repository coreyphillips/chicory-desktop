import { PNG } from 'image-size/types/png';
import { JPG } from 'image-size/types/jpg';
import { WEBP } from 'image-size/types/webp';

export function checkQrImageSize(width: number, height: number) {
  if (!(width > 0 && height > 0 && width <= 8192 && height <= 8192 && width * height <= 20_000_000))
    throw new Error('Unsupported image dimensions.');
}

/** Inspect the encoded header before asking Chromium to allocate a bitmap. */
export async function checkQrImageFile(file: Blob) {
  if (file.size > 24 * 1024 * 1024) throw new Error('Image file too large.');
  const header = new Uint8Array(await file.slice(0, 1024 * 1024).arrayBuffer());
  const format = [PNG, JPG, WEBP].find(reader => reader.validate(header));
  if (!format) throw new Error('Unsupported image format.');
  const { width, height } = format.calculate(header);
  checkQrImageSize(width, height);
}
