import * as fs from 'fs/promises';
import * as path from 'path';
import { SolutionParser, shouldShowContextMenu } from '../../solutionParser';

jest.mock('fs/promises');
const mockReadFile = fs.readFile as jest.MockedFunction<typeof fs.readFile>;

describe('SolutionParser', () => {
  let parser: SolutionParser;

  beforeEach(() => {
    parser = new SolutionParser();
    mockReadFile.mockReset();
  });

  // ── .sln parsing ───────────────────────────────────────────────────────────

  it('returns empty array for .sln with no projects', async () => {
    mockReadFile.mockResolvedValue('Microsoft Visual Studio Solution File\n' as any);
    const result = await parser.getProjects('/sol/Empty.sln');
    expect(result).toEqual([]);
  });

  it('parses a single .csproj from a .sln', async () => {
    const sln = `
Microsoft Visual Studio Solution File, Format Version 12.00
Project("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "MyApp", "src\\MyApp\\MyApp.csproj", "{guid}"
EndProject
`;
    mockReadFile.mockResolvedValue(sln as any);
    const result = await parser.getProjects('/sol/MyApp.sln');

    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('MyApp');
    expect(result[0].relativePath).toBe('src/MyApp/MyApp.csproj');
    expect(result[0].absolutePath).toBe(path.resolve('/sol', 'src/MyApp/MyApp.csproj'));
  });

  it('parses multiple projects (csproj + fsproj) from a .sln', async () => {
    const sln = `
Project("{guid}") = "Api", "src\\Api\\Api.csproj", "{g1}"
EndProject
Project("{guid}") = "Domain", "src\\Domain\\Domain.fsproj", "{g2}"
EndProject
Project("{guid}") = "Tests", "tests\\Tests\\Tests.csproj", "{g3}"
EndProject
`;
    mockReadFile.mockResolvedValue(sln as any);
    const result = await parser.getProjects('/sol/Big.sln');

    expect(result).toHaveLength(3);
    const names = result.map((p) => p.name);
    expect(names).toContain('Api');
    expect(names).toContain('Domain');
    expect(names).toContain('Tests');
  });

  it('handles Windows CRLF line endings', async () => {
    const sln =
      'Project("{guid}") = "App", "App\\App.csproj", "{g}"\r\nEndProject\r\n';
    mockReadFile.mockResolvedValue(sln as any);
    const result = await parser.getProjects('/sol/App.sln');
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('App');
  });

  it('resolves absolute paths correctly', async () => {
    const sln = `Project("{g}") = "Lib", "libs\\Lib\\Lib.csproj", "{g}"\nEndProject\n`;
    mockReadFile.mockResolvedValue(sln as any);
    const result = await parser.getProjects('/workspace/sol/My.sln');
    expect(result[0].absolutePath).toBe(path.resolve('/workspace/sol', 'libs/Lib/Lib.csproj'));
  });

  // ── .slnx parsing ─────────────────────────────────────────────────────────

  it('parses projects from a .slnx file', async () => {
    const slnx = `<?xml version="1.0" encoding="utf-8"?>
<Solution>
  <Project Path="src/Api/Api.csproj" />
  <Project Path="src/Domain/Domain.fsproj" />
</Solution>`;
    mockReadFile.mockResolvedValue(slnx as any);
    const result = await parser.getProjects('/sol/MySol.slnx');

    expect(result).toHaveLength(2);
    expect(result[0].name).toBe('Api');
    expect(result[1].name).toBe('Domain');
  });

  it('parses zero projects from an empty .slnx', async () => {
    const slnx = `<?xml version="1.0"?><Solution></Solution>`;
    mockReadFile.mockResolvedValue(slnx as any);
    const result = await parser.getProjects('/sol/Empty.slnx');
    expect(result).toEqual([]);
  });
});

// ── shouldShowContextMenu ──────────────────────────────────────────────────────

describe('shouldShowContextMenu', () => {
  it('returns true when a .sln file is present', () => {
    expect(shouldShowContextMenu(['readme.md', 'My.sln', 'src'])).toBe(true);
  });

  it('returns true when a .csproj file is present', () => {
    expect(shouldShowContextMenu(['App.csproj'])).toBe(true);
  });

  it('returns true when a .fsproj file is present', () => {
    expect(shouldShowContextMenu(['Lib.fsproj'])).toBe(true);
  });

  it('returns true when a .slnx file is present', () => {
    expect(shouldShowContextMenu(['MySol.slnx'])).toBe(true);
  });

  it('returns false when no solution or project file is present', () => {
    expect(shouldShowContextMenu(['readme.md', 'package.json', 'src'])).toBe(false);
  });

  it('returns false for an empty directory', () => {
    expect(shouldShowContextMenu([])).toBe(false);
  });

  it('is case-insensitive', () => {
    expect(shouldShowContextMenu(['MY.SLN'])).toBe(true);
    expect(shouldShowContextMenu(['App.CSPROJ'])).toBe(true);
  });
});
