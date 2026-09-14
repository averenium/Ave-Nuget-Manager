import { licenseChange, takesNothingAway } from '../../packageLicense';
import type { PackageLicense } from '../../types';

const expression = (value: string): PackageLicense => ({ type: 'expression', value });
const file = (value: string): PackageLicense => ({ type: 'file', value });

/**
 * Every case here is a shape seen on the public feed, named by that shape.
 * The measurements behind them: `SixLabors.ImageSharp` states `Apache-2.0`
 * through 2.x and nothing at all from 3.x, where its nuspec carries
 * `<license type="file">LICENSE</license>`; `Newtonsoft.Json` states nothing
 * for its first 63 versions and `MIT` for the 21 newest, which is the
 * `<license>` element arriving rather than the licence moving.
 */
describe('licenseChange', () => {
  it('reports an expression giving way to a file, and says it cannot be named', () => {
    expect(licenseChange(expression('Apache-2.0'), file('LICENSE'))).toEqual({
      from: { text: 'Apache-2.0', file: false, url: 'https://licenses.nuget.org/Apache-2.0' },
      to: { text: 'LICENSE', file: true, url: undefined },
      unnamed: true,
    });
  });

  it('reports one expression giving way to another', () => {
    expect(licenseChange(expression('MIT'), expression('MIT AND Apache-2.0'))).toEqual({
      from: { text: 'MIT', file: false, url: 'https://licenses.nuget.org/MIT' },
      // Two documents, so there is no single address to send the reader to —
      // the attribute column renders each identifier as its own badge instead.
      to: { text: 'MIT AND Apache-2.0', file: false, url: undefined },
      unnamed: false,
    });
  });

  it('reports a file giving way to an expression, which is nameable again', () => {
    expect(licenseChange(file('LICENSE'), expression('MIT'))).toEqual({
      from: { text: 'LICENSE', file: true, url: undefined },
      to: { text: 'MIT', file: false, url: 'https://licenses.nuget.org/MIT' },
      unnamed: false,
    });
  });

  it('gives a file licence somewhere to be read when the feed states a page for it', () => {
    // The one use `licenseUrl` is put to. It is never compared: on the public
    // feed it embeds the version, so comparing URLs reports a change per bump.
    const change = licenseChange(expression('Apache-2.0'), file('LICENSE'), {
      selected: 'https://www.nuget.org/packages/Example.Imaging/3.1.5/license',
    });
    expect(change?.to.url).toBe('https://www.nuget.org/packages/Example.Imaging/3.1.5/license');
  });

  it('ignores the deprecated-field placeholder, which explains a field rather than stating a licence', () => {
    const change = licenseChange(expression('Apache-2.0'), file('LICENSE'), {
      selected: 'https://aka.ms/deprecateLicenseUrl',
    });
    expect(change?.to.url).toBeUndefined();
  });

  it('says nothing when the same expression is spelled differently', () => {
    expect(licenseChange(expression('MIT'), expression(' mit '))).toBeUndefined();
    expect(licenseChange(expression('MIT AND Apache-2.0'), expression('MIT  AND  Apache-2.0'))).toBeUndefined();
  });

  it('says nothing when the installed version declares no licence at all', () => {
    // The `<license>` element arriving on a newer version is not the licence
    // moving, and this is the common case on any long-lived package.
    expect(licenseChange(undefined, expression('MIT'))).toBeUndefined();
    expect(licenseChange(undefined, file('LICENSE'))).toBeUndefined();
  });

  it('says nothing when the selected version declares no licence', () => {
    expect(licenseChange(expression('Apache-2.0'), undefined)).toBeUndefined();
  });

  it('says nothing when both are files, since neither can be read', () => {
    expect(licenseChange(file('LICENSE'), file('LICENSE.txt'))).toBeUndefined();
    expect(licenseChange(file('LICENSE'), file('LICENSE'))).toBeUndefined();
  });

  it('says nothing when the file name states the licence the other side declares', () => {
    // `Microsoft.NET.Test.Sdk` moves from `LICENSE_MIT.txt` to `MIT` — the same
    // licence, and a row here would be noise the real cases pay for.
    expect(licenseChange(file('LICENSE_MIT.txt'), expression('MIT'))).toBeUndefined();
    expect(licenseChange(expression('MIT'), file('LICENSE_MIT.txt'))).toBeUndefined();
    expect(licenseChange(file('LICENSE-Apache-2.0'), expression('Apache-2.0'))).toBeUndefined();
  });

  it('still reports a file whose name says nothing about what is in it', () => {
    // `EasyNetQ` moves from `licence.txt` to `MIT`, and nothing in that name is
    // evidence of anything.
    expect(licenseChange(file('licence.txt'), expression('MIT'))).toBeDefined();
    expect(licenseChange(file('LICENSE'), expression('MIT'))).toBeDefined();
    // One file cannot be evidence of two licences.
    expect(licenseChange(file('LICENSE_MIT.txt'), expression('MIT AND Apache-2.0'))).toBeDefined();
    // A name that merely contains the identifier is not the identifier:
    // `MITigation` is not a licence.
    expect(licenseChange(file('MITigation.txt'), expression('MIT'))).toBeDefined();
  });

  it('points a file licence at the copy on disk, which is the text that binds', () => {
    const change = licenseChange(
      file('LICENSE'), expression('MIT'), undefined, '/cache/example/1.0.0/LICENSE',
    );
    expect(change?.from.filePath).toBe('/cache/example/1.0.0/LICENSE');
  });

  it('says nothing when the selected expression only adds an alternative', () => {
    // A second way to comply takes nothing away, so there is no consequence to
    // report — and Problems is where consequences go.
    expect(licenseChange(expression('MIT'), expression('MIT OR Apache-2.0'))).toBeUndefined();
  });

  it('reports an alternative being withdrawn', () => {
    expect(licenseChange(expression('MIT OR Apache-2.0'), expression('MIT'))).toEqual({
      from: { text: 'MIT OR Apache-2.0', file: false, url: undefined },
      to: { text: 'MIT', file: false, url: 'https://licenses.nuget.org/MIT' },
      unnamed: false,
    });
  });
});

/**
 * The table in #89, which is the specification for this function. Atoms are
 * compared and never interpreted, so the last cases below read as changes even
 * though a lawyer would call them relaxations — reporting a benign change costs
 * the user one look, staying silent about a real one costs them more.
 */
describe('takesNothingAway', () => {
  it('holds when an alternative is added', () => {
    expect(takesNothingAway('MIT', 'MIT OR Apache-2.0')).toBe(true);
  });

  it('holds when the same alternatives are written in another order', () => {
    // The false positive flattened string equality has.
    expect(takesNothingAway('MIT OR Apache-2.0', 'Apache-2.0 OR MIT')).toBe(true);
  });

  it('fails when an alternative is withdrawn', () => {
    // A consumer relying on Apache-2.0, for its patent grant, no longer has it.
    expect(takesNothingAway('MIT OR Apache-2.0', 'MIT')).toBe(false);
  });

  it('fails when a second obligation is added alongside', () => {
    expect(takesNothingAway('MIT', 'MIT AND Apache-2.0')).toBe(false);
  });

  it('holds when a conjunction loses one of its terms', () => {
    // Complying with both still complies with the one that remains.
    expect(takesNothingAway('MIT AND Apache-2.0', 'MIT')).toBe(true);
  });

  it('reads parentheses and distributes AND over OR', () => {
    // Adding a second way to satisfy the right-hand term leaves the way that
    // worked before intact.
    expect(takesNothingAway('MIT AND Apache-2.0', 'MIT AND (Apache-2.0 OR BSD-3-Clause)')).toBe(true);
    // Taking one away does not: a consumer complying through BSD-3-Clause has
    // nothing left to comply through.
    expect(takesNothingAway('MIT AND (Apache-2.0 OR BSD-3-Clause)', 'MIT AND Apache-2.0')).toBe(false);
    expect(takesNothingAway('MIT AND Apache-2.0', '(MIT AND Apache-2.0) OR BSD-3-Clause')).toBe(true);
  });

  it('ignores casing and spacing, which carry no meaning', () => {
    expect(takesNothingAway('mit   or  APACHE-2.0', 'Apache-2.0 OR MIT')).toBe(true);
  });

  it('treats a WITH exception as part of the atom rather than understanding it', () => {
    // An exception usually relaxes the terms, but that is a reading of the
    // licence text, not a fact about the expression.
    expect(takesNothingAway('GPL-3.0-only', 'GPL-3.0-only WITH Classpath-exception-2.0')).toBe(false);
    expect(takesNothingAway(
      'GPL-3.0-only WITH Classpath-exception-2.0',
      'GPL-3.0-only WITH Classpath-exception-2.0 OR MIT',
    )).toBe(true);
  });

  it('treats a trailing + as a different licence, for the same reason', () => {
    expect(takesNothingAway('Apache-2.0', 'Apache-2.0+')).toBe(false);
  });

  it('reports a change for an expression it cannot read', () => {
    expect(takesNothingAway('MIT AND', 'MIT')).toBe(false);
    expect(takesNothingAway('MIT', '(MIT OR Apache-2.0')).toBe(false);
    expect(takesNothingAway('', 'MIT')).toBe(false);
  });

  it('refuses to analyse an expression past the cap instead of paying for it', () => {
    const many = Array.from({ length: 20 }, (_, n) => `L-${n}`).join(' OR ');
    expect(takesNothingAway(many, many)).toBe(false);
    // Which never makes the identical case noisy: `licenseChange` compares the
    // text first, and only asks this when the two actually differ.
    expect(licenseChange(expression(many), expression(many))).toBeUndefined();
  });
});
