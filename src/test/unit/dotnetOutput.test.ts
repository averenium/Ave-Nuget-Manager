import { extractJsonObject, summarizeDotnetFailure, summarizeListProblems, isCliOperationSuccess, cliOutputText } from '../../dotnetOutput';

const NU1605_ADD = `info : Adding PackageReference for package 'EFCore.NamingConventions' into project 'd:\\repo\\Data.csproj'.
info : Restoring packages for d:\\repo\\Data.csproj...
warn : NU1608: Detected package version outside of dependency constraint: Npgsql.EntityFrameworkCore.PostgreSQL 10.0.0-rc.2 requires Microsoft.EntityFrameworkCore (= 10.0.0-rc.2.25502.107) but version Microsoft.EntityFrameworkCore 10.0.0 was resolved.
error: NU1605: Warning As Error: Detected package downgrade: Microsoft.EntityFrameworkCore from 10.0.1 to 10.0.0. Reference the package directly from the project to select a different version.
error:  Data -> EFCore.NamingConventions 10.0.1 -> Microsoft.EntityFrameworkCore (>= 10.0.1 && < 11.0.0)
error:  Data -> Microsoft.EntityFrameworkCore (>= 10.0.0)
info : PackageReference for package 'EFCore.NamingConventions' version '10.0.1' updated in file 'd:\\repo\\Data.csproj'.
log  : Failed to restore d:\\repo\\Data.csproj (in 269 ms).
`;

const RESTORE_FAILED_LIST = `{
   "version": 1,
   "problems": [
      {
         "text": "Restore failed. Run \`dotnet restore\` for more details on the issue.",
         "level": "error"
      }
   ]
}`;

describe('dotnetOutput', () => {
  it('extracts JSON object from mixed CLI output', () => {
    const mixed = `warn : something\n${RESTORE_FAILED_LIST}\n`;
    const json = extractJsonObject(mixed);
    expect(json).toContain('"version": 1');
    expect(JSON.parse(json!).problems[0].level).toBe('error');
  });

  it('summarizes NU1605 restore errors from stdout (stderr often empty)', () => {
    const summary = summarizeDotnetFailure(NU1605_ADD, '');
    expect(summary).toContain('NU1605');
    expect(summary).toContain('Failed to restore');
    expect(summary).toContain('NU1608');
    expect(summary).not.toContain('Adding PackageReference');
    expect(summary).not.toContain('X.509');
  });

  it('treats a cancelled CLI result as failure', () => {
    expect(isCliOperationSuccess({
      exitCode: null,
      stdout: '',
      stderr: 'Cancelled',
      timedOut: false,
      cancelled: true,
    })).toBe(false);
  });

  it('treats exit 0 as failure when add stdout contains NU1605 / Failed to restore', () => {
    expect(isCliOperationSuccess({
      exitCode: 0,
      stdout: NU1605_ADD,
      stderr: '',
      timedOut: false,
    })).toBe(false);
  });

  it('does not use list JSON "Run dotnet restore" as the add error', () => {
    const summary = summarizeDotnetFailure(NU1605_ADD, '');
    expect(summary).not.toContain('Run `dotnet restore`');
  });

  it('reads problems[].text from a failed dotnet list JSON payload', () => {
    expect(summarizeListProblems(RESTORE_FAILED_LIST)).toBe(
      'Restore failed. Run `dotnet restore` for more details on the issue.',
    );
    expect(summarizeDotnetFailure(RESTORE_FAILED_LIST, '')).toContain('Restore failed');
  });

  it('joins stdout then stderr as a raw dump for the restore banner', () => {
    expect(cliOutputText({
      stdout: 'warning NU1608: constraint\nerror NU1605: downgrade\n',
      stderr: '',
    })).toBe('warning NU1608: constraint\nerror NU1605: downgrade');
  });
});
