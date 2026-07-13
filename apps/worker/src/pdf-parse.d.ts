// Minimal type shim for pdf-parse (ships no types). We import the internal
// module path `pdf-parse/lib/pdf-parse.js` directly to bypass the package's
// index.js debug harness, which tries to read a bundled sample PDF at import
// time and crashes under ESM.
declare module 'pdf-parse/lib/pdf-parse.js' {
  interface PdfParseResult {
    numpages: number;
    numrender: number;
    info: unknown;
    metadata: unknown;
    text: string;
    version: string;
  }
  function pdfParse(
    data: Buffer | Uint8Array,
    options?: Record<string, unknown>
  ): Promise<PdfParseResult>;
  export default pdfParse;
}
