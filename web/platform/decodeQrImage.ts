import { binarize, Decoder, Detector, grayscale } from '@nuintun/qrcode';

/** Read every recognizable symbol, including light codes on dark backgrounds. */
export function decodeQrPixels(image: ImageData): string[] {
  const matrix = binarize(grayscale(image), image.width, image.height);
  const detector = new Detector();
  const decoder = new Decoder();
  const codes = new Set<string>();
  for (const inverted of [false, true]) {
    if (inverted) matrix.flip();
    const candidates = detector.detect(matrix);
    let candidate = candidates.next();
    while (!candidate.done) {
      let decoded = false;
      try {
        codes.add(decoder.decode(candidate.value.matrix).content);
        decoded = true;
      } catch { /* Finder patterns can resemble a code without encoding one. */ }
      candidate = candidates.next(decoded);
    }
  }
  return [...codes];
}
