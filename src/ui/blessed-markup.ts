export function escapeBlessedMarkup(value: string): string {
  return value.replace(/[{}]/g, (character) => (character === "{" ? "{open}" : "{close}"));
}
