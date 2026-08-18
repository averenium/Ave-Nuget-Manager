import * as fs from 'fs/promises';
import * as path from 'path';
import type { ProjectInfo } from './types';

// Matches lines like:
//   Project("{FAE04EC0-...}") = "MyApp", "src\MyApp\MyApp.csproj", "{...}"
const SLN_PROJECT_REGEX =
  /Project\("[^"]*"\)\s*=\s*"[^"]*",\s*"([^"]+\.(?:csproj|fsproj))"/gi;

export class SolutionParser {
  /**
   * Parse a `.sln` or `.slnx` file and return the list of project files it
   * references.
   *
   * @param solutionPath  Absolute path to the solution file.
   */
  async getProjects(solutionPath: string): Promise<ProjectInfo[]> {
    const ext = path.extname(solutionPath).toLowerCase();
    const content = await fs.readFile(solutionPath, 'utf-8');
    const solutionDir = path.dirname(solutionPath);

    if (ext === '.slnx') {
      return this._parseSlnx(content, solutionDir);
    }
    // Default: .sln
    return this._parseSln(content, solutionDir);
  }

  // ─── .sln (regex) ──────────────────────────────────────────────────────────

  private _parseSln(content: string, solutionDir: string): ProjectInfo[] {
    const projects: ProjectInfo[] = [];

    // Normalise Windows CRLF so regex line anchors work uniformly
    const normalised = content.replace(/\r\n/g, '\n');

    let match: RegExpExecArray | null;
    SLN_PROJECT_REGEX.lastIndex = 0; // reset stateful regex

    while ((match = SLN_PROJECT_REGEX.exec(normalised)) !== null) {
      const relativePath = match[1].replace(/\\/g, '/');
      const absolutePath = path.resolve(solutionDir, relativePath);
      const name = path.basename(relativePath, path.extname(relativePath));
      projects.push({ name, relativePath, absolutePath });
    }

    return projects;
  }

  // ─── .slnx (XML) ───────────────────────────────────────────────────────────

  private _parseSlnx(content: string, solutionDir: string): ProjectInfo[] {
    const projects: ProjectInfo[] = [];

    // Simple regex-based XML attribute extraction — avoids a DOM dependency
    // in the extension host (which runs in Node, not a browser).
    // Matches: <Project Path="some/path.csproj" ...>
    const projectTagRegex = /<Project\b[^>]*\bPath\s*=\s*"([^"]+\.(csproj|fsproj))"[^>]*>/gi;

    let match: RegExpExecArray | null;
    while ((match = projectTagRegex.exec(content)) !== null) {
      const relativePath = match[1].replace(/\\/g, '/');
      const absolutePath = path.resolve(solutionDir, relativePath);
      const name = path.basename(relativePath, path.extname(relativePath));
      projects.push({ name, relativePath, absolutePath });
    }

    return projects;
  }
}

/**
 * Returns true if a list of direct-child filenames contains at least one
 * solution or project file. Used by CommandRegistrar to decide whether to
 * show the context-menu item for a directory.
 *
 * Property 1: result is true IFF ∃ filename ending with .sln/.slnx/.csproj/.fsproj.
 */
export function shouldShowContextMenu(directChildFileNames: string[]): boolean {
  return directChildFileNames.some((f) =>
    /\.(sln|slnx|csproj|fsproj)$/i.test(f),
  );
}
