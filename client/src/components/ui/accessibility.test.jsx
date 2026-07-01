import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { Button } from './Button';
import { Input, Select, Textarea } from './Input';
import { Modal } from './Modal';

describe('shared UI accessibility primitives', () => {
  it('renders semantic modal dialog attributes and a labelled close button', () => {
    const html = renderToStaticMarkup(
      <Modal open title="Delete agent" onClose={() => {}}>
        <button type="button">Confirm</button>
      </Modal>,
    );

    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toMatch(/aria-labelledby="[^"]+"/);
    expect(html).toContain('aria-label="Close dialog"');
    expect(html).toContain('title="Close dialog"');
  });

  it('connects input labels, errors, and described-by metadata', () => {
    const html = renderToStaticMarkup(
      <Input id="agent-name" label="Agent name" error="Name is required" value="" readOnly />,
    );

    expect(html).toContain('<label for="agent-name"');
    expect(html).toContain('id="agent-name"');
    expect(html).toContain('aria-invalid="true"');
    expect(html).toContain('aria-describedby="agent-name-error"');
    expect(html).toContain('id="agent-name-error"');
  });

  it('connects textarea and select labels to their controls', () => {
    const html = renderToStaticMarkup(
      <>
        <Textarea id="prompt" label="Prompt" value="" readOnly />
        <Select id="model" label="Model" value="a" readOnly>
          <option value="a">Model A</option>
        </Select>
      </>,
    );

    expect(html).toContain('<label for="prompt"');
    expect(html).toContain('<textarea');
    expect(html).toContain('id="prompt"');
    expect(html).toContain('<label for="model"');
    expect(html).toContain('<select');
    expect(html).toContain('id="model"');
  });

  it('uses title text as an aria-label fallback for icon buttons', () => {
    const html = renderToStaticMarkup(
      <Button size="icon" title="Refresh">
        <span aria-hidden="true">R</span>
      </Button>,
    );

    expect(html).toContain('title="Refresh"');
    expect(html).toContain('aria-label="Refresh"');
  });
});
