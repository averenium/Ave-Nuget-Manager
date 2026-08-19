/**
 * Family prefix: first two segments (`Microsoft.EntityFrameworkCore.SqlServer`
 * and `Microsoft.EntityFrameworkCore` → `Microsoft.EntityFrameworkCore`).
 * Single-segment ids (`Serilog`) have no family.
 */
export function packageFamilyId(packageId: string): string | null {
  const parts = packageId.split('.').filter((p) => p.length > 0);
  if (parts.length < 2) return null;
  return `${parts[0]}.${parts[1]}`;
}
