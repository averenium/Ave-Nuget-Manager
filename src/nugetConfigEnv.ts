/**
 * Expand `%VAR%` in nuget.config values (NuGet 3.4+).
 * Windows-style tokens only — `$HOME` is not expanded, even on Unix.
 */

const TOKEN = /%([^%]+)%/g;

function lookupEnv(name: string, env: NodeJS.Dict<string>): string | undefined {
  if (Object.prototype.hasOwnProperty.call(env, name) && env[name] !== undefined) {
    return env[name];
  }
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(env)) {
    if (key.toLowerCase() === lower) return value;
  }
  return undefined;
}

/** Replace `%NAME%` with `env.NAME`. Unknown names stay as `%NAME%`. */
export function expandNuGetConfigValue(
  value: string,
  env: NodeJS.Dict<string> = process.env,
): string {
  return value.replace(TOKEN, (token, name: string) => {
    const found = lookupEnv(name, env);
    return found !== undefined ? found : token;
  });
}
