export function localPoint(point: { x: number; y: number }, origin: { x: number; y: number }) {
  return { x: point.x - origin.x, y: point.y - origin.y };
}
