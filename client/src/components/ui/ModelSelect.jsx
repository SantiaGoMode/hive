import { Input, Select } from './Input';
import {
  orderedModelGroups, modelGroupHeading, modelOptionLabel, modelBadge,
} from '../../lib/modelLabels';

// Single source for the model picker (issue #24). Renders one provider-grouped
// <select> (gateway aliases promoted first) so AgentEditor, StaffPage, and any
// future picker share identical grouping, ordering, and labels via modelLabels.
//
// Props:
//   value        full model id (e.g. "anthropic/claude-sonnet-4-6" or "llama3.1:8b")
//   onChange     (modelId) => void
//   groupedModels  { provider: [{ id, name, source }] } from api.getAllModels()
//   label        select label (default "Model")
//   placeholder  text for the empty "" option (default "— Select a model —"; pass null to omit)
//   showBadge    show the parsed badge for the current value beneath the select
//   allowCustom  show an adjacent free-text input for a custom id
//   hint         optional node rendered between the select/badge and the custom input
// Any extra props (disabled, className, ...) pass through to the underlying <Select>.
export function ModelSelect({
  value,
  onChange,
  groupedModels,
  label = 'Model',
  placeholder = '— Select a model —',
  showBadge = false,
  allowCustom = false,
  customLabel = 'Custom model id (optional)',
  customPlaceholder = 'e.g. anthropic/claude-sonnet-4-6 or llama3.1:8b',
  hint = null,
  ...selectProps
}) {
  const groups = orderedModelGroups(groupedModels);
  const badge = showBadge && value ? modelBadge(value) : null;

  return (
    <div className="flex flex-col gap-2">
      <Select label={label} value={value} onChange={e => onChange(e.target.value)} {...selectProps}>
        {placeholder !== null && <option value="">{placeholder}</option>}
        {groups.map(([provider, list]) => (
          <optgroup key={provider} label={modelGroupHeading(provider)}>
            {list.map(m => <option key={m.id} value={m.id}>{modelOptionLabel(m)}</option>)}
          </optgroup>
        ))}
      </Select>

      {badge && (
        <div className="flex items-center gap-2 -mt-1">
          <span className="text-xs text-gray-500">Selected</span>
          <span
            title={badge.title}
            className="max-w-full truncate text-xs bg-gray-800 border border-gray-700 text-gray-300 rounded px-2 py-1"
          >
            {badge.text}
          </span>
        </div>
      )}

      {hint}

      {allowCustom && (
        <Input
          label={customLabel}
          value={value}
          onChange={e => onChange(e.target.value)}
          placeholder={customPlaceholder}
        />
      )}
    </div>
  );
}
