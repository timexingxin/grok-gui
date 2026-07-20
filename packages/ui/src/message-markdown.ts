const rawLatexCommand = /\\(?:text|frac|sqrt|sum|prod|left|right|times|cdot|leq|geq|neq|land|lor|in|notin|forall|exists)\b/;

/**
 * Grok occasionally emits TeX commands without `$` delimiters. Markdown
 * treats those commands as plain text, so promote only math-looking lines
 * while preserving ordinary Markdown and code fences.
 */
export function normalizeGrokMarkdown(source: string): string {
  const delimited = source
    .replace(/\\\[([\s\S]*?)\\\]/g, (_, math) => `$$${math}$$`)
    .replace(/\\\(([\s\S]*?)\\\)/g, (_, math) => `$${math}$`);

  let inFence = false;
  return delimited.split("\n").map((line) => {
    if (line.trimStart().startsWith("```")) {
      inFence = !inFence;
      return line;
    }
    if (inFence || line.includes("$") || !rawLatexCommand.test(line)) return line;
    return `$$${line.trim()}$$`;
  }).join("\n");
}
