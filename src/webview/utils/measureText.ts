function canvasContext(): CanvasRenderingContext2D | null {
  const canvas = document.createElement('canvas');
  return canvas.getContext('2d');
}

export function measureTextWidth(text: string, font: string): number {
  const ctx = canvasContext();
  if (!ctx) return 0;
  ctx.font = font;
  return Math.ceil(ctx.measureText(text).width);
}

/** Measure the pixel width of the longest string with the given CSS font. */
export function measureMaxTextWidth(texts: string[], font: string): number {
  if (texts.length === 0) return 0;
  const ctx = canvasContext();
  if (!ctx) return 0;
  ctx.font = font;
  let max = 0;
  for (const text of texts) {
    const w = ctx.measureText(text).width;
    if (w > max) max = w;
  }
  return Math.ceil(max);
}
