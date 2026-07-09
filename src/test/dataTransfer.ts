// jsdom doesn't synthesize a DataTransfer for drag / paste events, so
// tests have to fabricate one. Browsers expose a fixed shape — files,
// types, items, getData — and our editor's paste / drop plugins read
// different subsets. This factory takes the union so each test fills
// in just what it needs.

interface FakeDataTransferOptions {
  files?: File[];
  types?: string[];
  items?: Array<{ kind: 'string' | 'file'; type: string; getAsFile: () => File | null }>;
  text?: string;
}

export function makeDataTransfer(opts: FakeDataTransferOptions = {}): DataTransfer {
  const { files = [], types = [], items = [], text = '' } = opts;
  return {
    files: files as unknown as FileList,
    types,
    items: items as unknown as DataTransferItemList,
    getData: (kind: string) => (kind === 'text/plain' ? text : ''),
  } as unknown as DataTransfer;
}
