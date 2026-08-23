/** Shell one-liner for a saved feed API key (non-Windows / Git Bash). */
export function nugetApiKeyExportCommand(apiKey: string): string {
  const quoted = `'${apiKey.replace(/'/g, `'\\''`)}'`;
  return `export NUGET_API_KEY=${quoted}`;
}
