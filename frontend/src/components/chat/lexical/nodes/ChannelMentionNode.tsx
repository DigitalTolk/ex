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

// `~[channelID|slug]` in markdown, channel pill in the editor and the
// rendered message. Mirrors MentionNode but for channels.

export type SerializedChannelMentionNode = Spread<
  { channelId: string; slug: string; type: 'channelMention'; version: 1 },
  SerializedLexicalNode
>;

export class ChannelMentionNode extends DecoratorNode<JSX.Element> {
  __channelId: string;
  __slug: string;

  static getType(): string {
    return 'channelMention';
  }

  static clone(node: ChannelMentionNode): ChannelMentionNode {
    return new ChannelMentionNode(node.__channelId, node.__slug, node.__key);
  }

  constructor(channelId: string, slug: string, key?: NodeKey) {
    super(key);
    this.__channelId = channelId;
    this.__slug = slug;
  }

  getChannelId(): string {
    return this.__channelId;
  }

  getSlug(): string {
    return this.__slug;
  }

  getTextContent(): string {
    return `~${this.__slug}`;
  }

  static importJSON(json: SerializedChannelMentionNode): ChannelMentionNode {
    return new ChannelMentionNode(json.channelId, json.slug);
  }

  exportJSON(): SerializedChannelMentionNode {
    return {
      type: 'channelMention',
      version: 1,
      channelId: this.__channelId,
      slug: this.__slug,
    };
  }

  static importDOM(): DOMConversionMap | null {
    return {
      span: (el: HTMLElement) => {
        if (!el.classList.contains('mention')) return null;
        const channelId = el.getAttribute('data-channel-id');
        if (!channelId) return null;
        return {
          conversion: (node: HTMLElement): DOMConversionOutput => ({
            node: new ChannelMentionNode(
              node.getAttribute('data-channel-id') ?? '',
              node.getAttribute('data-channel-slug') ?? (node.textContent ?? '').replace(/^~/, ''),
            ),
          }),
          priority: 2,
        };
      },
    };
  }

  exportDOM(): DOMExportOutput {
    const span = document.createElement('span');
    span.className = 'mention channel-mention';
    span.setAttribute('data-channel-id', this.__channelId);
    span.setAttribute('data-channel-slug', this.__slug);
    span.setAttribute('contenteditable', 'false');
    span.textContent = `~${this.__slug}`;
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
    span.className = 'mention channel-mention inline-block rounded px-1 text-sm font-medium leading-tight bg-primary/10 text-primary';
    span.setAttribute('data-channel-id', this.__channelId);
    span.setAttribute('data-channel-slug', this.__slug);
    return span;
  }

  updateDOM(): boolean {
    return false;
  }

  decorate(): JSX.Element {
    return <span data-channel-slug={this.__slug}>~{this.__slug}</span>;
  }
}

export function $createChannelMentionNode(channelId: string, slug: string): ChannelMentionNode {
  return new ChannelMentionNode(channelId, slug);
}

export function $isChannelMentionNode(node: LexicalNode | null | undefined): node is ChannelMentionNode {
  return node instanceof ChannelMentionNode;
}
