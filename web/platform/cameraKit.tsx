import React, { useEffect, useRef, useState } from 'react';
import type { IScannerControls } from '@zxing/browser';

interface CameraProps {
  onReadCode?: (event: { nativeEvent: { codeStringValue: string } }) => void;
  onError?: (error: unknown) => void;
  scanThrottleDelay?: number;
  [key: string]: unknown;
}
interface Detector {
  detect(source: HTMLVideoElement): Promise<{ rawValue: string }[]>;
}
type DetectorConstructor = {
  new (options: { formats: string[] }): Detector;
  getSupportedFormats?: () => Promise<string[]>;
};

export const CameraType = { Back: 'environment' } as const;
export function cameraSupported(): boolean {
  return typeof window !== 'undefined' && window.isSecureContext &&
    typeof navigator.mediaDevices?.getUserMedia === 'function';
}

/** Camera frames are decoded in this browser and are never uploaded. */
export function Camera(props: CameraProps) {
  const video = useRef<HTMLVideoElement>(null);
  const latest = useRef(props);
  latest.current = props;
  const [visible, setVisible] = useState(() => document.visibilityState !== 'hidden');

  useEffect(() => {
    const change = () => setVisible(document.visibilityState !== 'hidden');
    document.addEventListener('visibilitychange', change);
    return () => document.removeEventListener('visibilitychange', change);
  }, []);

  useEffect(() => {
    if (!visible) return;
    let active = true;
    let stream: MediaStream | null = null;
    let controls: IScannerControls | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const close = () => {
      controls?.stop();
      controls = null;
      stream?.getTracks().forEach(track => track.stop());
      stream = null;
      if (video.current) video.current.srcObject = null;
      if (timer) clearTimeout(timer);
      timer = null;
    };
    const emit = (value: string) => {
      if (active && value) latest.current.onReadCode?.({ nativeEvent: { codeStringValue: value } });
    };
    const open = async () => {
      if (!cameraSupported()) throw new Error('Camera access requires HTTPS or localhost. Paste the request into Send instead.');
      const opened = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: 'environment' } },
      });
      if (!active) { opened.getTracks().forEach(track => track.stop()); return; }
      stream = opened;
      const element = video.current;
      if (!element) { close(); return; }
      element.srcObject = stream;
      await element.play();
      if (!active) { close(); return; }

      const Detector = (globalThis as typeof globalThis & { BarcodeDetector?: DetectorConstructor }).BarcodeDetector;
      let detector: Detector | null = null;
      if (Detector) {
        try {
          const formats = await Detector.getSupportedFormats?.();
          if (!formats || formats.includes('qr_code')) detector = new Detector({ formats: ['qr_code'] });
        } catch { /* Use the local JavaScript decoder below. */ }
      }
      if (!active) { close(); return; }
      if (detector) {
        const scan = async () => {
          if (!active || !detector) return;
          try {
            if (element.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
              for (const result of await detector.detect(element)) emit(result.rawValue);
            }
          } catch { /* A frame with no readable QR is normal. */ }
          if (active) timer = setTimeout(scan, Math.max(100, latest.current.scanThrottleDelay ?? 600));
        };
        void scan();
      } else {
        // Load the fallback decoder only when a camera needs it.
        const { BrowserQRCodeReader } = await import('@zxing/browser');
        if (!active) { close(); return; }
        const reader = new BrowserQRCodeReader(undefined, {
          delayBetweenScanAttempts: Math.max(100, latest.current.scanThrottleDelay ?? 600),
          delayBetweenScanSuccess: Math.max(100, latest.current.scanThrottleDelay ?? 600),
        });
        const started = await reader.decodeFromStream(stream, element, result => {
          if (result) emit(result.getText());
        });
        if (!active) started.stop();
        else controls = started;
      }
    };
    void open().catch(error => {
      close();
      if (active) latest.current.onError?.(error);
    });
    return () => { active = false; close(); };
  }, [visible]);

  return <video ref={video} autoPlay playsInline muted aria-hidden="true"
    style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }} />;
}
