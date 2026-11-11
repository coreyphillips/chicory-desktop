import { decodeQrPixels } from './decodeQrImage';
import { checkQrImageFile, checkQrImageSize } from './qrImageSize';

self.onmessage = async ({ data: file }: MessageEvent<File>) => {
  let image: ImageBitmap | undefined;
  try {
    await checkQrImageFile(file);
    image = await createImageBitmap(file);
    const { width, height } = image;
    checkQrImageSize(width, height);
    const context = new OffscreenCanvas(width, height).getContext('2d');
    if (!context) throw new Error('Canvas unavailable.');
    context.fillStyle = 'white';
    context.fillRect(0, 0, width, height);
    context.drawImage(image, 0, 0);
    self.postMessage(decodeQrPixels(context.getImageData(0, 0, width, height)));
  } catch {
    self.postMessage(null);
  } finally {
    image?.close();
  }
};
