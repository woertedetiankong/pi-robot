// Isolated native parsers / OCR: an abort or timeout terminates this process.
import { readFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
const require = createRequire(import.meta.url);

async function openPdf(path) {
  const canvas = await import('@napi-rs/canvas');
  for (const name of ['DOMMatrix', 'ImageData', 'Path2D']) globalThis[name] ??= canvas[name];
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = pdfjs.getDocument({
    data: new Uint8Array(await readFile(path)),
    standardFontDataUrl: join(dirname(require.resolve('pdfjs-dist/package.json')), 'standard_fonts') + '/',
    useSystemFonts: true, isEvalSupported: false,
  });
  try { return await task.promise; }
  catch (error) { await task.destroy(); throw error; }
}

async function run(job) {
  if (job.op === 'parse') {
    const { LiteParse } = await import('@llamaindex/liteparse');
    const pages = job.pages;
    const parser = new LiteParse({ ocrEnabled: false, quiet: true, ...(pages ? {targetPages:pages.join(',')} : {}), maxPages: pages ? Math.max(...pages) : 30, preserveVerySmallText: true, keepHeadersFooters:true });
    const result = await parser.parse(job.path);
    if (pages?.some(p => p > result.totalPages)) throw new Error(`Requested pages outside 1-${result.totalPages}`);
    if (result.pageErrors?.length) throw new Error('Parser reported page failures: '+JSON.stringify(result.pageErrors));
    return { total:result.totalPages, pages: result.pages.filter(p => !pages || pages.includes(p.pageNum)).map(p => ({ page: p.pageNum, text: p.text, markdown:p.markdown })) };
  }
  if (job.op === 'render') {
    const pdf = await openPdf(job.path);
    try {
      if (job.page < 1 || job.page > pdf.numPages) throw new Error('Page out of range');
      const page = await pdf.getPage(job.page);
      const base = page.getViewport({ scale: 1 });
      const scale = Math.min(3, 2400 / Math.max(base.width, base.height));
      const viewport = page.getViewport({ scale });
      const { createCanvas } = await import('@napi-rs/canvas');
      const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
      await page.render({ canvas, canvasContext: canvas.getContext('2d'), viewport }).promise;
      const { writeFile } = await import('node:fs/promises');
      await writeFile(job.output, canvas.toBuffer('image/png'));
      return { width: canvas.width, height: canvas.height };
    } finally { await pdf.destroy(); }
  }
  if (job.op === 'ocr') {
    const { createWorker, PSM } = await import('tesseract.js');
    await mkdir(job.cachePath, { recursive: true });
    const worker = await createWorker(job.language, 1, {
      cachePath: job.cachePath,
      ...(process.env.PI_EMBEDDED_DOCS_TESSDATA ? { langPath: process.env.PI_EMBEDDED_DOCS_TESSDATA } : {}),
    });
    try {
      await worker.setParameters({ tessedit_pageseg_mode: PSM.AUTO });
      const result = await worker.recognize(job.path);
      return { text: result.data.text, confidence: result.data.confidence, engine: 'tesseract.js-7' };
    } finally { await worker.terminate(); }
  }
  throw new Error('Unknown worker operation');
}

process.once('message', async job => {
  try { process.send({ ok: true, result: await run(job) }, () => process.exit(0)); }
  catch (e) { process.send({ ok: false, error: e instanceof Error ? e.message : String(e) }, () => process.exit(1)); }
});
