// buildPdf assembles a minimal, valid PDF in memory: `pages` US-Letter pages,
// each painting a filled square, plus (optionally) an internal link on page 1
// that jumps to `linkToPage`. Browser tests feed it to the real pdf.js.
export function buildPdf({ pages, linkToPage }: { pages: number; linkToPage?: number }): Uint8Array {
  const pageObj = (i: number) => 3 + i * 2;
  const contentObj = (i: number) => 4 + i * 2;
  const linkObj = 3 + pages * 2;
  const objects: string[] = [];
  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[2] = `<< /Type /Pages /Kids [${Array.from({ length: pages }, (_, i) => `${pageObj(i)} 0 R`).join(' ')}] /Count ${pages} >>`;
  for (let i = 0; i < pages; i++) {
    const annots = i === 0 && linkToPage ? ` /Annots [${linkObj} 0 R]` : '';
    objects[pageObj(i)] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${contentObj(i)} 0 R${annots} >>`;
    const stream = '0.2 0.4 0.8 rg 72 72 300 300 re f';
    objects[contentObj(i)] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  }
  if (linkToPage) {
    objects[linkObj] = `<< /Type /Annot /Subtype /Link /Rect [72 420 540 720] /Border [0 0 0] /Dest [${pageObj(linkToPage - 1)} 0 R /Fit] >>`;
  }
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (let n = 1; n < objects.length; n++) {
    offsets[n] = out.length;
    out += `${n} 0 obj\n${objects[n]}\nendobj\n`;
  }
  const xref = out.length;
  out += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let n = 1; n < objects.length; n++) out += `${String(offsets[n]).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}

export function pdfObjectURL(bytes: Uint8Array): string {
  return URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'application/pdf' }));
}
