const ngrok = require('@ngrok/ngrok');
const { logSwallowed } = require('./logSwallowed');

let currentListener = null;
let currentOptions = null; // { domain, port } the active listener was started with

async function startTunnel({ authtoken, domain, port = 3001 }) {
  if (currentListener) {
    // Reuse only if the requested options match; otherwise restart so the
    // caller doesn't silently get a tunnel to the wrong domain/port.
    if (currentOptions && currentOptions.domain === (domain || null) && currentOptions.port === port) {
      return currentListener.url();
    }
    await stopTunnel();
  }

  if (!authtoken) {
    throw new Error('Ngrok authtoken is required to start the tunnel');
  }

  try {
    const opts = { addr: port, authtoken };
    if (domain) opts.domain = domain;

    currentListener = await ngrok.forward(opts);
    currentOptions = { domain: domain || null, port };
    return currentListener.url();
  } catch (error) {
    currentListener = null;
    currentOptions = null;
    throw new Error(`Failed to start ngrok: ${error.message}`);
  }
}

async function stopTunnel() {
  if (currentListener) {
    try {
      await currentListener.close();
    } catch (e) { logSwallowed('ngrok:closeListener', e); }
    try {
      await ngrok.disconnect();
    } catch (e) { logSwallowed('ngrok:disconnect', e); }
    currentListener = null;
    currentOptions = null;
  }
}

function getTunnelUrl() {
  return currentListener ? currentListener.url() : null;
}

module.exports = {
  startTunnel,
  stopTunnel,
  getTunnelUrl
};
