function versionParts(version) {
  const match = String(version || '').replace(/^v/, '').match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/);
  return match ? { numbers: match.slice(1, 4).map(Number), prerelease: match[4] || '' } : null;
}

function compareVersions(left, right) {
  const a = versionParts(left);
  const b = versionParts(right);
  if (!a || !b) return 0;
  for (let i = 0; i < 3; i++) {
    if (a.numbers[i] !== b.numbers[i]) return a.numbers[i] > b.numbers[i] ? 1 : -1;
  }
  if (a.prerelease === b.prerelease) return 0;
  if (!a.prerelease) return 1;
  if (!b.prerelease) return -1;
  return a.prerelease.localeCompare(b.prerelease, undefined, { numeric: true });
}

function selectRelease(releases, channel = 'stable') {
  return (Array.isArray(releases) ? releases : [releases])
    .filter(release => release && !release.draft && (channel === 'beta' ? release.prerelease : !release.prerelease))
    .sort((a, b) => compareVersions(b.tag_name, a.tag_name))[0] || null;
}

function artifactName(version, platform, arch) {
  if (platform === 'darwin') return arch === 'arm64' ? `Hive-${version}-arm64.dmg` : `Hive-${version}.dmg`;
  if (platform === 'linux') return `Hive-${version}.AppImage`;
  return null;
}

function selectArtifact(release, platform, arch) {
  const version = String(release?.tag_name || '').replace(/^v/, '');
  const expected = artifactName(version, platform, arch);
  return expected ? release.assets?.find(asset => asset.name === expected) || null : null;
}

function checksumFor(manifest, artifact) {
  const escaped = String(artifact || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = String(manifest || '').match(new RegExp(`^([a-f0-9]{64})\\s+\\*?${escaped}$`, 'im'));
  return match?.[1]?.toLowerCase() || null;
}

module.exports = { artifactName, checksumFor, compareVersions, selectArtifact, selectRelease, versionParts };
