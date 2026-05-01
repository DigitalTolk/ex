import { ElementNode, type DOMConversionMap } from 'lexical';
import { $isListItemNode, ListNode } from '@lexical/list';

// ExListNode replaces Lexical's stock ListNode purely to opt out of
// the upstream `mergeNextSiblingListIfSameType` transform.
//
// Stock ListNode's `$config.$transform` merges every adjacent same-
// type list pair on each editor update — invisible glue intended for
// HTML paste normalization. In a chat composer that's wrong: a user
// who closes one list and starts another (`- a` ↵↵ `- b`) expects
// two distinct lists, but the merge silently fuses them, the markdown
// shortcut looks like it didn't fire, and Enter on the next paragraph
// submits the message instead of opening a new list item.
//
// Subclassing + node replacement is the Lexical-native way to opt out
// of upstream node behavior without monkey-patching. We keep the
// item-value updater (drives `<li value="N">` numbering when items
// are added or removed) and drop only the merge.
export class ExListNode extends ListNode {
  $config() {
    // Two non-obvious bits here:
    //
    // 1. Type `list-ex`, not `list`. Lexical's class-replacement
    //    registry enforces a 1:1 type ↔ class mapping
    //    (errorOnTypeKlassMismatch). Subclasses participating in node
    //    replacement must declare their own type. `instanceof ListNode`
    //    still works through JS inheritance, so `$isListNode` and the
    //    markdown transformers continue to recognize us as a list.
    //
    // 2. `extends: ElementNode`, not `ListNode`. Lexical's
    //    getTransformSetFromKlass walks the `extends` chain and
    //    collects every ancestor's $transform — declaring `extends:
    //    ListNode` would re-attach the merge transform we're trying
    //    to avoid. Skipping straight to ElementNode is the only way
    //    to opt out of the parent's transform without touching
    //    Lexical internals.
    const parent = super.$config() as Record<string, { importDOM?: DOMConversionMap<HTMLElement> }>;
    return this.config('list-ex', {
      $transform: $updateChildrenListItemValue,
      extends: ElementNode,
      importDOM: parent.list?.importDOM,
    });
  }
}

// Mirrors @lexical/list's stock helper of the same name (which isn't
// exported): renumber `<li value=N>` after each list mutation so
// ordered-list rendering stays correct when items are inserted or
// removed.
function $updateChildrenListItemValue(list: ListNode): void {
  let value = list.getStart();
  for (const child of list.getChildren()) {
    if ($isListItemNode(child)) {
      if (child.getValue() !== value) child.setValue(value);
      value++;
    }
  }
}
