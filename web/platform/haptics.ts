type Feedback = 'selection' | 'light' | 'medium' | 'rigid' | 'soft' | 'success' | 'warning' | 'error';
const pulses: Record<Feedback, number | number[]> = {
  selection: 8, light: 10, medium: 18, rigid: 14, soft: 6,
  success: [12, 40, 18], warning: 32, error: [20, 40, 20],
};
let enabled = true;
export function setHapticsEnabled(value: boolean): void { enabled = value; }
export function haptic(kind: Feedback = 'light'): void {
  if (!enabled || typeof navigator === 'undefined') return;
  try { navigator.vibrate?.(pulses[kind]); } catch { /* Optional hardware feedback. */ }
}
