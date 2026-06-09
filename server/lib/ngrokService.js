const ngrok = require('@ngrok/ngrok');

let currentListener = null;

async function startTunnel({ authtoken, domain, port = 3001 }) {
  if (currentListener) {
    return currentListener.url();
  }

  if (!authtoken) {
    throw new Error('Ngrok authtoken is required to start the tunnel');
  }

  try {
    const opts = { addr: port, authtoken };
    if (domain) opts.domain = domain;
    
    currentListener = await ngrok.forward(opts);
    return currentListener.url();
  } catch (error) {
    currentListener = null;
    throw new Error(`Failed to start ngrok: ${error.message}`);
  }
}

async function stopTunnel() {
  if (currentListener) {
    try {
      await currentListener.close();
    } catch (e) {}
    try {
      await ngrok.disconnect();
    } catch (e) {}
    currentListener = null;
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
