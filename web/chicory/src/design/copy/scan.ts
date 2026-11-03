/**
 * The scan overlay's words. None of them is drawn: the disc, the reticle and
 * the glyphs carry them on screen, and a screen reader hears them from here.
 */
export const scan = {
  /** The overlay's name for a screen reader, where an eyebrow used to say it. */
  title: 'Scan',
  primaryTitle: 'Scan primary node QR',
  primaryPrivacy:
    'Chicory reads your primary node QR. Nothing is recorded or sent.',
  primaryNoCamera:
    'Enable the camera in settings, or paste your primary node address.',
  primaryDetected: 'Primary node address found.',
  /** What a node check that gives no reason of its own refuses with. */
  primaryInvalid: 'Invalid node address.',
  /** The Bitcoin address Settings > Empty wallet sends everything to. */
  addressTitle: 'Scan address QR',
  addressPrivacy:
    'Chicory reads the Bitcoin address QR. Nothing is recorded or sent.',
  addressNoCamera:
    'Enable the camera in settings, or paste the Bitcoin address.',
  addressDetected: 'Bitcoin address found.',
  addressInvalid: 'That code is not a Bitcoin address.',
  /** Its name once the camera turns out to be off. */
  camera: 'Camera',
  aim: 'Point at the code.',
  privacy:
    'Chicory uses the camera only to read a payment code. Nothing is recorded or sent.',
  starting: 'Getting the camera ready…',
  invalid: 'That code is not a payment request.',
  detected: 'Payment request found.',
  denied: 'Camera access is off.',
  noCamera:
    'Chicory needs the camera only to read a payment request. Turn it on in your device settings, or paste the request instead.',
  missing: 'Camera scanning is unavailable.',
  missingHint:
    'This build does not include the camera module. Rebuild the native app to enable scanning, or paste the request instead.',
  openSettings: 'Open camera settings',
  paste: 'Paste from clipboard',
  clipboardEmpty: 'The clipboard is empty.',
  clipboardUnreadable: 'Could not read the clipboard.',
  close: 'Close',
};
