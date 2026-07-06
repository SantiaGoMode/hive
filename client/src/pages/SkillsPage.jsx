import { useCallback, useEffect, useState } from 'react';
import {
  ChevronDown, ChevronUp, Code, FileText, GraduationCap, ListOrdered, Pencil,
  Plus, Table, Trash2, Wrench,
} from 'lucide-react';
import { api } from '../lib/api';
import { Button } from '../components/ui/Button';
import { Input, Textarea } from '../components/ui/Input';
import { Modal } from '../components/ui/Modal';
import { MarkdownContent } from '../components/MarkdownContent';
import { toast } from '../stores/toastStore';
import { McpServersSection } from '../components/mcp/McpServersSection';

const TEMPLATE_TYPES = [
  { value: 'code', label: 'Code', icon: Code },
  { value: 'table', label: 'Table', icon: Table },
  { value: 'instructions', label: 'Instructions', icon: ListOrdered },
  { value: 'text', label: 'Text', icon: FileText },
];

const templateIcon = (type) => TEMPLATE_TYPES.find(t => t.value === type)?.icon || FileText;

const TEMPLATE_PLACEHOLDERS = {
  code: 'Reusable code snippet or scaffold — e.g. a function skeleton, config block, or test harness the agent should start from.',
  table: 'Table structure to reuse — e.g. a markdown table with the expected columns:\n| Risk | Impact | Mitigation |\n|---|---|---|',
  instructions: 'Step-by-step procedure the agent should follow when applying this skill.',
  text: 'Reusable text block — e.g. a report outline, email format, or boilerplate section.',
};

// ── Template editor (list of code/table/instruction/text blocks) ──────────────

function TemplatesEditor({ templates, onChange }) {
  const add = () => onChange([...templates, { title: '', type: 'code', content: '' }]);
  const update = (i, patch) => onChange(templates.map((t, j) => j === i ? { ...t, ...patch } : t));
  const remove = (i) => onChange(templates.filter((_, j) => j !== i));

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <label className="text-sm font-medium text-gray-300">Templates</label>
        <button
          onClick={add}
          className="flex items-center gap-1 text-xs text-blue-400 hover:text-blue-300 transition-colors"
        >
          <Plus size={11} /> Add template
        </button>
      </div>
      {templates.length === 0 && (
        <p className="text-xs text-gray-600 italic">
          No templates. Templates are reusable blocks — code scaffolds, table structures, step-by-step
          instructions — given verbatim to any agent or staff member with this skill.
        </p>
      )}
      {templates.map((t, i) => (
        <div key={i} className="border border-gray-800 rounded-lg p-3 flex flex-col gap-2 bg-gray-950/40">
          <div className="flex gap-2 items-center">
            <input
              value={t.title}
              onChange={e => update(i, { title: e.target.value })}
              placeholder="Template title — e.g. PR review checklist"
              className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-2 py-1.5 text-xs text-gray-100 focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
            <select
              value={t.type}
              onChange={e => update(i, { type: e.target.value })}
              className="bg-gray-800 border border-gray-700 rounded-lg px-2 py-1.5 text-xs text-gray-100 focus:outline-none focus:ring-1 focus:ring-blue-500"
            >
              {TEMPLATE_TYPES.map(opt => <option key={opt.value} value={opt.value}>{opt.label}</option>)}
            </select>
            <button
              onClick={() => remove(i)}
              className="p-1.5 text-gray-600 hover:text-red-400 rounded-lg hover:bg-red-500/10 transition-colors"
            >
              <Trash2 size={12} />
            </button>
          </div>
          <textarea
            value={t.content}
            onChange={e => update(i, { content: e.target.value })}
            rows={5}
            placeholder={TEMPLATE_PLACEHOLDERS[t.type] || TEMPLATE_PLACEHOLDERS.text}
            className={`w-full bg-gray-900 border border-gray-800 rounded-lg px-2 py-1.5 text-xs text-gray-100 focus:outline-none focus:ring-1 focus:ring-blue-500 resize-y ${t.type === 'code' || t.type === 'table' ? 'font-mono' : ''}`}
          />
        </div>
      ))}
    </div>
  );
}

// ── Skill create/edit modal ───────────────────────────────────────────────────

function SkillModal({ open, skill, onClose, onSave }) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [instructions, setInstructions] = useState('');
  const [templates, setTemplates] = useState([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName(skill?.name || '');
    setDescription(skill?.description || '');
    setInstructions(skill?.instructions || '');
    setTemplates(Array.isArray(skill?.templates) ? skill.templates : []);
  }, [open, skill]);

  if (!open) return null;

  const save = async () => {
    if (!name.trim()) return toast.error('Name is required');
    setSaving(true);
    try {
      await onSave({
        name: name.trim(),
        description: description.trim(),
        instructions,
        templates,
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal open onClose={onClose} title={skill ? `Edit: ${skill.name}` : 'New Skill'} size="xl">
      <p className="text-xs text-gray-500 -mt-2 mb-3">
        A skill's full content — summary, instructions, and templates — is injected into the
        system prompt of every agent or staff member it's assigned to.
      </p>
      <div className="flex flex-col gap-4 overflow-y-auto max-h-[65vh] pr-1">
        <Input label="Name" value={name} onChange={e => setName(e.target.value)} placeholder="e.g. API design review" />
        <div className="flex flex-col gap-1">
          <Input
            label="Summary"
            value={description}
            onChange={e => setDescription(e.target.value)}
            placeholder="One line: what this skill covers"
          />
          <p className="text-xs text-gray-600">Shown in the skill pickers on the Staff page and in the agent editor.</p>
        </div>
        <div className="flex flex-col gap-1">
          <Textarea
            label="Instructions"
            value={instructions}
            onChange={e => setInstructions(e.target.value)}
            rows={12}
            placeholder={'How to apply this skill — methodology, conventions, dos and don\'ts. Markdown supported.\n\ne.g.\n- Always check error paths before the happy path\n- Use the project\'s existing naming conventions\n- Cite the spec section for every decision'}
          />
          <p className="text-xs text-gray-600">The working knowledge of the skill — given to the agent verbatim.</p>
        </div>
        <TemplatesEditor templates={templates} onChange={setTemplates} />
      </div>
      <div className="pt-4 mt-2 border-t border-gray-700 flex justify-end gap-2">
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save'}</Button>
      </div>
    </Modal>
  );
}

// ── Skill row (expandable) ────────────────────────────────────────────────────

function SkillRow({ skill, onEdit, onDelete }) {
  const [expanded, setExpanded] = useState(false);
  const templates = Array.isArray(skill.templates) ? skill.templates : [];

  return (
    <div className="border border-gray-800 rounded-lg overflow-hidden">
      <div className="flex items-center gap-3 px-4 py-3">
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-gray-200">{skill.name}</p>
          <p className="text-xs text-gray-500 truncate">
            {skill.description || 'No summary'}
            {(skill.instructions?.trim() || templates.length > 0) && (
              <span className="text-gray-600">
                {skill.instructions?.trim() ? ' · instructions' : ''}
                {templates.length > 0 ? ` · ${templates.length} template${templates.length === 1 ? '' : 's'}` : ''}
              </span>
            )}
          </p>
        </div>
        <div className="flex items-center gap-1 flex-shrink-0">
          <Button size="icon" variant="ghost" title="Edit" onClick={() => onEdit(skill)}>
            <Pencil size={13} />
          </Button>
          <Button size="icon" variant="ghost" title="Delete" onClick={() => onDelete(skill)}>
            <Trash2 size={13} />
          </Button>
          <Button size="icon" variant="ghost" onClick={() => setExpanded(e => !e)}>
            {expanded ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
          </Button>
        </div>
      </div>
      {expanded && (
        <div className="border-t border-gray-800 px-4 py-3 bg-gray-900/40 flex flex-col gap-3">
          {skill.instructions?.trim() ? (
            <div>
              <p className="text-xs font-medium text-gray-400 mb-1">Instructions</p>
              <div className="text-xs text-gray-400 max-h-48 overflow-y-auto bg-gray-950/50 rounded px-2 py-1.5">
                <MarkdownContent>{skill.instructions}</MarkdownContent>
              </div>
            </div>
          ) : (
            <p className="text-xs text-gray-600 italic">No instructions yet.</p>
          )}
          {templates.length > 0 && (
            <div className="flex flex-col gap-2">
              <p className="text-xs font-medium text-gray-400">Templates</p>
              {templates.map((t, i) => {
                const Icon = templateIcon(t.type);
                return (
                  <div key={i} className="rounded border border-gray-800 bg-gray-950/50 px-2 py-1.5">
                    <p className="text-xs text-gray-300 flex items-center gap-1.5">
                      <Icon size={11} className="text-gray-500" /> {t.title || 'Untitled'}
                      <span className="text-gray-600">({t.type})</span>
                    </p>
                    {t.type === 'code' ? (
                      <pre className="mt-1 text-xs text-gray-500 whitespace-pre-wrap break-words max-h-32 overflow-y-auto font-mono">{t.content}</pre>
                    ) : (
                      <div className="mt-1 text-xs text-gray-500 max-h-32 overflow-y-auto">
                        <MarkdownContent>{t.content}</MarkdownContent>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Skills catalog section ────────────────────────────────────────────────────

function SkillsCatalogSection() {
  const [skills, setSkills] = useState([]);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState(null);
  const [deleting, setDeleting] = useState(null);

  const load = useCallback(() => {
    api.getSkills().then(data => setSkills(data.skills || [])).catch(() => {});
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleSave = async (data) => {
    try {
      if (editing) {
        await api.updateSkill(editing.id, data);
        toast.success('Skill updated');
      } else {
        await api.createSkill(data);
        toast.success('Skill added');
      }
      setModalOpen(false);
      setEditing(null);
      load();
    } catch (e) {
      toast.error(e.message);
    }
  };

  const handleDelete = async () => {
    if (!deleting) return;
    try {
      await api.deleteSkill(deleting.id);
      toast.success('Skill deleted');
      setDeleting(null);
      load();
    } catch (e) {
      toast.error(e.message);
    }
  };

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-6 flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold text-gray-300 flex items-center gap-2">
            <GraduationCap size={15} className="text-blue-400" /> Skills Catalog
          </h2>
          <p className="text-xs text-gray-500 mt-0.5">
            {skills.length === 0
              ? 'Skills bundle instructions and reusable templates, injected into the prompts of assigned agents and staff'
              : `${skills.length} skill${skills.length === 1 ? '' : 's'} defined`}
          </p>
        </div>
        <Button size="sm" onClick={() => { setEditing(null); setModalOpen(true); }}>
          <Plus size={13} /> Add Skill
        </Button>
      </div>

      {skills.length === 0 ? (
        <div className="text-center py-8 border border-dashed border-gray-700 rounded-lg">
          <p className="text-2xl mb-2">🎓</p>
          <p className="text-sm text-gray-400 font-medium">No skills defined yet</p>
          <p className="text-xs text-gray-600 mt-1 max-w-sm mx-auto">
            A skill carries a summary, working instructions, and reusable templates (code, tables, procedures).
            Assign it to agents (in the agent editor) or staff and its full content is injected into their prompt.
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {skills.map(skill => (
            <SkillRow key={skill.id} skill={skill} onEdit={(s) => { setEditing(s); setModalOpen(true); }} onDelete={setDeleting} />
          ))}
        </div>
      )}

      <SkillModal
        open={modalOpen}
        skill={editing}
        onClose={() => { setModalOpen(false); setEditing(null); }}
        onSave={handleSave}
      />

      {deleting && (
        <Modal open onClose={() => setDeleting(null)} title={`Delete skill "${deleting.name}"?`} size="sm">
          <p className="text-sm text-gray-400 mb-4">
            Agents and staff members keep the assignment as a plain-text entry until edited.
          </p>
          <div className="flex gap-2 justify-end">
            <Button variant="secondary" onClick={() => setDeleting(null)}>Cancel</Button>
            <Button variant="danger" onClick={handleDelete}>Delete</Button>
          </div>
        </Modal>
      )}
    </div>
  );
}

// ── Built-in tools section (expandable function lists) ───────────────────────

function BuiltInToolRow({ tool }) {
  const [expanded, setExpanded] = useState(false);
  const functions = tool.functions || [];

  return (
    <div className="border border-gray-800 rounded-lg overflow-hidden">
      <button
        type="button"
        onClick={() => setExpanded(e => !e)}
        className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-gray-800/30 transition-colors"
      >
        <div className="flex-1 min-w-0">
          <p className="text-sm text-gray-200">
            {tool.label}
            <code className="text-xs text-gray-600 bg-gray-800 px-1 rounded ml-2">{tool.value}</code>
            <span className="text-xs text-gray-600 ml-2">{functions.length} function{functions.length === 1 ? '' : 's'}</span>
          </p>
          <p className="text-xs text-gray-500 mt-0.5">{tool.description}</p>
        </div>
        {expanded ? <ChevronUp size={13} className="text-gray-500 flex-shrink-0" /> : <ChevronDown size={13} className="text-gray-500 flex-shrink-0" />}
      </button>
      {expanded && (
        <div className="border-t border-gray-800 px-4 py-3 bg-gray-900/40 flex flex-col gap-1.5">
          {functions.length === 0 && <p className="text-xs text-gray-600 italic">No functions reported.</p>}
          {functions.map(fn => (
            <div key={fn.name} className="rounded border border-gray-800 bg-gray-950/50 px-2 py-1.5">
              <code className="text-xs text-gray-300 font-mono">{fn.name}</code>
              {fn.description && <p className="text-xs text-gray-500 mt-0.5 leading-relaxed line-clamp-2">{fn.description}</p>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function BuiltInToolsSection() {
  const [tools, setTools] = useState([]);

  useEffect(() => {
    api.getToolOptions()
      .then(data => setTools((data.tools || []).filter(t => t.kind === 'builtin')))
      .catch(() => {});
  }, []);

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-6 flex flex-col gap-4">
      <div>
        <h2 className="text-sm font-semibold text-gray-300 flex items-center gap-2">
          <Wrench size={15} className="text-blue-400" /> Built-in Tools
        </h2>
        <p className="text-xs text-gray-500 mt-0.5">Tool groups shipped with Hive — expand to see each group's functions. MCP servers below add more.</p>
      </div>
      <div className="flex flex-col gap-2">
        {tools.map(tool => <BuiltInToolRow key={tool.value} tool={tool} />)}
      </div>
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function SkillsPage() {
  return (
    <div className="flex flex-col gap-6 max-w-3xl">
      <div>
        <h1 className="text-2xl font-bold text-gray-100">Skills &amp; Tools</h1>
        <p className="text-sm text-gray-500 mt-0.5">Manage the skills catalog, built-in tools, and MCP servers</p>
      </div>

      <SkillsCatalogSection />
      <BuiltInToolsSection />
      <McpServersSection />
    </div>
  );
}
