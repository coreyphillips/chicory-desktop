// A standard file input grants access to just the file the user picks.
export function pickQrImage(signal: AbortSignal): Promise<string[] | null> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/png,image/jpeg,image/webp';
    let worker: Worker | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    function clean() {
      signal.removeEventListener('abort', cancel);
      input.onchange = null;
      input.oncancel = null;
      clearTimeout(timer);
      worker?.terminate();
    }
    function cancel() {
      clean();
      resolve(null);
    }
    function fail() {
      clean();
      reject(new Error('Unreadable QR image.'));
    }
    signal.addEventListener('abort', cancel, { once: true });
    input.oncancel = cancel;
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) return cancel();
      try {
        worker = new Worker(new URL('./qrImage.worker.ts', import.meta.url), { type: 'module' });
        worker.onmessage = ({ data }: MessageEvent<string[] | null>) => {
          if (data === null) return fail();
          clean();
          resolve(data);
        };
        worker.onerror = fail;
        timer = setTimeout(fail, 15_000);
        worker.postMessage(file);
      } catch { fail(); }
    };
    try { input.showPicker(); } catch { fail(); }
  });
}
