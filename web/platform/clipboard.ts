async function getString(): Promise<string> {
  if (!navigator.clipboard?.readText)
    throw new Error('Clipboard access is unavailable. Paste into the request field instead.');
  return navigator.clipboard.readText();
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
export default { getString, setString };
