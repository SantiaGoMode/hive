const RELEASE_API = 'https://api.github.com/repos/SantiaGoMode/hive/releases/latest';
const RELEASES_URL = 'https://github.com/SantiaGoMode/hive/releases';

const platformName = document.querySelector('#detected-platform');
const loading = document.querySelector('#download-loading');
const recommendation = document.querySelector('#download-recommendation');
const message = document.querySelector('#download-message');
const messageTitle = document.querySelector('#download-message-title');
const messageCopy = document.querySelector('#download-message-copy');
const title = document.querySelector('#download-title');
const description = document.querySelector('#download-description');
const primary = document.querySelector('#download-primary');
const releaseLink = document.querySelector('#download-release-link');
const filename = document.querySelector('#download-filename');
const osSelect = document.querySelector('#download-os');
const archSelect = document.querySelector('#download-arch');
const choice = document.querySelector('#download-choice');

const labels = {
  mac: 'macOS',
  linux: 'Linux',
  windows: 'Windows',
  arm64: 'ARM64',
  x64: 'x64',
};

function detectOs() {
  const hint = navigator.userAgentData?.platform || navigator.platform || '';
  const value = `${hint} ${navigator.userAgent}`.toLowerCase();
  if (value.includes('win')) return 'windows';
  if (value.includes('mac')) return 'mac';
  if (value.includes('linux') || value.includes('x11')) return 'linux';
  return null;
}

async function detectArchitecture() {
  try {
    if (navigator.userAgentData?.getHighEntropyValues) {
      const values = await navigator.userAgentData.getHighEntropyValues(['architecture', 'bitness']);
      const architecture = String(values.architecture || '').toLowerCase();
      if (architecture.includes('arm')) return 'arm64';
      if (architecture.includes('x86') || architecture.includes('x64')) return 'x64';
    }
  } catch {
    // Some browsers deliberately withhold high-entropy platform details.
  }

  const value = `${navigator.platform || ''} ${navigator.userAgent}`.toLowerCase();
  if (/(arm64|aarch64)/.test(value)) return 'arm64';
  if (/(x86_64|x64|win64|amd64)/.test(value)) return 'x64';
  return null;
}

function assetFor(assets, os, arch) {
  if (os === 'mac' && arch === 'arm64') {
    return assets.find((asset) => /arm64\.dmg$/i.test(asset.name));
  }
  if (os === 'mac' && arch === 'x64') {
    return assets.find((asset) => /^Hive-[\d.]+\.dmg$/i.test(asset.name));
  }
  if (os === 'linux' && arch === 'arm64') {
    return assets.find((asset) => /_arm64\.deb$/i.test(asset.name));
  }
  if (os === 'linux' && arch === 'x64') {
    return assets.find((asset) => /_amd64\.deb$/i.test(asset.name));
  }
  return null;
}

function hideLoading() {
  loading.hidden = true;
}

function showMessage(heading, copy) {
  hideLoading();
  recommendation.hidden = true;
  messageTitle.textContent = heading;
  messageCopy.textContent = copy;
  message.hidden = false;
}

function showRecommendation(release, asset, os, arch) {
  hideLoading();
  message.hidden = true;
  title.textContent = `Hive ${release.tag_name} for ${labels[os]}`;
  description.textContent = `${labels[arch]} installer · ${labels[os]}`;
  primary.href = asset.browser_download_url;
  primary.setAttribute('download', asset.name);
  releaseLink.href = release.html_url;
  filename.textContent = asset.name;
  recommendation.hidden = false;
}

function renderChoice(release, os, arch) {
  const asset = assetFor(release.assets, os, arch);
  if (os === 'windows') {
    choice.innerHTML = `
      <div class="download-choice-card unavailable">
        <span>Windows</span>
        <h3>No Windows installer yet</h3>
        <p>The current Hive desktop release supports macOS and Debian-based Linux. Follow the project for Windows availability.</p>
        <a class="button button-secondary" href="${release.html_url}">View ${release.tag_name} on GitHub <span>↗</span></a>
      </div>`;
    return;
  }
  if (!asset) {
    choice.innerHTML = `
      <div class="download-choice-card unavailable">
        <span>${labels[os]} · ${labels[arch]}</span>
        <h3>No compatible asset found</h3>
        <p>The latest release does not include this combination. Review all assets on GitHub.</p>
        <a class="button button-secondary" href="${release.html_url}">View release assets <span>↗</span></a>
      </div>`;
    return;
  }

  choice.innerHTML = `
    <div class="download-choice-card">
      <span>${labels[os]} · ${labels[arch]}</span>
      <h3>Hive ${release.tag_name}</h3>
      <p>${asset.name}</p>
      <a class="button button-primary" href="${asset.browser_download_url}" download="${asset.name}">Download installer <span>↓</span></a>
    </div>`;
}

async function initDownloads() {
  const os = detectOs();
  const arch = await detectArchitecture();

  if (os) {
    platformName.textContent = labels[os];
    osSelect.value = os;
  }
  if (arch) archSelect.value = arch;

  try {
    const response = await fetch(RELEASE_API, {
      headers: { Accept: 'application/vnd.github+json' },
    });
    if (!response.ok) throw new Error(`GitHub returned ${response.status}`);
    const release = await response.json();
    releaseLink.href = release.html_url;

    const selectedOs = os || osSelect.value;
    const selectedArch = arch || archSelect.value;
    renderChoice(release, selectedOs, selectedArch);

    if (!os) {
      showMessage('Choose your operating system', 'Your browser did not expose enough platform information for a safe recommendation.');
    } else if (os === 'windows') {
      showMessage('Windows build not yet available', 'The latest Hive desktop release currently supports macOS and Debian-based Linux.');
    } else if (!arch && os === 'mac') {
      showMessage('Choose your Mac processor', 'Browsers often hide whether a Mac uses Apple silicon or Intel. Select your processor below for the compatible installer.');
    } else {
      const asset = assetFor(release.assets, os, selectedArch);
      if (asset) {
        showRecommendation(release, asset, os, selectedArch);
      } else {
        showMessage('No compatible installer found', `Hive ${release.tag_name} does not include a ${labels[selectedArch]} build for ${labels[os]}.`);
      }
    }

    osSelect.addEventListener('change', () => {
      const isWindows = osSelect.value === 'windows';
      archSelect.disabled = isWindows;
      renderChoice(release, osSelect.value, archSelect.value);
    });
    archSelect.addEventListener('change', () => {
      renderChoice(release, osSelect.value, archSelect.value);
    });
    archSelect.disabled = osSelect.value === 'windows';
  } catch {
    showMessage('Latest release lookup unavailable', 'GitHub could not be reached from this browser. Open the releases page to choose the newest installer.');
    choice.innerHTML = `
      <div class="download-choice-card unavailable">
        <span>GitHub Releases</span>
        <h3>Choose the latest installer</h3>
        <p>Use the release asset list to select the package for your operating system and processor.</p>
        <a class="button button-primary" href="${RELEASES_URL}">Open GitHub Releases <span>↗</span></a>
      </div>`;
  }
}

initDownloads();
