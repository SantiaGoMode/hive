// ── Coding guidelines for colony coding roles ────────────────────────────────
// An explicit, AGENTS.md-style ruleset injected into coding roles so agents
// don't reach for exotic libraries, invent patterns, or skip tests. Reflects
// June 2026 guidance: AGENTS.md is the de-facto standard, rules must be
// explicit, pin to the existing stack, forbid unnecessary/outdated deps, and
// require tests + scoped diffs. If the target repo ships its own AGENTS.md /
// CONTRIBUTING.md / .cursorrules, that takes precedence and is prepended.

const fs = require('fs');
const path = require('path');

const CODING_GUIDELINES = `[Coding Guidelines — follow strictly]
1. Use the repository's EXISTING stack, framework, and conventions. Read neighboring files before writing; match their patterns, naming, and structure.
2. Do NOT add new dependencies unless the task truly requires it. Prefer the standard library and packages already in the project's manifest. Never introduce obscure, unmaintained, or trendy libraries to solve something the existing stack already handles.
3. No outdated or deprecated APIs. Prefer current, stable, well-documented approaches.
4. Keep diffs small and scoped to the task. Don't refactor unrelated code, reformat whole files, or rename things gratuitously.
5. Write or update tests for the behavior you change, and run them (or the build/lint) when the sandbox allows. Report what you verified and what you did not.
6. Handle errors explicitly; don't swallow failures. Follow the project's existing error-handling pattern.
7. Don't fabricate file paths, APIs, or results. If you can't verify something, say so.
8. NEVER hand-write pinned dependency versions from memory — you WILL invent versions
   that don't exist (e.g. "@types/next@13.1.4"; that package is deprecated — Next.js
   ships its own types). Add dependencies by RUNNING "npm install <pkg>" (or the
   stack's equivalent) so the registry resolves a real version into the manifest.
9. When an install/build fails with ETARGET / E404 / "no matching version", the named
   package or version does not exist — REMOVE or correct that dependency and re-run.
   Do not retry the same command unchanged, and do not pin a different guessed version.
10. SANDBOX CONSTRAINTS: the sandbox ships Node.js 20 and Python 3.11 with NO sudo,
   nvm, apt, or docker. Never attempt to install system packages or switch runtimes —
   work within the installed versions. If a tool genuinely requires a newer runtime,
   report it as a blocker instead of faking the upgrade.
11. A failed command (non-zero exit, "command not found", "No such file") means the
   thing DID NOT HAPPEN. Never report it as done, and never let a downstream summary
   claim it. Report the failure honestly.
12. DEPENDENCY INSTALL RECOVERY (this is safe — do it, don't stall):
   * "npm error code ERESOLVE" / "unable to resolve dependency tree" is a peer-dependency
     conflict, NOT a network or access problem. Re-run once as
     "npm install --legacy-peer-deps" (or "--force" as a last resort). This is allowed;
     only "npm audit fix --force" is banned.
   * Never run a project scaffolder (create-next-app, create-react-app, vite create, etc.)
     in a non-empty repository — it errors on existing files. The repo already exists:
     add the specific dependencies/config the work item needs instead of scaffolding.
   * A bare timeout on an install means it needs longer — re-run with a higher
     timeout_seconds (up to 600), don't abandon it.
13. If a project AGENTS.md / CONTRIBUTING.md is provided below, it OVERRIDES these defaults wherever they conflict.`;

const REPO_GUIDELINE_FILES = ['AGENTS.md', 'CONTRIBUTING.md', '.cursorrules', '.github/copilot-instructions.md'];
const MAX_REPO_GUIDELINE_CHARS = 6000;

function codingGuidelinesBlock() {
  return `\n\n---\n${CODING_GUIDELINES}\n---`;
}

// Read a repo's own agent/contribution guidelines, if present. Returns a prompt
// block (possibly empty). Safe against missing paths and oversized files.
function readRepoGuidelines(repoPath) {
  if (!repoPath) return '';
  for (const rel of REPO_GUIDELINE_FILES) {
    try {
      const p = path.join(repoPath, rel);
      if (fs.existsSync(p) && fs.statSync(p).isFile()) {
        let text = fs.readFileSync(p, 'utf8').trim();
        if (!text) continue;
        if (text.length > MAX_REPO_GUIDELINE_CHARS) {
          text = text.slice(0, MAX_REPO_GUIDELINE_CHARS) + '\n…(truncated)';
        }
        return `\n\n---\n[Project ${rel} — authoritative; overrides defaults on conflict]\n${text}\n---`;
      }
    } catch {
      // ignore unreadable file, try the next
    }
  }
  return '';
}

module.exports = { CODING_GUIDELINES, codingGuidelinesBlock, readRepoGuidelines, REPO_GUIDELINE_FILES };
