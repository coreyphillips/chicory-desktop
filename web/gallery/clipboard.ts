/** The gallery's clipboard, aliased over the platform one: it never reads or writes. */
export async function getString(): Promise<string> {
  return '';
}

export function setString(_value: string) {}

export const canHoldSecret = () => true;
export async function setSecret(_value: string) {
  return true;
}

export default { getString, setString, canHoldSecret, setSecret };
