import {
  DecoratorNode,
  type DOMConversionMap,
  type DOMConversionOutput,
  type DOMExportOutput,
  type EditorConfig,
  type LexicalNode,
  type NodeKey,
  type SerializedLexicalNode,
  type Spread,
} from 'lexical';
import type { JSX } from 'react';

// Wire-format mention pill: `@[userID|displayName]` in markdown,
// `<span class="mention" data-user-id="…" data-mention-name="…">@Name</span>`
// in HTML — same shape rendered messages use, so anything that already
// renders mentions (search hits, message list) works without changes.

export type SerializedMentionNode = Spread<
  { userId: string; displayName: string; type: 'mention'; version: 1 },
  SerializedLexicalNode
>;

export class MentionNode extends DecoratorNode<JSX.Element> {
  __userId: string;
  __displayName: string;

  static getType(): string {
    return 'mention';
  }

  static clone(node: MentionNode): MentionNode {
    return new MentionNode(node.__userId, node.__displayName, node.__key);
  }

  constructor(userId: string, displayName: string, key?: NodeKey) {
    super(key);
    this.__userId = userId;
    this.__displayName = displayName;
  }

  getUserId(): string {
    return this.__userId;
  }

  getDisplayName(): string {
    return this.__displayName;
  }

  getTextContent(): string {
    return `@${this.__displayName}`;
  }

  static importJSON(json: SerializedMentionNode): MentionNode {
    return new MentionNode(json.userId, json.displayName);
  }

  exportJSON(): SerializedMentionNode {
    return {
      type: 'mention',
      version: 1,
      userId: this.__userId,
      displayName: this.__displayName,
    };
  }

  static importDOM(): DOMConversionMap | null {
    return {
      span: (el: HTMLElement) => {
        if (!el.classList.contains('mention')) return null;
        const userId = el.getAttribute('data-user-id');
        if (!userId) return null;
        return {
          conversion: (node: HTMLElement): DOMConversionOutput => ({
            node: new MentionNode(
              node.getAttribute('data-user-id') ?? '',
              node.getAttribute('data-mention-name') ?? (node.textContent ?? '').replace(/^@/, ''),
            ),
          }),
          priority: 1,
        };
      },
    };
  }

  exportDOM(): DOMExportOutput {
    const span = document.createElement('span');
    span.className = 'mention';
    span.setAttribute('data-user-id', this.__userId);
    span.setAttribute('data-mention-name', this.__displayName);
    span.setAttribute('contenteditable', 'false');
    span.textContent = `@${this.__displayName}`;
    return { element: span };
  }

  isInline(): boolean {
    return true;
  }

  isIsolated(): boolean {
    return true;
  }

  isKeyboardSelectable(): boolean {
    return true;
  }

  createDOM(_config: EditorConfig): HTMLElement {
    const span = document.createElement('span');
    span.className = 'mention inline-block rounded px-1 text-sm font-medium leading-tight bg-primary/10 text-primary';
    span.setAttribute('data-user-id', this.__userId);
    span.setAttribute('data-mention-name', this.__displayName);
    return span;
  }

  updateDOM(): boolean {
    return false;
  }

  decorate(): JSX.Element {
    return <span data-mention-name={this.__displayName}>@{this.__displayName}</span>;
  }
}

export function $createMentionNode(userId: string, displayName: string): MentionNode {
  return new MentionNode(userId, displayName);
}

export function $isMentionNode(node: LexicalNode | null | undefined): node is MentionNode {
  return node instanceof MentionNode;
}
