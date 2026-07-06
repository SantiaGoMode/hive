import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('../index.css', import.meta.url), 'utf8');

describe('light theme CSS overrides', () => {
  it('remaps dark translucent panel backgrounds used across tabs', () => {
    expect(css).toContain('html.light .bg-gray-950\\/40');
    expect(css).toContain('html.light .bg-gray-950\\/50');
    expect(css).toContain('html.light .bg-gray-900\\/30');
    expect(css).toContain('html.light .bg-gray-800\\/30');
    expect(css).toContain('html.light .bg-\\[\\#0f1117\\]\\/60');
  });

  it('remaps the lightest gray text token for dark-first components', () => {
    expect(css).toContain('html.light .text-gray-50');
  });
});
