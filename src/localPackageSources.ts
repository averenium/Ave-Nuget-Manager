/**
 * Telling a config file's local folder sources from remote feeds (#91).
 *
 * `dotnet package search` costs a process launch — measured at 223–554ms
 * against one config file — and the version list asks every config file in the
 * chain, once per package. A folder source cannot be skipped on the grounds
 * that it came back empty once (a real feed answers a package it does not have
 * exactly the same way), but it can be skipped on the grounds that the folder
 * plainly does not contain the package: a folder source serves the ids that are
 * directories inside it, and that is readable without asking the CLI.
 *
 * `Microsoft.VisualStudio.Offline.config` is the case on a normal Windows
 * install — one source pointing at `Microsoft SDKs\NuGetPackages`, which holds
 * around a hundred ids and is asked about every package regardless.
 *
 * Every uncertainty resolves to "ask the CLI": one wasted call is cheap, a
 * wrongly skipped source means a package the panel claims does not exist.
 */

import * as path from 'path';
import { extractSection, maskXmlComments } from './nugetConfigXmlSections';

export interface ConfigSourceKinds {
  /** Enabled folder sources, resolved against the config file's own directory. */
  folders: string[];
  /** An enabled source this cannot prove is a folder — a feed, or anything unrecognised. */
  hasNonLocal: boolean;
}

/**
 * A source value is a folder when it carries no URI scheme. UNC paths and
 * drive letters both qualify; `file://` deliberately does not, since resolving
 * it is more ways to be wrong than the call it would save.
 */
export function isLocalSourceValue(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  return !/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed);
}

function disabledKeys(xml: string): Set<string> {
  const section = maskXmlComments(extractSection(xml, 'disabledPackageSources'));
  const keys = new Set<string>();
  for (const m of section.matchAll(/<add\s+[^>]*key\s*=\s*"([^"]*)"[^>]*>/gi)) {
    keys.add(m[1].toLowerCase());
  }
  return keys;
}

export function classifyConfigSources(xml: string, configFilePath: string): ConfigSourceKinds {
  const section = maskXmlComments(extractSection(xml, 'packageSources'));
  const disabled = disabledKeys(xml);
  const baseDir = path.dirname(configFilePath);

  const folders: string[] = [];
  let hasNonLocal = false;

  for (const m of section.matchAll(/<add\s+([^>]*?)\/?>/gi)) {
    const attrs = m[1];
    const key = /key\s*=\s*"([^"]*)"/i.exec(attrs)?.[1];
    const value = /value\s*=\s*"([^"]*)"/i.exec(attrs)?.[1];
    if (key === undefined || value === undefined) {
      hasNonLocal = true;
      continue;
    }
    if (disabled.has(key.toLowerCase())) continue;
    if (isLocalSourceValue(value)) folders.push(path.resolve(baseDir, value));
    else hasNonLocal = true;
  }

  return { folders, hasNonLocal };
}
