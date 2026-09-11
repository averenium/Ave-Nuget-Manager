/**
 * Which target frameworks a project's `PackageReference` is conditioned on (#82).
 *
 * `dotnet add package` without `--framework` rewrites *every* conditional group
 * for the id to one version — measured, not assumed: a `net8.0` pin ends up
 * reading the `net10.0` target. So before a write, the project file itself is
 * asked what shape the reference is in, and each conditional group is then
 * updated on its own with `--framework`. The file is the authority here rather
 * than the model, because it is what the write is about to change.
 *
 * Both spellings a real project uses are recognised — the condition on the
 * `ItemGroup`, and the condition on the `PackageReference` element — and
 * anything not understood is reported as such, so the caller can fall back to
 * the plain single call it would have made anyway instead of guessing.
 */

import { findPackageReferenceSpans } from './legacyPackageReference';
import { maskXmlComments } from './xmlComments';

export interface ReferenceCondition {
  /** TFM the reference is conditioned on, for a plain `TargetFramework` equality. */
  framework?: string;
  /** The reference carries a condition that is not a plain TFM equality. */
  unknown?: boolean;
  /** Version this reference currently asks for, when the file states one plainly. */
  version?: string;
}

/**
 * `'$(TargetFramework)' == 'net9.0'` and its spacing variants, in either order.
 * Only equality counts: a `!=` or a `Contains(...)` says which frameworks are
 * excluded, not which one this reference belongs to, and treating it as a pin
 * would write into the wrong group.
 */
const TFM_EQUALITY = [
  /^\s*'\$\(TargetFramework\)'\s*==\s*'([^']+)'\s*$/i,
  /^\s*'([^']+)'\s*==\s*'\$\(TargetFramework\)'\s*$/i,
  /^\s*\$\(TargetFramework\)\s*==\s*'([^']+)'\s*$/i,
];

function conditionFramework(condition: string): ReferenceCondition {
  for (const re of TFM_EQUALITY) {
    const m = re.exec(condition);
    if (m) return { framework: m[1] };
  }
  return { unknown: true };
}

/** Leading major of a version, or undefined when it does not start with digits. */
function majorOf(version: string): number | undefined {
  const m = /^(\d+)/.exec(version.trim());
  return m ? parseInt(m[1], 10) : undefined;
}

/** The version a `PackageReference` asks for — attribute or child element. */
function referenceVersion(text: string): string | undefined {
  const attr = /\bVersion\s*=\s*"([^"]*)"|\bVersion\s*=\s*'([^']*)'/i.exec(text);
  if (attr) return attr[1] ?? attr[2];
  const child = /<Version\s*>([^<]*)<\/Version\s*>/i.exec(text);
  return child ? child[1].trim() : undefined;
}

/** The `Condition` attribute of an element's opening tag, if it has one. */
function conditionAttribute(tag: string): string | undefined {
  const m = /\bCondition\s*=\s*"([^"]*)"|\bCondition\s*=\s*'([^']*)'/i.exec(tag);
  if (!m) return undefined;
  return m[1] ?? m[2];
}

/**
 * The `<ItemGroup …>` opening tag enclosing `offset`, searching backwards. Runs
 * over comment-masked text so an `<ItemGroup>` mentioned inside a comment
 * cannot be mistaken for the real enclosing one — the same hazard #85 fixed for
 * `PackageReference` itself.
 */
function enclosingItemGroupTag(masked: string, raw: string, offset: number): string | undefined {
  const open = masked.lastIndexOf('<ItemGroup', offset);
  if (open < 0) return undefined;
  const close = masked.indexOf('>', open);
  if (close < 0 || close > offset) return undefined;
  // A closing </ItemGroup> between the two means this reference is not inside it.
  if (masked.lastIndexOf('</ItemGroup', offset) > close) return undefined;
  return raw.slice(open, close + 1);
}

/**
 * One entry per `PackageReference` for `packageId`, saying which framework it
 * is conditioned on. An unconditional reference yields an empty object — no
 * framework, not unknown.
 */
export function referenceConditions(xml: string, packageId: string): ReferenceCondition[] {
  const masked = maskXmlComments(xml);
  return findPackageReferenceSpans(xml, packageId).map((span) => {
    const version = referenceVersion(span.text);
    const elementCondition = conditionAttribute(span.text);
    if (elementCondition !== undefined) return { ...conditionFramework(elementCondition), version };

    const groupTag = enclosingItemGroupTag(masked, xml, span.start);
    const groupCondition = groupTag === undefined ? undefined : conditionAttribute(groupTag);
    if (groupCondition === undefined) return { version };
    return { ...conditionFramework(groupCondition), version };
  });
}

/**
 * The frameworks a version change has to be written to one at a time, when the
 * caller did not name one.
 *
 * Empty means "write once, with no `--framework`" — which covers an
 * unconditional reference, a package the project does not have yet, and any
 * condition this module could not read. Falling back to the plain call there is
 * deliberate: it is exactly what the code did before this existed, so an
 * unfamiliar condition can never make a write worse than it already was.
 *
 * `targetVersion` narrows the list twice over. Groups outside that version's
 * major line are left alone — a per-framework pin exists to keep `net9.0` on
 * 9.x while `net10.0` moves through 10.x, so a batch that decided on a 10.x
 * target has no business rewriting the 9.x group, and the update that belongs
 * to it arrives as its own item with its own target. Groups already *at* the
 * target are dropped too: there is nothing to write, and asking the file rather
 * than one arbitrary reference is the only way to know that for a package the
 * project references several times.
 */
export function frameworksToUpdate(
  xml: string,
  packageId: string,
  targetVersion?: string,
  opts?: {
    /**
     * Write every conditional group regardless of its line, because the user was
     * shown what that crosses and said yes (#82). Groups already at the target
     * are still left alone — there is nothing to write in them either way.
     */
    acrossLines?: boolean;
  },
): string[] {
  const conditions = referenceConditions(xml, packageId);
  if (conditions.length === 0) return [];
  if (conditions.some((c) => c.unknown || !c.framework)) return [];

  const line = targetVersion === undefined || opts?.acrossLines
    ? undefined
    : majorOf(targetVersion);
  const frameworks: string[] = [];
  for (const { framework, version } of conditions) {
    if (!framework || frameworks.includes(framework)) continue;
    // A group whose own version cannot be read stays in: dropping it would
    // silently skip a framework the caller asked to change.
    if (line !== undefined && version !== undefined && majorOf(version) !== line) continue;
    if (targetVersion !== undefined && version === targetVersion) continue;
    frameworks.push(framework);
  }
  return frameworks;
}

/**
 * Whether every reference to this id names a target framework — the shape where
 * "is it already at that version?" cannot be answered by reading one reference,
 * because the project holds several and they disagree on purpose (#82).
 */
export function isFrameworkScopedReference(xml: string, packageId: string): boolean {
  const conditions = referenceConditions(xml, packageId);
  return conditions.length > 0 && conditions.every((c) => !!c.framework);
}

/** The version one framework's conditional group currently asks for. */
export function versionForFramework(
  xml: string,
  packageId: string,
  framework: string,
): string | undefined {
  return referenceConditions(xml, packageId)
    .find((c) => c.framework === framework)?.version;
}

/**
 * Whether the id is referenced by one unconditional `PackageReference` in a
 * project that targets more than one framework — the case where narrowing to a
 * single framework cannot be delegated to `dotnet add --framework`, because it
 * would edit that shared line and move every framework with it.
 */
export function hasSharedReference(xml: string, packageId: string): boolean {
  const conditions = referenceConditions(xml, packageId);
  return conditions.length > 0 && conditions.some((c) => !c.framework && !c.unknown);
}

const TARGET_FRAMEWORKS = /<TargetFrameworks\s*>([\s\S]*?)<\/TargetFrameworks\s*>/gi;
const TARGET_FRAMEWORK = /<TargetFramework\s*>([\s\S]*?)<\/TargetFramework\s*>/gi;

/**
 * The value of a plain `<Tag>…</Tag>` property, one entry per element. Read off
 * comment-masked text so a property named inside a comment cannot be picked up,
 * and returned from the raw text so the value itself is untouched.
 */
function propertyValues(xml: string, re: RegExp): string[] {
  const masked = maskXmlComments(xml);
  const values: string[] = [];
  re.lastIndex = 0;
  for (let m = re.exec(masked); m; m = re.exec(masked)) {
    const open = m.index + m[0].indexOf('>') + 1;
    const close = m.index + m[0].lastIndexOf('</');
    values.push(xml.slice(open, close));
  }
  return values;
}

/**
 * The target frameworks the project file states outright, or an empty list when
 * it does not state them plainly (#82).
 *
 * Rebuilding a shared reference into one group per framework needs the whole
 * set: the groups for the frameworks the user left alone have to be written
 * back too, or removing the shared line would take the package out of them
 * entirely. The file answers this exactly when the value is literal. A `$(…)`
 * property, a conditioned or repeated `TargetFrameworks` — anything that only
 * MSBuild can evaluate — is reported as unknown rather than guessed, so the
 * caller can ask the evaluated list instead of rebuilding from half a set.
 */
export function declaredFrameworks(xml: string): string[] {
  const multi = propertyValues(xml, TARGET_FRAMEWORKS);
  const values = multi.length > 0 ? multi : propertyValues(xml, TARGET_FRAMEWORK);
  if (values.length !== 1 || values[0].includes('$(')) return [];
  return values[0].split(';').map((f) => f.trim()).filter(Boolean);
}
