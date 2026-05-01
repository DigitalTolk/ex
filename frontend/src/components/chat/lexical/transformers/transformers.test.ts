import { describe, it, expect } from 'vitest';
import { createHeadlessEditor } from '@lexical/headless';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
} from 'lexical';
import {
  $isListNode,
  ListItemNode,
  ListNode,
} from '@lexical/list';
import { QuoteNode } from '@lexical/rich-text';
import type { ElementTransformer } from '@lexical/markdown';
import { EX_TRANSFORMERS } from './index';
import { ExListNode } from '../nodes/ExListNode';

function findListTransformer(predicate: (t: ElementTransformer) => boolean): ElementTransformer {
  const t = EX_TRANSFORMERS.find(
    (x): x is ElementTransformer => x.type === 'element' && predicate(x as ElementTransformer),
  );
  if (!t) throw new Error('transformer not found');
  return t;
}

describe('EX_TRANSFORMERS list-restart override', () => {
  it('typing `- ` next to an existing same-type list creates a NEW list (not merged)', () => {
    // Stock Lexical merges into the previous adjacent list, so the
    // user perceives "- did nothing". Our override creates a fresh
    // ListNode for live typing while still merging on import.
    const editor = createHeadlessEditor({
      namespace: 'test',
      nodes: [
        ExListNode,
        { replace: ListNode, with: (n: ListNode) => new ExListNode(n.getListType(), n.getStart()), withKlass: ExListNode },
        ListItemNode,
        QuoteNode,
      ],
      onError: (e) => { throw e; },
    });
    const ulTransformer = findListTransformer((t) =>
      Boolean(t.dependencies?.some((d) => d.getType() === 'list')) &&
      t.regExp.source.includes('-'),
    );

    editor.update(() => {
      const root = $getRoot();
      // Pre-existing bullet list "- a"
      const existingList = (() => {
        // Use $createListNode through the import path is awkward in
        // headless; build via $createTextNode + transformer.replace
        // with isImport=true to mirror the standard path.
        const para = $createParagraphNode();
        const t = $createTextNode('a');
        para.append(t);
        root.append(para);
        const match = '- '.match(/^(\s*)[-*+]\s/) as RegExpMatchArray;
        ulTransformer.replace(para, [t], match, true);
        return root.getFirstChild();
      })();
      expect($isListNode(existingList)).toBe(true);

      // The user pressed Enter on empty list item, exiting the list —
      // simulate by appending a fresh empty paragraph after.
      const afterPara = $createParagraphNode();
      const afterText = $createTextNode('b');
      afterPara.append(afterText);
      root.append(afterPara);

      // The user types `- b<space>`; MarkdownShortcutPlugin would call
      // transformer.replace with isImport=false on the `b` paragraph.
      const match2 = '- '.match(/^(\s*)[-*+]\s/) as RegExpMatchArray;
      ulTransformer.replace(afterPara, [afterText], match2, false);

      // Two distinct ListNodes at the root — proof we did NOT merge.
      const lists = root.getChildren().filter($isListNode);
      expect(lists).toHaveLength(2);
    }, { discrete: true });
  });

  it('importing `- a\\n- b` (isImport=true) still merges into a single list', () => {
    // Round-trip preservation: stored markdown messages must continue
    // to render as a single list per markdown spec when imported.
    const editor = createHeadlessEditor({
      namespace: 'test',
      nodes: [
        ExListNode,
        { replace: ListNode, with: (n: ListNode) => new ExListNode(n.getListType(), n.getStart()), withKlass: ExListNode },
        ListItemNode,
        QuoteNode,
      ],
      onError: (e) => { throw e; },
    });
    const ulTransformer = findListTransformer((t) =>
      Boolean(t.dependencies?.some((d) => d.getType() === 'list')) &&
      t.regExp.source.includes('-'),
    );
    editor.update(() => {
      const root = $getRoot();
      const p1 = $createParagraphNode();
      const t1 = $createTextNode('a');
      p1.append(t1);
      root.append(p1);
      const m1 = '- '.match(/^(\s*)[-*+]\s/) as RegExpMatchArray;
      ulTransformer.replace(p1, [t1], m1, true);

      const p2 = $createParagraphNode();
      const t2 = $createTextNode('b');
      p2.append(t2);
      root.append(p2);
      const m2 = '- '.match(/^(\s*)[-*+]\s/) as RegExpMatchArray;
      ulTransformer.replace(p2, [t2], m2, true);

      const lists = root.getChildren().filter($isListNode);
      expect(lists).toHaveLength(1);
    }, { discrete: true });
  });
});
