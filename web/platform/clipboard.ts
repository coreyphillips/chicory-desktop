async function getString(): Promise<string> {
  if (!navigator.clipboard?.readText)
    throw new Error('Clipboard access is unavailable. Paste into the request field instead.');
  try {
    return await navigator.clipboard.readText();
  } catch {
    // A refused permission prompt, or a clipboard the system will not share.
    // Typing or pasting into the field still works.
    throw new Error('Chicory was not allowed to read the clipboard. Paste into the request field instead.');
  }
}
function setString(value: string): void {
  if (navigator.clipboard?.writeText) {
    void navigator.clipboard.writeText(value).catch(() => legacyCopy(value));
  } else legacyCopy(value);
}
function legacyCopy(value: string): void {
  const field = document.createElement('textarea');
  field.value = value;
  field.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
  field.setAttribute('readonly', '');
  document.body.append(field);
  field.select();
  try { document.execCommand('copy'); } finally { field.remove(); }
}
/** A secret goes on the clipboard only where the host can take it back. */
function canHoldSecret(): boolean {
  return typeof window !== 'undefined' && !!window.chicoryDesktop?.copySecret;
}
async function setSecret(value: string): Promise<boolean> {
  try {
    return (await window.chicoryDesktop?.copySecret?.(value)) === true;
  } catch {
    return false;
  }
}
export default { getString, setString, canHoldSecret, setSecret };
