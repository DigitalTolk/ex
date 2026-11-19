import { afterEach, describe, expect, it } from 'vitest';
import { serverIconURL, serverName } from './server-identity';

const realLocation = window.location;

function addIconLink(href?: string): HTMLLinkElement {
  const link = document.createElement('link');
  link.rel = 'icon';
  if (href !== undefined) link.href = href;
  document.head.appendChild(link);
  return link;
}

function visit(hostname: string) {
  Object.defineProperty(window, 'location', {
    configurable: true,
    writable: true,
    value: { ...realLocation, hostname },
  });
}

afterEach(() => {
  document.head.querySelectorAll('link[rel~="icon"]').forEach((link) => link.remove());
  Object.defineProperty(window, 'location', { configurable: true, writable: true, value: realLocation });
});

describe('serverIconURL', () => {
  it("is the favicon the server's page declares", () => {
    addIconLink('https://chat.example.com/brand/icon.png');
    expect(serverIconURL()).toBe('https://chat.example.com/brand/icon.png');
  });

  it('finds the icon among several rel values', () => {
    const link = addIconLink('https://chat.example.com/shortcut.ico');
    link.rel = 'shortcut icon';
    expect(serverIconURL()).toBe('https://chat.example.com/shortcut.ico');
  });

  it('falls back to the bundled favicon when the page declares none', () => {
    expect(document.querySelector('link[rel~="icon"]')).toBeNull();
    expect(serverIconURL()).toBe('/favicon.svg');
  });

  it('falls back to the bundled favicon when the declared one has no address', () => {
    addIconLink();
    expect(serverIconURL()).toBe('/favicon.svg');
  });
});

describe('serverName', () => {
  it('is the address people type to reach the server', () => {
    visit('chat.example.com');
    expect(serverName()).toBe('chat.example.com');
  });

  it('drops a leading www, and only a leading one', () => {
    visit('www.example.com');
    expect(serverName()).toBe('example.com');
    visit('chat.www.example.com');
    expect(serverName()).toBe('chat.www.example.com');
  });
});
