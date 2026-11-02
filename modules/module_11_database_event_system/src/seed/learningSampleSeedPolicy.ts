/** Demo learning samples are written only when learning is explicitly enabled. */
export function isLearningSampleSeedEnabled(value: string | undefined): boolean {
  return value?.trim().toLowerCase() === 'true';
}
