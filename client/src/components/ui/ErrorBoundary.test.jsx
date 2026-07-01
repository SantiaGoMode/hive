// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ErrorBoundary } from './ErrorBoundary';

function Boom({ explode }) {
  if (explode) throw new Error('kaboom');
  return <p>all good</p>;
}

function renderWithRouter(ui) {
  return render(<MemoryRouter>{ui}</MemoryRouter>);
}

describe('ErrorBoundary', () => {
  beforeEach(() => {
    // componentDidCatch logs the error; keep test output clean.
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    cleanup(); // vitest runs without globals:true, so auto-cleanup never registers
    vi.restoreAllMocks();
  });

  it('renders children when nothing throws', () => {
    renderWithRouter(
      <ErrorBoundary>
        <Boom explode={false} />
      </ErrorBoundary>,
    );
    expect(screen.getByText('all good')).toBeTruthy();
  });

  it('shows the fallback when a child render throws', () => {
    renderWithRouter(
      <ErrorBoundary>
        <Boom explode />
      </ErrorBoundary>,
    );
    expect(screen.getByText('Something went wrong')).toBeTruthy();
    expect(screen.getByRole('button', { name: /try again/i })).toBeTruthy();
  });

  it('recovers via the "Try again" button', () => {
    let explode = true;
    function MaybeBoom() {
      if (explode) throw new Error('kaboom');
      return <p>recovered</p>;
    }
    renderWithRouter(
      <ErrorBoundary>
        <MaybeBoom />
      </ErrorBoundary>,
    );
    expect(screen.getByText('Something went wrong')).toBeTruthy();

    explode = false;
    fireEvent.click(screen.getByRole('button', { name: /try again/i }));
    expect(screen.getByText('recovered')).toBeTruthy();
  });
});
