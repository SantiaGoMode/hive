import { describe, it, expect } from 'vitest';
import { ErrorBoundary } from './ErrorBoundary';

// vitest here runs in the default node environment (no jsdom), so we can't do a
// full render test. This is a lightweight smoke test: it confirms the module
// imports cleanly and exposes the expected component.
describe('ErrorBoundary', () => {
  it('exports a component', () => {
    expect(typeof ErrorBoundary).toBe('function');
  });
});
