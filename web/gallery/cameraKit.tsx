import { breach } from './breaches';

/** The gallery's camera, aliased over the platform one: there is none. */
export const CameraType = { Back: 'environment' } as const;

export function cameraSupported(): boolean {
  return false;
}

export function Camera(_props: unknown) {
  breach('camera');
  return null;
}
