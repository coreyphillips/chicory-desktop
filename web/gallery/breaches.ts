/**
 * Renderer guards for the gallery. The gallery window also has no preload,
 * no persistent partition and a request filter (scripts/desktop/
 * gallery-window.cjs). These guards make any attempt visible to the runner
 * instead of letting it fail quietly inside a scene.
 */
const found: string[] = [];

export function breach(what: string) {
  found.push(what);
  console.error(`GALLERY BREACH ${what}`);
}

export function breaches(): string[] {
  return [...found];
}

function refuse(what: string) {
  return () => {
    breach(what);
    throw new Error(`The gallery has no ${what}.`);
  };
}

function replace(target: object, key: string, value: unknown) {
  Object.defineProperty(target, key, { value, configurable: false, writable: false });
}

export function seal() {
  if ((window as { chicoryDesktop?: unknown }).chicoryDesktop) {
    throw new Error('The gallery found the desktop bridge and will not start.');
  }
  replace(window, 'fetch', (input: unknown) => {
    breach(`network ${String(input)}`);
    return Promise.reject(new Error('The gallery has no network.'));
  });
  for (const name of ['XMLHttpRequest', 'WebSocket', 'EventSource']) {
    replace(window, name, function Refused() {
      refuse(`network (${name})`)();
    });
  }
  replace(navigator, 'sendBeacon', refuse('network (beacon)'));
  replace(navigator, 'clipboard', {
    readText: refuse('clipboard read'),
    read: refuse('clipboard read'),
    writeText: refuse('clipboard write'),
    write: refuse('clipboard write'),
  });
  replace(navigator, 'mediaDevices', {
    getUserMedia: refuse('camera'),
    enumerateDevices: refuse('camera'),
  });
}
