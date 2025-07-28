import fetch from 'node-fetch';
import fs from 'fs';

const settingsPath = './smsSettings.json';

function getSMSConfig() {
  if (!fs.existsSync(settingsPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  } catch {
    return null;
  }
}

export async function sendSMS(message, configOrToOverride = null) {
  let config = null;
  let toOverride = null;
  // Support both (message, config) and (message, toOverride) signatures
  if (configOrToOverride && typeof configOrToOverride === 'object' && configOrToOverride.apiKey) {
    config = configOrToOverride;
  } else {
    config = getSMSConfig();
    toOverride = configOrToOverride;
  }
  if (!config || !config.apiKey || !config.sender || !(config.recipient || toOverride)) {
    throw new Error('SMS config missing or incomplete.');
  }
  const recipient = toOverride || config.recipient;
  // Build the correct provider URL
  const params = new URLSearchParams({
    key: config.apiKey,
    to: recipient,
    msg: message,
    sender_id: config.sender
  });
  const url = `http://sms.smsnotifygh.com/smsapi?${params.toString()}`;
  let res, text;
  try {
    res = await fetch(url, { method: 'GET' });
    text = await res.text();
    console.log('[SMS] Raw response:', text);
    // Parse response code
    const code = text.match(/\d{4}/)?.[0];
    let result = { code, raw: text };
    switch (code) {
      case '1000':
        result.success = true;
        result.message = 'Message submitted successfully';
        break;
      case '1002':
        result.success = false;
        result.message = 'SMS sending failed';
        break;
      case '1003':
        result.success = false;
        result.message = 'Insufficient balance';
        break;
      case '1004':
        result.success = false;
        result.message = 'Invalid API key';
        break;
      case '1005':
        result.success = false;
        result.message = 'Invalid phone number';
        break;
      case '1006':
        result.success = false;
        result.message = 'Invalid Sender ID';
        break;
      case '1007':
        result.success = true;
        result.message = 'Message scheduled for later delivery';
        break;
      case '1008':
        result.success = false;
        result.message = 'Empty message';
        break;
      default:
        result.success = false;
        result.message = 'Unknown response: ' + text;
    }
    if (!result.success) throw new Error('SMS sending failed: ' + result.message);
    return result;
  } catch (err) {
    console.error('[SMS] sendSMS error:', err);
    throw err;
  }
}
