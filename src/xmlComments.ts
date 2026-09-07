/**
 * Generic helper shared by every regex-based XML editor in this extension
 * (nuget.config, .csproj) — see #85. A lazy `[\s\S]*?` body capture used to
 * find a paired open/close tag (or a self-closing one, which is a complete
 * match on its own) has no idea it's inside a comment: bare tag-like text in
 * a comment's own prose can be mistaken for a real tag, either swallowing
 * through to a real closing tag far away, or being read/rewritten as if it
 * were a real element itself.
 */

/** Blanks every `<!-- ... -->` XML comment to same-length whitespace, for matching only. */
export function maskXmlComments(text: string): string {
  return text.replace(/<!--[\s\S]*?-->/g, (m) => ' '.repeat(m.length));
}
