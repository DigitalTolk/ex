import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { useCreateCategory, useDeleteCategory } from '@/hooks/useSidebar';

// SidebarAddCategory is the "+ Add category" button, which turns into the
// name field in place: Enter creates the category, Escape cancels.
export function SidebarAddCategory() {
  const createCategory = useCreateCategory();
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [error, setError] = useState('');

  if (!creating) {
    return (
      <button
        onClick={() => {
          setError('');
          setCreating(true);
        }}
        data-testid="sidebar-add-category"
        className="mb-1 w-full truncate whitespace-nowrap rounded-md px-2 py-1 text-left text-sm text-gray-500 hover:bg-white/5 hover:text-gray-300 mobile:h-12 mobile:px-3 mobile:py-0 mobile:text-base"
      >
        + Add category
      </button>
    );
  }

  return (
    // Same box as the "+ Add category" button it replaces, so opening it
    // doesn't shift the list below.
    <div className="relative mb-1">
      <input
        autoFocus
        value={name}
        readOnly={createCategory.isPending}
        aria-busy={createCategory.isPending}
        onChange={(e) => {
          setName(e.target.value);
          setError('');
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            const trimmed = name.trim();
            // One create per name: a second Enter while saving is ignored.
            if (!trimmed || createCategory.isPending) return;
            createCategory.mutate(trimmed, {
              onSuccess: () => {
                setName('');
                setCreating(false);
                setError('');
              },
              onError: (err) => {
                setError(err instanceof Error ? err.message : 'Could not create category');
              },
            });
          }
          if (e.key === 'Escape') {
            e.preventDefault();
            setCreating(false);
            setError('');
          }
        }}
        placeholder="Category name…"
        data-testid="sidebar-new-category-input"
        className={`w-full rounded-md bg-white/10 px-2 py-1 text-sm text-white placeholder:text-gray-400 focus:outline-none focus:ring-1 focus:ring-white/40 mobile:h-12 mobile:px-3 mobile:py-0 mobile:text-base ${
          createCategory.isPending ? 'pr-20 text-gray-400' : ''
        }`}
      />
      {createCategory.isPending && (
        <span
          data-testid="sidebar-new-category-pending"
          role="status"
          className="pointer-events-none absolute inset-y-0 right-4 flex items-center gap-1 text-xs text-gray-400"
        >
          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
          Creating…
        </span>
      )}
      {error && (
        <p className="mt-1 text-xs text-red-300" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

// DeleteCategoryDialog confirms deleting a category; category null = closed.
// A modal confirm rather than window.confirm, so the prompt fits the rest of
// the app's visual language.
export function DeleteCategoryDialog({
  category,
  onClose,
}: {
  category: { id: string; title: string } | null;
  onClose: () => void;
}) {
  const deleteCategory = useDeleteCategory();
  return (
    <ConfirmDialog
      open={category !== null}
      onOpenChange={(o) => {
        /* v8 ignore next -- controlled dialog (open={category !== null}); onOpenChange only fires with o=false on dismiss, so the o=true arm is unreachable */
        /* istanbul ignore next -- controlled dialog; onOpenChange only fires with o=false on dismiss, so the o=true arm is unreachable */
        if (!o) onClose();
      }}
      title="Delete category?"
      description={
        category
          ? `"${category.title}" will be removed. Channels and DMs in it return to their default sections.`
          : undefined
      }
      confirmLabel="Delete category"
      destructive
      onConfirm={() => {
        /* v8 ignore next -- onConfirm only fires while the dialog is open, i.e. category is non-null; the null arm is unreachable */
        /* istanbul ignore next -- onConfirm only fires while the dialog is open, i.e. category is non-null; the null arm is unreachable */
        if (category) deleteCategory.mutate(category.id);
      }}
      testIDPrefix="delete-category"
    />
  );
}
