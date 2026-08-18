/** Extract filename with extension from an absolute path (browser-safe, no Node path) */
export function fileName(p: string): string {
  return p.split(/[\\/]/).pop() ?? p;
}

/** Extract filename without extension */
export function fileNameNoExt(p: string): string {
  const name = fileName(p);
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
}
