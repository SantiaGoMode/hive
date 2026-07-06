// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { MarkdownContent } from './MarkdownContent';

describe('MarkdownContent', () => {
  afterEach(() => cleanup());

  it('renders structured agent output with visible list indentation and section spacing', () => {
    const { container } = render(
      <MarkdownContent>{`### Current Status

* **Total Impact:** active fires
* **Warnings:**
  * Red flag conditions

1. **Aspen Acres Fire:**
   * Area burned: 49,291 acres`}</MarkdownContent>,
    );

    expect(container.querySelector('h3')?.className).toContain('mt-3');
    expect(container.querySelector('h3')?.className).toContain('text-slate-950');
    expect(container.querySelector('h3')?.className).toContain('dark:text-gray-50');
    expect(container.querySelector('ul')?.className).toContain('list-disc');
    expect(container.querySelector('ul')?.className).toContain('pl-5');
    expect(container.querySelector('ol')?.className).toContain('list-decimal');
    expect(container.querySelector('ol')?.className).toContain('pl-5');
    expect(container.querySelector('li')?.className).toContain('leading-relaxed');
    expect(container.querySelector('strong')?.className).toContain('text-slate-950');
  });

  it('renders inline code as inline <code>, not a block', () => {
    // react-markdown v10 dropped the `inline` prop; a regression here rendered
    // every inline backtick as a full-width <pre> block inside the paragraph.
    const { container } = render(<MarkdownContent>{'Use the `foo()` helper.'}</MarkdownContent>);
    expect(container.querySelector('pre')).toBeNull();
    const code = container.querySelector('p code');
    expect(code?.textContent).toBe('foo()');
    expect(code?.className).toContain('px-1');
  });

  it('renders a fenced code block as a single non-nested <pre>', () => {
    const { container } = render(<MarkdownContent>{'```js\nconst x = 1;\n```'}</MarkdownContent>);
    const pres = container.querySelectorAll('pre');
    expect(pres.length).toBe(1);
    expect(pres[0].querySelector('pre')).toBeNull();
    expect(container.querySelector('pre code')?.textContent).toContain('const x = 1;');
  });

  it('renders GFM tables (remark-gfm wired)', () => {
    const { container } = render(
      <MarkdownContent>{'| a | b |\n| - | - |\n| 1 | 2 |'}</MarkdownContent>,
    );
    expect(container.querySelector('table')).not.toBeNull();
    expect(container.querySelectorAll('th').length).toBe(2);
    expect(container.querySelectorAll('td').length).toBe(2);
  });
});
