const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  artifactName, checksumFor, compareVersions, selectArtifact, selectRelease,
} = require('../../desktop/updatePolicy');

describe('desktop update policy', () => {
  it('compares stable and prerelease semantic versions without offering downgrades', () => {
    assert.equal(compareVersions('1.1.0', '1.0.9'), 1);
    assert.equal(compareVersions('1.0.0', '1.0.0'), 0);
    assert.equal(compareVersions('1.0.0-beta.2', '1.0.0'), -1);
    assert.equal(compareVersions('1.0.0', '1.0.0-beta.2'), 1);
  });

  it('keeps stable and beta channels explicit', () => {
    const releases = [
      { tag_name: 'v1.1.0-beta.1', prerelease: true, draft: false },
      { tag_name: 'v1.0.1', prerelease: false, draft: false },
      { tag_name: 'v1.0.2', prerelease: false, draft: true },
    ];
    assert.equal(selectRelease(releases, 'stable').tag_name, 'v1.0.1');
    assert.equal(selectRelease(releases, 'beta').tag_name, 'v1.1.0-beta.1');
  });

  it('selects only the exact platform artifact and authenticates its checksum line', () => {
    const name = artifactName('1.2.3', 'darwin', 'arm64');
    const release = { tag_name: 'v1.2.3', assets: [{ name, browser_download_url: 'https://example.invalid/Hive.dmg' }] };
    assert.equal(selectArtifact(release, 'darwin', 'arm64').name, 'Hive-1.2.3-arm64.dmg');
    const hash = 'a'.repeat(64);
    assert.equal(checksumFor(`${hash}  ${name}\n`, name), hash);
    assert.equal(checksumFor(`${hash}  Hive-1.2.3.dmg\n`, name), null);
  });
});
