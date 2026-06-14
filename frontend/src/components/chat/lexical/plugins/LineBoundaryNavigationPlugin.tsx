import { useEffect, useRef } from 'react';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import {
  $createTextNode,
  $getRoot,
  $isElementNode,
  $isTextNode,
} from 'lexical';

export function LineBoundaryNavigationPlugin() {
  const [editor] = useLexicalComposerContext();
  const forceStartInsertionRef = useRef(false);

  useEffect(() => {
    const rootElement = editor.getRootElement();
    if (!rootElement) return undefined;

    const onKeyDown = (event: KeyboardEvent) => {
      if (forceStartInsertionRef.current && isPlainTextKey(event)) {
        event.preventDefault();
        /* istanbul ignore next -- 'Spacebar' (legacy IE/Edge key name) is 8 chars; this line only runs under isPlainTextKey which requires key.length === 1, so the 'Spacebar' === branch is unreachable here. */
        const text = event.key === 'Spacebar' ? ' ' : event.key;
        editor.update(() => {
          insertAtEditableStart(text);
        }, { discrete: true });
        forceStartInsertionRef.current = false;
        return;
      }
      if (forceStartInsertionRef.current && !isModifierKey(event)) {
        forceStartInsertionRef.current = false;
      }

      if (event.key !== 'ArrowLeft' || !event.metaKey || event.altKey || event.shiftKey) return;
      event.preventDefault();
      forceStartInsertionRef.current = true;
      editor.update(() => {
        selectEditableStart();
      }, { discrete: true });
    };

    const resetForcedStart = () => {
      forceStartInsertionRef.current = false;
    };

    rootElement.addEventListener('keydown', onKeyDown, true);
    rootElement.addEventListener('mousedown', resetForcedStart, true);
    return () => {
      rootElement.removeEventListener('keydown', onKeyDown, true);
      rootElement.removeEventListener('mousedown', resetForcedStart, true);
    };
  }, [editor]);

  return null;
}

function isPlainTextKey(event: KeyboardEvent): boolean {
  return !event.metaKey && !event.ctrlKey && !event.altKey && event.key.length === 1;
}

function isModifierKey(event: KeyboardEvent): boolean {
  return event.key === 'Shift' || event.key === 'Meta' || event.key === 'Alt' || event.key === 'Control';
}

function selectEditableStart() {
  const root = $getRoot();
  const firstBlock = root.getFirstChild();
  if (!$isElementNode(firstBlock)) {
    root.selectStart();
    return;
  }

  const firstChild = firstBlock.getFirstChild();
  if ($isTextNode(firstChild)) {
    firstChild.select(0, 0);
    return;
  }
  if (firstChild) {
    const prefix = $createTextNode('');
    firstChild.insertBefore(prefix);
    prefix.select(0, 0);
    return;
  }
  firstBlock.selectStart();
}

function insertAtEditableStart(text: string) {
  const root = $getRoot();
  const firstBlock = root.getFirstChild();
  if (!$isElementNode(firstBlock)) {
    root.selectStart().insertText(text);
    return;
  }

  const firstChild = firstBlock.getFirstChild();
  if ($isTextNode(firstChild)) {
    firstChild.spliceText(0, 0, text);
    firstChild.select(text.length, text.length);
    return;
  }
  const prefix = $createTextNode(text);
  if (firstChild) {
    firstChild.insertBefore(prefix);
  } else {
    firstBlock.append(prefix);
  }
  prefix.select(text.length, text.length);
}
