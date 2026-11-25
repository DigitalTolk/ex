import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
import { harnessHasModelList, useAgentModels } from '@/hooks/useAgentModels';

// AgentModelSelect is an agent's model field: a dropdown of the models an
// admin offers for the engine (Claude Code: Claude models; Bedrock: Claude in
// the EU), or free text for Codex, which has no list. "" is the first choice,
// named by `emptyLabel` (inherit the default, or the engine's own default). A
// saved model that is no longer offered still shows, marked, so opening the
// form never silently changes it.
export function AgentModelSelect({
  id,
  harness,
  value,
  onChange,
  emptyLabel,
  placeholder,
  className,
}: {
  id: string;
  harness: string;
  value: string;
  onChange: (model: string) => void;
  emptyLabel: string;
  // Codex's free-text field only.
  placeholder?: string;
  className?: string;
}) {
  const all = useAgentModels();
  if (!harnessHasModelList(harness)) {
    return (
      <Input
        id={id}
        className={className}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
      />
    );
  }
  const offered = all.filter((m) => m.harness === harness);
  const retired = value !== '' && !offered.some((m) => m.id === value);
  return (
    <NativeSelect
      id={id}
      className={className}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      data-testid={`${id}-select`}
    >
      <option value="">{emptyLabel}</option>
      {offered.map((m) => (
        <option key={m.id} value={m.id}>
          {m.label || m.id}
        </option>
      ))}
      {retired && <option value={value}>{value} (no longer offered)</option>}
    </NativeSelect>
  );
}
