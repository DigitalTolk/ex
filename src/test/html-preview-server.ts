import { readFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin } from 'vite';

// Browser-suite stand-in for the Go server's HTML-attachment preview route
// and the app page's CSP, so the browser tests run what the server sends in
// real engines. Every header and every byte it adds comes from the Go golden
// src/test/wire-fixtures/html_preview_contract.json, which
// internal/handler/html_preview_test.go keeps in step with the server
// (UPDATE_GOLDEN=1 rewrites it).
//
//  GET /api/v1/html-preview/f.<base64url file>/<name>
//      The file as the server's preview document. Any other token: the
//      server's "no file to show" document (404). Like the server it refuses
//      a load that says it is not for a frame — stricter, it also refuses one
//      that says nothing, so the suite proves each engine sends
//      `Sec-Fetch-Dest: iframe` for the preview frame.
//  GET /__csp-probe
//      The golden's probe page under the app page's CSP (its Host swapped for
//      this server's, framing by this origin allowed), plus what the policy
//      must stop: an inline script that is not hashed and a frame of a path
//      other than the preview route.

interface Contract {
  preview: { headers: Record<string, string>; head: string; failed: string };
  page: { host: string; html: string; csp: string };
}

const PREVIEW = '/api/v1/html-preview/';

// The probe's additions, each reporting through the page's own (hashed) script.
const PROBE_TAIL =
  '<script>parent.postMessage({csp:"unhashed"},"*")</script>' +
  `<iframe name="probe" src="${PREVIEW}f.${Buffer.from('<p>framed</p>').toString('base64url')}/framed.html"></iframe>` +
  '<iframe src="/favicon.svg"></iframe>';

export function htmlPreviewTestServer(contractPath: string): Plugin {
  // Read per request: a regenerated golden applies without a restart.
  const contract = (): Contract => JSON.parse(readFileSync(contractPath, 'utf8')) as Contract;

  function preview(req: IncomingMessage, res: ServerResponse, token: string) {
    if (req.headers['sec-fetch-dest'] !== 'iframe') {
      res.statusCode = 400;
      res.end();
      return;
    }
    const { headers, head, failed } = contract().preview;
    for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
    if (token.startsWith('f.')) {
      res.statusCode = 200;
      res.end(head + Buffer.from(token.slice(2), 'base64url').toString('utf8'));
      return;
    }
    res.statusCode = 404;
    res.end(failed);
  }

  function probe(req: IncomingMessage, res: ServerResponse) {
    const { host, html, csp } = contract().page;
    // The one change besides the host: the test has to frame the page, which
    // the real one forbids.
    const policy = csp.replaceAll(host, req.headers.host ?? '').replace("frame-ancestors 'none'", "frame-ancestors 'self'");
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Content-Security-Policy', policy);
    res.end(html.replace('</body>', `${PROBE_TAIL}</body>`));
  }

  return {
    name: 'html-preview-test-server',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const path = (req.url ?? '').split('?')[0];
        if (path.startsWith(PREVIEW)) return preview(req, res, path.slice(PREVIEW.length).split('/')[0]);
        if (path === '/__csp-probe') return probe(req, res);
        next();
      });
    },
  };
}
