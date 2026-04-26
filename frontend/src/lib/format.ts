export function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

export function getInitials(name: string): string {
  return name
    .split(' ')
    .map((n) => n[0])
    .join('')
    .toUpperCase()
    .slice(0, 2);
}

export const KIB = 1024;
export const MIB = 1024 * 1024;

export function formatBytes(n: number): string {
  if (n < KIB) return `${n} B`;
  if (n < MIB) return `${(n / KIB).toFixed(1)} KB`;
  return `${(n / MIB).toFixed(1)} MB`;
}

export function bytesToMib(bytes: number): number {
  return Math.round(bytes / MIB);
}

export function mibToBytes(mib: number): number {
  return Math.floor(mib * MIB);
}
