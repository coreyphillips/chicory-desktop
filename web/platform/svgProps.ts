/** Translate the native SVG accessibility boundary to actual browser semantics. */
export function svgWebProps(props: Record<string, unknown>): Record<string, unknown> {
  const { accessibilityElementsHidden, importantForAccessibility, accessibilityLabel,
    accessibilityRole, accessible: _accessible, ...clean } = props;
  if (accessibilityElementsHidden === true || importantForAccessibility === 'no-hide-descendants' || importantForAccessibility === 'no')
    clean['aria-hidden'] = true;
  if (typeof accessibilityLabel === 'string' && clean['aria-label'] === undefined)
    clean['aria-label'] = accessibilityLabel;
  if (typeof accessibilityRole === 'string' && clean.role === undefined)
    clean.role = accessibilityRole === 'image' ? 'img' : accessibilityRole;
  return clean;
}
