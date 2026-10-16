import { useRef, useState } from 'react';
import { Check, FileCode2, Trash2, Upload } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useUpdateProject, type ProjectDetail } from '@/hooks/useProjects';
import { formatBytes, formatRelative } from '@/lib/format';
import { showToast } from '@/lib/toast';

// The design-system half of a project's Design notes tab: which UI library
// the product is built with, and its main stylesheet (globals.css or the
// like). The agent never sees the raw stylesheet — the server condenses it to
// imports, fonts and CSS variables, which this card shows as-is.

// Common stacks offered as suggestions; any text is accepted.
const LIBRARY_SUGGESTIONS = [
  'shadcn/ui (Radix), Tailwind CSS',
  'shadcn/ui (Base UI), Tailwind CSS',
  'Material UI (MUI)',
  'Ant Design',
  'Chakra UI',
  'Mantine',
  'Bootstrap',
  'Tailwind CSS',
  'daisyUI',
  'Headless UI, Tailwind CSS',
  'Vuetify',
  'PrimeVue',
  'Element Plus',
  'Nuxt UI',
];

const errorText = (e: unknown, fallback: string) => (e instanceof Error ? e.message : fallback);

export function UiLibraryCard({ detail }: { detail: ProjectDetail }) {
  const { project } = detail;
  const update = useUpdateProject(project.key);
  const saved = project.uiLibrary ?? '';
  const [value, setValue] = useState(saved);
  return (
    <section className="space-y-2 rounded-xl border bg-card p-3" aria-labelledby="ui-library-label">
      <div>
        <Label id="ui-library-label" htmlFor="ui-library">
          UI library
        </Label>
        <p className="text-xs text-muted-foreground">
          What the product is built with. The agent draws anything the screenshots don&apos;t show the way this library
          renders it.
        </p>
      </div>
      <div className="flex gap-2">
        <Input
          id="ui-library"
          list="ui-library-suggestions"
          value={value}
          maxLength={300}
          placeholder="shadcn/ui (Radix), Tailwind CSS, Tabler icons"
          onChange={(e) => setValue(e.target.value)}
        />
        <datalist id="ui-library-suggestions">
          {LIBRARY_SUGGESTIONS.map((s) => (
            <option key={s} value={s} />
          ))}
        </datalist>
        <Button
          disabled={value.trim() === saved.trim() || update.isPending}
          onClick={() =>
            update.mutate(
              { uiLibrary: value },
              {
                onSuccess: () => showToast('UI library saved', 'success'),
                onError: (e) => showToast(errorText(e, 'Could not save the UI library')),
              },
            )
          }
        >
          <Check aria-hidden="true" />
          Save library
        </Button>
      </div>
    </section>
  );
}

export function ThemeCard({ detail }: { detail: ProjectDetail }) {
  const { project, theme } = detail;
  const update = useUpdateProject(project.key);
  const fileInput = useRef<HTMLInputElement>(null);
  const [pasting, setPasting] = useState(false);
  const [pasted, setPasted] = useState('');

  const save = (css: string, filename: string, done?: () => void) =>
    update.mutate(
      { themeCSS: css, themeFilename: filename },
      {
        onSuccess: () => {
          showToast(css ? 'Theme saved' : 'Theme removed', 'success');
          done?.();
        },
        onError: (e) => showToast(errorText(e, 'Could not save the theme')),
      },
    );

  const upload = async (file: File) => save(await file.text(), file.name);

  return (
    <section className="space-y-2 rounded-xl border bg-card p-3" aria-labelledby="theme-css-label" data-testid="theme-card">
      <div className="flex items-start justify-between gap-2">
        <div>
          <h3 id="theme-css-label" className="text-sm font-medium">
            Theme CSS
          </h3>
          <p className="text-xs text-muted-foreground">
            Upload the product&apos;s main stylesheet (globals.css, theme.css). Only its CSS variables, fonts and imports
            reach the agent — exact colors and radius at a fraction of the file&apos;s size.
          </p>
        </div>
        <div className="flex shrink-0 gap-1">
          <Button size="sm" variant="outline" disabled={update.isPending} onClick={() => fileInput.current?.click()}>
            <Upload aria-hidden="true" />
            {theme ? 'Replace' : 'Upload CSS'}
          </Button>
          {!theme && !pasting && (
            <Button size="sm" variant="ghost" onClick={() => setPasting(true)}>
              Paste instead
            </Button>
          )}
          {theme && (
            <Button size="sm" variant="ghost" aria-label="Remove theme CSS" disabled={update.isPending} onClick={() => save('', '')}>
              <Trash2 aria-hidden="true" />
            </Button>
          )}
        </div>
        <input
          ref={fileInput}
          type="file"
          accept=".css,text/css"
          className="hidden"
          data-testid="theme-file-input"
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (f) void upload(f);
          }}
        />
      </div>

      {pasting && !theme && (
        <div className="space-y-2">
          <Label htmlFor="theme-paste" className="sr-only">
            Paste stylesheet
          </Label>
          <textarea
            id="theme-paste"
            className="min-h-40 w-full rounded-md border bg-transparent p-2 font-mono text-xs"
            placeholder=":root { --primary: …; }"
            value={pasted}
            onChange={(e) => setPasted(e.target.value)}
          />
          <div className="flex gap-2">
            <Button size="sm" disabled={!pasted.trim() || update.isPending} onClick={() => save(pasted, 'pasted.css', () => setPasting(false))}>
              <Check aria-hidden="true" />
              Save theme
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setPasting(false)}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      {theme && (
        <div className="space-y-1.5">
          <p className="flex items-center gap-1.5 text-sm">
            <FileCode2 className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            <span className="font-medium">{theme.filename}</span>
            <span className="text-muted-foreground">
              · {formatBytes(theme.size)} · {theme.variables} variables · updated {formatRelative(theme.updatedAt)}
            </span>
          </p>
          <details className="rounded-md border">
            <summary className="cursor-pointer px-2 py-1.5 text-xs font-medium text-muted-foreground">
              What the agent gets ({formatBytes(theme.summary.length)})
            </summary>
            <pre className="max-h-72 overflow-auto border-t bg-muted/40 p-2 font-mono text-xs whitespace-pre-wrap">{theme.summary}</pre>
          </details>
        </div>
      )}
    </section>
  );
}
